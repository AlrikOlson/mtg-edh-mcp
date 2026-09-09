import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const SKILL_NAMES = [
  "mtg-edh",
  "mtg-edh-cards",
  "mtg-edh-decks",
  "mtg-edh-analysis",
  "mtg-edh-budget",
] as const;

const RECEIPT = ".mtg-edh-install.json";
const OWNER = "mtg-edh-mcp";
const MAX_FILES = 128;
const MAX_BYTES = 512 * 1024;

type Payload = Map<string, Buffer>;
type Hashes = Record<string, string>;
export interface SkillEntry {
  name: string;
  action: "install" | "update" | "uninstall" | "unchanged" | "absent" | "conflict";
  reason?: string;
}
export interface SkillsReport {
  destination: string;
  mode: "preview" | "applied";
  status: "ready" | "conflict" | "applied";
  entries: SkillEntry[];
}
export interface ManageSkillsOptions {
  sourceRoot: string;
  destination: string;
  operation: "install" | "uninstall";
  skills?: readonly string[];
  apply?: boolean;
  update?: boolean;
}

function digest(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function hashes(payload: Payload): Hashes {
  return Object.fromEntries(
    [...payload]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, bytes]) => [name, digest(bytes)]),
  );
}
function sameHashes(a: Hashes, b: Hashes): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}
async function statOrMissing(file: string) {
  try {
    return await lstat(file);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

/** Reject link traversal, including dangling links and linked parent directories. */
async function checkedPath(input: string): Promise<string> {
  if (!input.trim()) throw new Error("A non-empty directory path is required.");
  const absolute = path.resolve(input);
  let cursor = path.parse(absolute).root;
  for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    const stat = await statOrMissing(cursor);
    if (stat?.isSymbolicLink()) throw new Error(`Refusing symlink path: ${cursor}`);
    if (stat && !stat.isDirectory()) throw new Error(`Expected a directory: ${cursor}`);
  }
  return absolute;
}
function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

async function readPayload(root: string, installed = false): Promise<Payload> {
  await checkedPath(root);
  const output: Payload = new Map();
  let bytes = 0;
  async function visit(relative: string, depth: number): Promise<void> {
    if (depth > 4) throw new Error("Skill directory nesting exceeds the supported limit.");
    const entries = await readdir(path.join(root, relative), {
      withFileTypes: true,
    });
    if (relative && entries.length === 0)
      throw new Error(`Unexpected empty skill directory: ${relative}`);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!relative && installed && entry.name === RECEIPT) continue;
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(entry.name)) {
        throw new Error(`Unexpected skill path: ${entry.name}`);
      }
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      const file = path.join(root, name);
      const stat = await lstat(file);
      if (stat.isSymbolicLink()) throw new Error(`Refusing symlink: ${file}`);
      if (stat.isDirectory()) {
        await visit(name, depth + 1);
      } else {
        if (
          !stat.isFile() ||
          stat.nlink !== 1 ||
          (stat.mode & 0o111) !== 0 ||
          !name.endsWith(".md")
        ) {
          throw new Error(`Skills must contain regular, non-executable Markdown files: ${file}`);
        }
        if (stat.size > MAX_BYTES || output.size >= MAX_FILES)
          throw new Error("Skill payload exceeds size limits.");
        const content = await readFile(file);
        bytes += content.length;
        if (bytes > MAX_BYTES) throw new Error("Skill payload exceeds size limits.");
        output.set(name, content);
      }
    }
  }
  await visit("", 0);
  if (!output.has("SKILL.md")) throw new Error(`Missing SKILL.md: ${root}`);
  return output;
}

