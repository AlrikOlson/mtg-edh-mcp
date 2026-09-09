/** Build-time contract import/check. Never called by the MCP server. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verifyEngineSource } from "./check-engine-source.mjs";

const root = new URL("../", import.meta.url);
const paths = [
  ["protocol/README.md", "engine/contract/README.md"],
  ["protocol/contract.json", "engine/contract/contract.json"],
  ["protocol/generate.mjs", "engine/contract/generate.mjs"],
  ["protocol/generate.test.mjs", "engine/contract/generate.test.mjs"],
  ["protocol/fixtures.json", "engine/contract/fixtures.json"],
  ["src/generated.rs", "engine/contract/generated.rs"],
  ["protocol/protocol.generated.ts", "src/engine/protocol.generated.ts"],
];
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const pin = JSON.parse(await readFile(new URL("engine/source.json", root), "utf8"));
const [mode, source] = process.argv.slice(2);
assert(
  ["--check", "--sync"].includes(mode),
  "usage: node scripts/engine-contract.mjs --check [source] | --sync <source>",
);
assert(
  process.argv.length <= 4 && (mode !== "--sync" || source),
  "invalid contract command arguments",
);
let sourceRoot;
if (source) {
  sourceRoot = pathToFileURL(resolve(source) + "/");
  await verifyEngineSource(source, pin);
}
const manifestUrl = new URL("engine/contract/manifest.json", root);
if (mode === "--sync") {
  const hashes = {};
  for (const [from, to] of paths) {
    const bytes = await readFile(new URL("crates/mtg-worker/" + from, sourceRoot));
    const destination = new URL(to, root);
    await mkdir(dirname(fileURLToPath(destination)), { recursive: true });
    await writeFile(destination, bytes);
    hashes[to] = sha(bytes);
  }
  await writeFile(
    manifestUrl,
    JSON.stringify({ source_revision: pin.revision, files: hashes }, null, 2) + "\n",
  );
}
const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
assert.equal(manifest.source_revision, pin.revision, "contract source pin drift");
assert.deepEqual(
  Object.keys(manifest.files).sort(),
  paths.map(([, to]) => to).sort(),
  "unexpected contract artifacts",
);
for (const [from, to] of paths) {
  const bytes = await readFile(new URL(to, root));
  assert.equal(sha(bytes), manifest.files[to], "contract artifact drift: " + to);
  if (sourceRoot)
    assert.deepEqual(
      bytes,
      await readFile(new URL("crates/mtg-worker/" + from, sourceRoot)),
      "canonical contract drift: " + to,
    );
}
// Dynamic import is confined to this build command's checked, fixed generator path.
const { render } = await import("../engine/contract/generate.mjs");
const output = render(await readFile(new URL("engine/contract/contract.json", root), "utf8"));
assert.equal(
  await readFile(new URL("engine/contract/generated.rs", root), "utf8"),
  output.rust,
  "Rust generation drift",
);
assert.equal(
  await readFile(new URL("src/engine/protocol.generated.ts", root), "utf8"),
  output.typescript,
  "TypeScript generation drift",
);
process.stdout.write("Canonical worker contract verified\n");
