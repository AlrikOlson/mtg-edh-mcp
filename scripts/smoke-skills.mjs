import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(path.join(await realpath(tmpdir()), "mtg-skill-package-"));
try {
  const packed = JSON.parse(
    execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", temporary, "--json"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
    }),
  )[0];
  assert(
    packed.files.some((file) => file.path === "dist/skills.js"),
    "Build first: standalone installer is missing",
  );
  assert(packed.files.some((file) => file.path === "docs/AGENT-SKILLS.md"));
  assert(!packed.files.some((file) => file.path.includes("node_modules/")));
  const extracted = path.join(temporary, "extracted");
  await mkdir(extracted);
  execFileSync("tar", ["-xzf", path.join(temporary, packed.filename), "-C", extracted]);
  const release = path.join(extracted, "package");
  const elsewhere = path.join(temporary, "unrelated working directory");
  await mkdir(elsewhere);
  const destination = path.join(temporary, "user skills");
  const dataRoot = path.join(temporary, "must-not-initialize-data");
  function run(args, expectedExit = 0) {
    try {
      const text = execFileSync(process.execPath, [path.join(release, "dist/skills.js"), ...args], {
        cwd: elsewhere,
        env: {
          ...process.env,
          NODE_PATH: "",
          MCP_DATA_DIR: dataRoot,
          MCP_TRANSPORT: "not-a-transport",
        },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      assert.equal(expectedExit, 0);
      return JSON.parse(text);
    } catch (error) {
      assert.equal(error.status, expectedExit, error.stderr?.toString() ?? error.message);
      assert.notEqual(expectedExit, 0);
      return JSON.parse(error.stdout.toString());
    }
  }
  const listed = run(["list"]);
  assert.equal(listed.skills.length, 5);
  const args = ["install", "--dest", destination];
  assert.equal(run(args).mode, "preview");
  assert(!(await readdir(temporary)).includes("user skills"), "Preview wrote destination");
  const applied = run([...args, "--apply"]);
  assert.equal(applied.status, "applied");
  assert.deepEqual(
    applied.entries.map((entry) => entry.action),
    Array(5).fill("install"),
  );
  async function compareTree(source, copied) {
    const names = await readdir(source, { withFileTypes: true });
    for (const entry of names) {
      const from = path.join(source, entry.name);
      const to = path.join(copied, entry.name);
      if (entry.isDirectory()) await compareTree(from, to);
      else assert.deepEqual(await readFile(to), await readFile(from));
    }
  }
  for (const name of listed.skills) {
    await compareTree(path.join(root, "skills", name), path.join(destination, name));
    assert(
      (await readFile(path.join(destination, name, ".mtg-edh-install.json"), "utf8")).includes(
        '"package": "mtg-edh-mcp"',
      ),
    );
  }
  assert(run([...args, "--apply"]).entries.every((entry) => entry.action === "unchanged"));
  const edited = path.join(destination, "mtg-edh", "SKILL.md");
  const original = await readFile(edited);
  await writeFile(edited, Buffer.concat([original, Buffer.from("\nLocal user note.\n")]));
  const blocked = run(["uninstall", "--dest", destination, "--apply"], 1);
  assert.equal(blocked.status, "conflict");
  assert.equal((await readdir(destination)).length, 5, "Conflict partially removed skills");
  await writeFile(edited, original);
  assert.equal(run(["uninstall", "--dest", destination, "--apply"]).status, "applied");
  assert.deepEqual(await readdir(destination), []);
  assert(!(await readdir(temporary)).includes("must-not-initialize-data"));
  assert(!(await readdir(release)).includes("node_modules"));
  console.log(
    JSON.stringify({
      status: "passed",
      package: packed.filename,
      skills: listed.skills,
      verified: [
        "no installed dependencies",
        "unrelated cwd",
        "preview writes nothing",
        "all skill/reference/license bytes preserved",
        "idempotent repeat",
        "modified installation preserved",
        "managed uninstall",
        "no MCP/data initialization",
      ],
    }),
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