function validateSkill(payload: Payload, name: string): void {
  const skill = payload.get("SKILL.md")?.toString("utf8") ?? "";
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(skill)?.[1];
  // This bundle intentionally uses the common, single-line name/description subset.
  const declaredName = /^name:\s*(.+)$/m.exec(frontmatter ?? "")?.[1]?.replace(/^["']|["']$/g, "");
  if (!frontmatter || declaredName !== name) {
    throw new Error(`Skill frontmatter name must match ${name}.`);
  }
  if (!/^description: \S.+$/m.test(frontmatter))
    throw new Error(`Missing skill description: ${name}`);
  for (const [file, bytes] of payload) {
    for (const match of bytes.toString("utf8").matchAll(/\]\(([^)]+)\)/g)) {
      const destination = /^(?:<([^>]+)>|(\S+?))(?:\s+(?:"[^"]*"|'[^']*'))?$/.exec(match[1] ?? "");
      const link = destination?.[1] ?? destination?.[2];
      if (!link) throw new Error("Unsupported Markdown link destination.");
      if (!link || link.startsWith("#") || /^https:\/\//.test(link)) continue;
      const target = link.split("#")[0];
      if (!target || path.posix.isAbsolute(target) || /[:\\\\]/.test(target)) {
        throw new Error(`Unsafe reference in ${name}/${file}: ${link}`);
      }
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), target));
      if (resolved.startsWith("../") || !payload.has(resolved)) {
        throw new Error(`Missing or external skill reference in ${name}/${file}: ${link}`);
      }
    }
  }
}

function parseReceipt(value: unknown, name: string): Hashes {
  if (
    !value ||
    typeof value !== "object" ||
    !("format" in value) ||
    value.format !== 1 ||
    !("package" in value) ||
    value.package !== OWNER ||
    !("skill" in value) ||
    value.skill !== name ||
    !("files" in value) ||
    !value.files ||
    typeof value.files !== "object" ||
    Array.isArray(value.files)
  ) {
    throw new Error("Unrecognized installation receipt.");
  }
  const result: Hashes = {};
  for (const [key, hash] of Object.entries(value.files)) {
    if (
      !/^(?:[a-zA-Z0-9][a-zA-Z0-9._-]*\/)*[a-zA-Z0-9][a-zA-Z0-9._-]*\.md$/.test(key) ||
      key.split("/").includes("..") ||
      typeof hash !== "string" ||
      !/^[a-f0-9]{64}$/.test(hash)
    ) {
      throw new Error("Invalid installation receipt file hash.");
    }
    result[key] = hash;
  }
  return result;
}

async function inspectInstalled(root: string, name: string): Promise<Hashes | undefined> {
  const stat = await statOrMissing(root);
  if (!stat) return undefined;
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new Error("Existing skill is not a regular directory.");
  const marker = path.join(root, RECEIPT);
  const markerStat = await statOrMissing(marker);
  if (
    !markerStat?.isFile() ||
    markerStat.isSymbolicLink() ||
    markerStat.nlink !== 1 ||
    markerStat.size > MAX_BYTES
  ) {
    throw new Error("Existing skill is unmanaged; it will not be overwritten.");
  }
  const recorded = parseReceipt(JSON.parse(await readFile(marker, "utf8")), name);
  const actual = hashes(await readPayload(root, true));
  if (!sameHashes(recorded, actual))
    throw new Error(
      "Installed files were edited, added or removed; preserve or move this skill before proceeding.",
    );
  return actual;
}

/**
 * Offline, explicit-scope installation. Plans the whole set before any writes.
 * Per-skill renames are atomic; ordinary failures roll back the selected set.
 * A hard interruption retains the transaction directory and lock for inspection.
 */
