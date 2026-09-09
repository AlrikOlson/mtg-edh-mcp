import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { manageSkills, SKILL_NAMES } from "./install.js";

export const SKILL_CLIENTS: Record<string, { project: string; user: string }> = {
  agents: { project: ".agents/skills", user: ".agents/skills" },
  codex: { project: ".agents/skills", user: ".agents/skills" },
  claude: { project: ".claude/skills", user: ".claude/skills" },
  cursor: { project: ".cursor/skills", user: ".cursor/skills" },
  copilot: { project: ".github/skills", user: ".copilot/skills" },
  vscode: { project: ".github/skills", user: ".copilot/skills" },
  gemini: { project: ".gemini/skills", user: ".gemini/skills" },
  opencode: { project: ".opencode/skills", user: ".config/opencode/skills" },
};

export const SKILLS_HELP = `mtg-edh-mcp skills — portable, offline Agent Skills

Usage: mtg-edh-mcp skills list
       mtg-edh-mcp skills install --client <client> [--scope project|user] [--apply]
       mtg-edh-mcp skills uninstall --client <client> [--scope project|user] [--apply]
       mtg-edh-mcp skills install --dest <skills-directory> [--apply]

Clients: agents, codex, claude, cursor, copilot, vscode, gemini, opencode
  --scope project|user    Default: project. One destination per invocation.
  --project-root <path>  Project root (default: current directory).
  --dest <path>          Explicit destination instead of client/scope.
  --skill <name>         Install/remove only this skill; repeat to select more.
  --update               Replace only a pristine managed installation.
  --apply                Apply the displayed plan. Without it, write nothing.
  -h, --help             Show this help.

Installation copies bundled Markdown only. No network, hooks, dependency installs,
MCP configuration or permission changes. Existing unmanaged or edited skills cause
the entire selection to be refused; there is no force flag. Uninstall removes only
unchanged files managed by this installer. Review skills before activating them.
Restart/reload the host to refresh discovery; an MCP connection is still required.
See docs/AGENT-SKILLS.md for verified client paths and manual loading.
`;

interface ParsedOptions {
  operation: "install" | "uninstall";
  client?: string;
  scope?: string;
  projectRoot?: string;
  destination?: string;
  skills?: string[];
  apply: boolean;
  update: boolean;
}
export function skillDestination(
  options: Pick<ParsedOptions, "client" | "scope" | "projectRoot" | "destination">,
  context: { cwd: string; home: string },
): string {
  if (options.destination !== undefined) {
    if (options.client || options.scope || options.projectRoot)
      throw new Error("--dest cannot be combined with --client, --scope or --project-root.");
    if (!options.destination.trim()) throw new Error("--dest must be non-empty.");
    return path.resolve(context.cwd, options.destination);
  }
  const preset =
    options.client && Object.hasOwn(SKILL_CLIENTS, options.client)
      ? SKILL_CLIENTS[options.client]
      : undefined;
  if (!preset)
    throw new Error("Choose a supported --client or an explicit --dest. Run skills --help.");
  const scope = options.scope ?? "project";
  if (scope !== "project" && scope !== "user") throw new Error("--scope must be project or user.");
  if (scope === "user" && options.projectRoot)
    throw new Error("--project-root applies only to project scope.");
  if (options.projectRoot !== undefined && !options.projectRoot.trim())
    throw new Error("--project-root must be non-empty.");
  return scope === "user"
    ? path.resolve(context.home, preset.user)
    : path.resolve(context.cwd, options.projectRoot ?? ".", preset.project);
}

async function bundledSkillsRoot(): Promise<string> {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    try {
      const parsed: unknown = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"));
      if (parsed && typeof parsed === "object" && "name" in parsed && parsed.name === "mtg-edh-mcp")
        return path.join(dir, "skills");
    } catch (error) {
      if (
        !(error instanceof SyntaxError) &&
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        throw error;
    }
    const parent = path.dirname(dir);
    if (parent === dir)
      throw new Error("Bundled skills not found; use a complete release package.");
    dir = parent;
  }
}

export async function runSkillsCli(
  args: readonly string[],
  context: { sourceRoot?: string; cwd?: string; home?: string } = {},
): Promise<{ exitCode: number; output: string }> {
  if (!args.length || args.includes("--help") || args.includes("-h"))
    return { exitCode: 0, output: SKILLS_HELP };
  if (args[0] === "list") {
    if (args.length !== 1) throw new Error("Usage: mtg-edh-mcp skills list");
    return {
      exitCode: 0,
      output: JSON.stringify({ skills: SKILL_NAMES, clients: SKILL_CLIENTS }, null, 2) + "\n",
    };
  }
  if (args[0] !== "install" && args[0] !== "uninstall")
    throw new Error("Choose skills list, install or uninstall.");
  const options: ParsedOptions = {
    operation: args[0],
    apply: false,
    update: false,
  };
  const seen = new Set<string>();
  for (let index = 1; index < args.length; index++) {
    const flag = args[index];
    if (
      !flag ||
      ![
        "--client",
        "--scope",
        "--dest",
        "--project-root",
        "--skill",
        "--apply",
        "--update",
      ].includes(flag)
    )
      throw new Error(`Unknown skills argument: ${flag}`);
    if (flag !== "--skill" && seen.has(flag)) throw new Error(`Repeated option: ${flag}`);
    seen.add(flag);
    if (flag === "--apply" || flag === "--update") {
      options[flag === "--apply" ? "apply" : "update"] = true;
      continue;
    }
    const value = args[++index];
    if (!value?.trim() || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    switch (flag) {
      case "--client":
        options.client = value;
        break;
      case "--scope":
        options.scope = value;
        break;
      case "--dest":
        options.destination = value;
        break;
      case "--project-root":
        options.projectRoot = value;
        break;
      case "--skill":
        (options.skills ??= []).push(value);
        break;
    }
  }
  const destination = skillDestination(options, {
    cwd: context.cwd ?? process.cwd(),
    home: context.home ?? homedir(),
  });
  const report = await manageSkills({
    sourceRoot: context.sourceRoot ?? (await bundledSkillsRoot()),
    destination,
    operation: options.operation,
    apply: options.apply,
    update: options.update,
    ...(options.skills ? { skills: options.skills } : {}),
  });
  return {
    exitCode: report.status === "conflict" ? 1 : 0,
    output: JSON.stringify(report, null, 2) + "\n",
  };
}
