import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { verifyEngineSource } from "./check-engine-source.mjs";

const exec = promisify(execFile);
const sha = (value) => createHash("sha256").update(value).digest("hex");

async function fixture(t) {
  const source = await mkdtemp(join(tmpdir(), "engine source "));
  t.after(() => rm(source, { recursive: true, force: true }));
  const git = async (...args) =>
    (
      await exec("git", [
        "-C",
        source,
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=" + join(source, ".git", "disabled-hooks"),
        ...args,
      ])
    ).stdout.trim();
  await git("init", "-q");
  await writeFile(join(source, "Cargo.lock"), "# frozen lock\n");
  await writeFile(join(source, ".gitignore"), "target/\n");
  await git("add", ".");
  await git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-qm",
    "fixture",
  );
  return {
    source,
    git,
    pin: {
      revision: await git("rev-parse", "HEAD"),
      cargo_lock_sha256: sha("# frozen lock\n"),
    },
  };
}

test("accepts the exact clean source, including paths with spaces", async (t) => {
  const { source, pin } = await fixture(t);
  const result = await verifyEngineSource(source, pin);
  assert.equal(result.revision, pin.revision);
  assert.equal(result.cargo_lock_sha256, pin.cargo_lock_sha256);
});

test("rejects a different source revision or lock digest", async (t) => {
  const { source, pin } = await fixture(t);
  await assert.rejects(
    verifyEngineSource(source, { ...pin, revision: "0".repeat(40) }),
    /revision/,
  );
  await assert.rejects(
    verifyEngineSource(source, { ...pin, cargo_lock_sha256: "0".repeat(64) }),
    /lock/i,
  );
});

for (const change of ["modified", "staged", "untracked", "ignored"]) {
  test("rejects " + change + " source inputs", async (t) => {
    const { source, pin, git } = await fixture(t);
    if (change === "ignored") {
      await mkdir(join(source, "target"));
      await writeFile(join(source, "target", "extra"), "unexpected");
    } else {
      await writeFile(join(source, change === "untracked" ? "extra" : "Cargo.lock"), "changed");
      if (change === "staged") await git("add", "Cargo.lock");
    }
    await assert.rejects(verifyEngineSource(source, pin), /clean/);
  });
}

test("rejects a nested directory that merely discovers a parent Git repository", async (t) => {
  const { source, pin } = await fixture(t);
  const nested = join(source, "nested");
  await mkdir(nested);
  await assert.rejects(verifyEngineSource(nested, pin), /root/);
});

test("rejects malformed immutable identities", async (t) => {
  const { source, pin } = await fixture(t);
  await assert.rejects(verifyEngineSource(source, { ...pin, revision: "main" }), /revision/);
  await assert.rejects(verifyEngineSource(source, { ...pin, cargo_lock_sha256: "oops" }), /lock/i);
});

for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
  test("rejects tracked-change hiding flag " + flag, async (t) => {
    const { source, pin, git } = await fixture(t);
    await git("update-index", flag, "Cargo.lock");
    await assert.rejects(verifyEngineSource(source, pin), /index.*clean/);
  });
}

test("the committed pin contains immutable portable source identities", async () => {
  const pin = JSON.parse(await readFile(new URL("../engine/source.json", import.meta.url), "utf8"));
  assert.match(pin.revision, /^[0-9a-f]{40}$/);
  assert.match(pin.cargo_lock_sha256, /^[0-9a-f]{64}$/);
  assert.equal(pin.worker_package, "mtg-worker");
  assert.equal(pin.core_package, "mtg-engine");
  assert.equal(pin.worker_manifest, "crates/mtg-worker/Cargo.toml");
  assert.equal(JSON.stringify(pin).includes("/Users/"), false);
});
