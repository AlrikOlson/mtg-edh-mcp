/** Read-only build preflight. This script is never part of gameplay execution. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);

export async function verifyEngineSource(source, pin) {
  assert.match(pin.revision, /^[0-9a-f]{40}$/, "source revision must be an immutable full commit");
  assert.match(pin.cargo_lock_sha256, /^[0-9a-f]{64}$/, "Cargo lock digest must be SHA-256");
  const root = await realpath(source);
  const git = async (...args) =>
    (
      await exec("git", ["-C", root, ...args], {
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
        timeout: 30_000,
        maxBuffer: 8 * 1024 * 1024,
      })
    ).stdout.trim();
  assert.equal(
    await realpath(await git("rev-parse", "--show-toplevel")),
    root,
    "source must be the repository root",
  );
  const revision = await git("rev-parse", "--verify", "HEAD^{commit}");
  assert.equal(revision, pin.revision, "source revision does not match engine/source.json");
  assert.equal(
    await git(
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--ignore-submodules=none",
      "--ignored=matching",
    ),
    "",
    "source must be clean, including untracked and ignored inputs; build outside the checkout",
  );
  const flags = await git("ls-files", "-v");
  assert(
    !flags.split("\n").some((line) => /^[a-zS] /.test(line)),
    "source index must be clean of assume-unchanged/skip-worktree flags",
  );
  const digest = createHash("sha256")
    .update(await readFile(join(root, "Cargo.lock")))
    .digest("hex");
  assert.equal(
    digest,
    pin.cargo_lock_sha256,
    "Cargo lock digest does not match engine/source.json",
  );
  return { revision, cargo_lock_sha256: digest };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    assert.equal(
      process.argv.length,
      3,
      "usage: node scripts/check-engine-source.mjs <clean-engine-checkout>",
    );
    const pin = JSON.parse(
      await readFile(new URL("../engine/source.json", import.meta.url), "utf8"),
    );
    const receipt = await verifyEngineSource(process.argv[2], pin);
    process.stdout.write(JSON.stringify(receipt) + "\n");
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
    process.exitCode = 1;
  }
}
