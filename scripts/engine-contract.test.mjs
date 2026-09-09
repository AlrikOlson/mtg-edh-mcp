import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
const exec = promisify(execFile);
const root = new URL("../", import.meta.url);
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "engine contract drift "));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const manifest = JSON.parse(
    await readFile(new URL("engine/contract/manifest.json", root), "utf8"),
  );
  for (const file of [
    "scripts/engine-contract.mjs",
    "scripts/check-engine-source.mjs",
    "engine/source.json",
    "engine/contract/manifest.json",
    ...Object.keys(manifest.files),
  ]) {
    await mkdir(dirname(join(dir, file)), { recursive: true });
    await copyFile(new URL(file, root), join(dir, file));
  }
  return {
    dir,
    manifest,
    check: () =>
      exec(process.execPath, [join(dir, "scripts/engine-contract.mjs"), "--check"], {
        timeout: 10000,
        maxBuffer: 100000,
      }),
  };
}
test("CI contract check accepts exact committed derivatives", async (t) => {
  const f = await fixture(t);
  assert.match((await f.check()).stdout, /verified/);
});
test("CI contract check rejects a changed derivative hash", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.dir, "src/engine/protocol.generated.ts"), "// drift\n");
  await assert.rejects(f.check(), /contract artifact drift/);
});
test("regeneration rejects changed Rust even if its manifest hash was updated", async (t) => {
  const f = await fixture(t),
    file = "engine/contract/generated.rs";
  const changed = (await readFile(join(f.dir, file), "utf8")) + "// changed output\n";
  await writeFile(join(f.dir, file), changed);
  f.manifest.files[file] = createHash("sha256").update(changed).digest("hex");
  await writeFile(join(f.dir, "engine/contract/manifest.json"), JSON.stringify(f.manifest));
  await assert.rejects(f.check(), /Rust generation drift/);
});
test("contract derivatives cannot silently follow a different engine source pin", async (t) => {
  const f = await fixture(t);
  const file = join(f.dir, "engine/source.json"),
    pin = JSON.parse(await readFile(file, "utf8"));
  pin.revision = "0".repeat(40);
  await writeFile(file, JSON.stringify(pin));
  await assert.rejects(f.check(), /contract source pin drift/);
});
