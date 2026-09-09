import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSkillsCli, skillDestination, SKILL_CLIENTS } from "./cli.js";
import { SKILL_NAMES } from "./install.js";

const CLIENT_PATHS = [
  ["agents", ".agents/skills", ".agents/skills"],
  ["codex", ".agents/skills", ".agents/skills"],
  ["claude", ".claude/skills", ".claude/skills"],
  ["cursor", ".cursor/skills", ".cursor/skills"],
  ["copilot", ".github/skills", ".copilot/skills"],
  ["vscode", ".github/skills", ".copilot/skills"],
  ["gemini", ".gemini/skills", ".gemini/skills"],
  ["opencode", ".opencode/skills", ".config/opencode/skills"],
] as const;

describe("portable skills CLI boundary", () => {
  let root: string;
  let cwd: string;
  let home: string;
  let sourceRoot: string;
  const context = () => ({ cwd, home, sourceRoot });

  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), "mtg-skills-cli-")));
    cwd = path.join(root, "project with spaces");
    home = path.join(root, "home with spaces");
    sourceRoot = path.join(root, "package with spaces", "skills");
    await mkdir(cwd);
    await mkdir(home);
    for (const name of SKILL_NAMES) {
      await mkdir(path.join(sourceRoot, name), { recursive: true });
      await writeFile(
        path.join(sourceRoot, name, "SKILL.md"),
        `---\nname: ${name}\ndescription: Portable test fixture.\n---\n\n# ${name}\n`,
      );
    }
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("resolves every documented preset separately for project and user scope", () => {
    expect(Object.keys(SKILL_CLIENTS).sort()).toEqual(
      CLIENT_PATHS.map(([client]) => client).sort(),
    );
    for (const [client, projectPath, userPath] of CLIENT_PATHS) {
      expect(skillDestination({ client }, { cwd, home })).toBe(path.join(cwd, projectPath));
      expect(skillDestination({ client, scope: "user" }, { cwd, home })).toBe(
        path.join(home, userPath),
      );
    }
  });

  it("resolves a chosen project root and explicit destination relative to the caller", () => {
    expect(skillDestination({ client: "codex", projectRoot: "other project" }, { cwd, home })).toBe(
      path.join(cwd, "other project", ".agents", "skills"),
    );
    expect(skillDestination({ destination: "custom skills" }, { cwd, home })).toBe(
      path.join(cwd, "custom skills"),
    );
    expect(
      skillDestination({ destination: path.join(root, "absolute skills") }, { cwd, home }),
    ).toBe(path.join(root, "absolute skills"));
  });

  it.each([
    {},
    { client: "unknown" },
    { client: "__proto__" },
    { client: "constructor" },
    { client: "codex", scope: "global" },
    { client: "codex", scope: "user", projectRoot: "elsewhere" },
    { client: "codex", projectRoot: " " },
    { destination: " " },
    { destination: "skills", client: "codex" },
    { destination: "skills", scope: "project" },
    { destination: "skills", projectRoot: "elsewhere" },
  ])("rejects ambiguous or unsafe destination choice %j", (options) => {
    expect(() => skillDestination(options, { cwd, home })).toThrow();
  });

  it.each(
    [[], ["--help"], ["list"], ["install", "--dest", "custom skills", "--apply", "--help"]].map(
      (args) => ({ args }),
    ),
  )(
    "serves read-only help or discovery for %j without reading a source package",
    async ({ args }) => {
      const result = await runSkillsCli(args, {
        cwd,
        home,
        sourceRoot: path.join(root, "missing-package"),
      });
      expect(result.exitCode).toBe(0);
      expect(result.output.length).toBeGreaterThan(0);
      if (args[0] === "list") {
        const data: unknown = JSON.parse(result.output);
        expect(data).toMatchObject({ skills: SKILL_NAMES, clients: SKILL_CLIENTS });
      }
      expect(await readdir(cwd)).toEqual([]);
      expect(await readdir(home)).toEqual([]);
    },
  );

  it.each(
    [
      ["install"],
      ["install", "--apply"],
      ["install", "--client"],
      ["install", "--client", "--apply"],
      ["install", "--dest", " "],
      ["install", "--dest", "skills", "--force"],
      ["install", "--dest", "skills", "--dest", "other", "--apply"],
      ["install", "--dest", "skills", "--apply", "--apply"],
      ["install", "--dest", "skills", "--skill", "../outside", "--apply"],
      ["uninstall", "--dest", "skills", "--update", "--apply"],
    ].map((args) => ({ args })),
  )("rejects malformed or dangerous arguments %j before creating files", async ({ args }) => {
    await expect(runSkillsCli(args, context())).rejects.toThrow();
    expect(await readdir(cwd)).toEqual([]);
    expect(await readdir(home)).toEqual([]);
  });

  it("previews by default, applies repeated skill selections, and reports collisions with exit code one", async () => {
    const args = [
      "install",
      "--dest",
      "chosen skills",
      "--skill",
      "mtg-edh",
      "--skill",
      "mtg-edh-cards",
    ];
    const preview = await runSkillsCli(args, context());
    const previewData: unknown = JSON.parse(preview.output);
    expect(preview).toMatchObject({ exitCode: 0 });
    expect(previewData).toMatchObject({
      destination: path.join(cwd, "chosen skills"),
      mode: "preview",
      status: "ready",
    });
    expect(await readdir(cwd)).toEqual([]);
    const applied = await runSkillsCli([...args, "--apply"], context());
    const appliedData: unknown = JSON.parse(applied.output);
    expect(applied.exitCode).toBe(0);
    expect(appliedData).toMatchObject({ mode: "applied", status: "applied" });
    const target = path.join(cwd, "chosen skills");
    expect((await readdir(target)).sort()).toEqual(["mtg-edh", "mtg-edh-cards"]);
    await mkdir(path.join(target, "mtg-edh-budget"));
    await writeFile(
      path.join(target, "mtg-edh-budget", "SKILL.md"),
      "User-authored budget instructions\n",
    );
    const conflict = await runSkillsCli(
      ["install", "--dest", "chosen skills", "--apply"],
      context(),
    );
    const conflictData: unknown = JSON.parse(conflict.output);
    expect(conflict.exitCode).toBe(1);
    expect(conflictData).toMatchObject({ status: "conflict" });
    expect((await readdir(target)).sort()).toEqual(["mtg-edh", "mtg-edh-budget", "mtg-edh-cards"]);
    expect(await readFile(path.join(target, "mtg-edh-budget", "SKILL.md"), "utf8")).toBe(
      "User-authored budget instructions\n",
    );
  });

  it("applies a user preset to the supplied home without creating project configuration", async () => {
    const result = await runSkillsCli(
      ["install", "--client", "opencode", "--scope", "user", "--skill", "mtg-edh", "--apply"],
      context(),
    );
    expect(result.exitCode).toBe(0);
    expect(await readdir(path.join(home, ".config", "opencode", "skills"))).toEqual(["mtg-edh"]);
    expect(await readdir(cwd)).toEqual([]);
  });
});