export async function manageSkills(options: ManageSkillsOptions): Promise<SkillsReport> {
  const selected = options.skills === undefined ? [...SKILL_NAMES] : [...new Set(options.skills)];
  if (!selected.length || selected.some((name) => !SKILL_NAMES.some((known) => known === name))) {
    throw new Error("Choose one or more known skill names; run skills list.");
  }
  if (!["install", "uninstall"].includes(options.operation))
    throw new Error("Unknown skills operation.");
  if (options.update && options.operation !== "install")
    throw new Error("--update applies only to installation.");
  const destination = await checkedPath(options.destination);
  const sourceRoot = path.resolve(options.sourceRoot);
  if (contains(sourceRoot, destination) || contains(destination, sourceRoot)) {
    throw new Error("Source and destination skill directories must not overlap.");
  }
  const payloads = new Map<string, Payload>();
  if (options.operation === "install") {
    await checkedPath(sourceRoot);
    for (const name of selected) {
      const payload = await readPayload(path.join(sourceRoot, name));
      validateSkill(payload, name);
      payloads.set(name, payload);
    }
  }
  const before = new Map<string, Hashes | undefined>();
  const entries: SkillEntry[] = [];
  for (const name of selected) {
    try {
      const old = await inspectInstalled(path.join(destination, name), name);
      before.set(name, old);
      if (options.operation === "uninstall") {
        entries.push({ name, action: old ? "uninstall" : "absent" });
      } else {
        const payload = payloads.get(name);
        if (!payload) throw new Error("Missing validated skill payload.");
        const identical = old !== undefined && sameHashes(old, hashes(payload));
        entries.push({
          name,
          action: !old
            ? "install"
            : identical
              ? "unchanged"
              : options.update
                ? "update"
                : "conflict",
          ...(!identical && old && !options.update
            ? {
                reason: "Managed version differs; preview again with --update.",
              }
            : {}),
        });
      }
    } catch (error) {
      entries.push({
        name,
        action: "conflict",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const report: SkillsReport = {
    destination,
    mode: "preview",
    status: "ready",
    entries,
  };
  if (entries.some((entry) => entry.action === "conflict"))
    return { ...report, status: "conflict" };
  if (!options.apply) return report;
  const changes = entries.filter((entry) =>
    ["install", "update", "uninstall"].includes(entry.action),
  );
  if (!changes.length) return { ...report, mode: "applied", status: "applied" };
  await checkedPath(destination);
  await mkdir(destination, { recursive: true });
  const lock = path.join(destination, ".mtg-edh-install.lock");
  try {
    await mkdir(lock);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new Error(
        `Another installation or interrupted transaction holds ${lock}. Inspect it; do not remove a live installer's lock.`,
        { cause: error },
      );
    }
    throw error;
  }
  const transaction = path.join(destination, `.mtg-edh-install-${randomUUID()}`);
  const moved: Array<{
    target: string;
    backup: string;
    oldMoved: boolean;
    newMoved: boolean;
  }> = [];
  let cleanup = true;
  try {
    await writeFile(
      path.join(lock, "owner.json"),
      JSON.stringify({ pid: process.pid, transaction }),
      { flag: "wx", mode: 0o600 },
    );
    await mkdir(transaction);
    for (const entry of changes) {
      if (entry.action === "uninstall") continue;
      const payload = payloads.get(entry.name);
      if (!payload) throw new Error("Missing staged payload.");
      const staged = path.join(transaction, entry.name);
      await mkdir(staged);
      for (const [file, bytes] of payload) {
        await mkdir(path.dirname(path.join(staged, file)), { recursive: true });
        await writeFile(path.join(staged, file), bytes, {
          flag: "wx",
          mode: 0o644,
        });
      }
      await writeFile(
        path.join(staged, RECEIPT),
        JSON.stringify(
          {
            format: 1,
            package: OWNER,
            skill: entry.name,
            files: hashes(payload),
          },
          null,
          2,
        ) + "\n",
        { flag: "wx", mode: 0o644 },
      );
    }
    // Re-read after the lock and staging, before modifying any existing skill.
    for (const entry of entries) {
      const actual = await inspectInstalled(path.join(destination, entry.name), entry.name);
      const expected = before.get(entry.name);
      if (
        (actual === undefined) !== (expected === undefined) ||
        (actual && expected && !sameHashes(actual, expected))
      )
        throw new Error("Destination changed during planning; retry the preview.");
    }
    for (const entry of changes) {
      await checkedPath(destination);
      const target = path.join(destination, entry.name);
      const backup = path.join(transaction, `old-${entry.name}`);
      const step = { target, backup, oldMoved: false, newMoved: false };
      moved.push(step);
      if (entry.action !== "install") {
        await rename(target, backup);
        step.oldMoved = true;
      } else if (await statOrMissing(target)) {
        throw new Error("Destination appeared during installation; refusing replacement.");
      }
      if (entry.action !== "uninstall") {
        await rename(path.join(transaction, entry.name), target);
        step.newMoved = true;
      }
    }
  } catch (error) {
    try {
      for (const step of moved.reverse()) {
        if (step.newMoved)
          await rename(step.target, path.join(transaction, `failed-${path.basename(step.target)}`));
        if (step.oldMoved) await rename(step.backup, step.target);
      }
    } catch (rollbackError) {
      cleanup = false;
      throw new Error(
        `Installation interrupted and rollback needs inspection at ${transaction}; lock retained. ${String(rollbackError)}`,
        { cause: rollbackError },
      );
    }
    throw error;
  } finally {
    if (cleanup) {
      await rm(transaction, { recursive: true, force: true });
      await rm(lock, { recursive: true });
    }
  }
  return { ...report, mode: "applied", status: "applied" };
}
