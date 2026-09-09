import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { manageSkills, SKILL_NAMES } from "./install.js";

const renameFault = vi.hoisted(
  (): { fail: ((from: string, to: string) => Error | undefined) | null } => ({ fail: null }),
);
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (
      from: Parameters<typeof actual.rename>[0],
      to: Parameters<typeof actual.rename>[1],
    ) => {
      const error = renameFault.fail?.(String(from), String(to));
      if (error) throw error;
      return actual.rename(from, to);
    },
  };
});

const NAMES = ["mtg-edh", "mtg-edh-cards", "mtg-edh-decks", "mtg-edh-analysis", "mtg-edh-budget"];
const FIRST = "mtg-edh";
const SECOND = "mtg-edh-cards";
const RECEIPT = ".mtg-edh-install.json";
type Request = Parameters<typeof manageSkills>[0];

function markdown(name: string, version = "Original") {
  return `---\nname: ${name}\ndescription: A local fixture for installer verification.\n---\n\n# ${name}\n\n${version} instructions.\n`;
}

async function exists(file: string) {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

/** Both explicit conflict reports and validation errors are safe refusal contracts. */
async function expectRefused(request: Request) {
  expect(manageSkills).toBeTypeOf("function");
  let report;
  try {
    report = await manageSkills(request);
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return;
  }
  expect(report.status).toBe("conflict");
}

describe("portable skill installation", () => {
  let root: string;
  let sourceRoot: string;
  let destination: string;

  function request(extra: Partial<Request> = {}): Request {
    return { sourceRoot, destination, operation: "install", ...extra };
  }

  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), "mtg-skill-install-")));
    sourceRoot = path.join(root, "package", "skills");
    destination = path.join(root, "caller", "skills");
    for (const name of NAMES) {
      await mkdir(path.join(sourceRoot, name, "references"), { recursive: true });
      await writeFile(path.join(sourceRoot, name, "SKILL.md"), markdown(name));
      await writeFile(path.join(sourceRoot, name, "references", "guide.md"), `# ${name} guide\n`);
    }
  });

  afterEach(async () => {
    renameFault.fail = null;
    await rm(root, { recursive: true, force: true });
  });

  it("previews the exact five portable skills by default without creating destination parents", async () => {
    expect(SKILL_NAMES).toEqual(NAMES);
    const report = await manageSkills(request());
    expect(report).toMatchObject({ destination, mode: "preview", status: "ready" });
    expect(report.entries.map((entry) => ({ name: entry.name, action: entry.action }))).toEqual(
      NAMES.map((name) => ({ name, action: "install" })),
    );
    expect(await exists(path.dirname(destination))).toBe(false);
  });

  it("applies the selected files with ownership hashes and repeats without changing them", async () => {
    const first = await manageSkills(request({ apply: true }));
    expect(first).toMatchObject({ destination, mode: "applied", status: "applied" });
    expect(first.entries.every((entry) => entry.action === "install")).toBe(true);
    const expectedHash = createHash("sha256").update(markdown(FIRST)).digest("hex");
    const receiptBefore = await readFile(path.join(destination, FIRST, RECEIPT), "utf8");
    expect(receiptBefore).toContain(expectedHash);
    expect(JSON.parse(receiptBefore)).toEqual(expect.any(Object));
    expect(await readFile(path.join(destination, FIRST, "references", "guide.md"), "utf8")).toBe(
      `# ${FIRST} guide\n`,
    );
    const second = await manageSkills(request({ apply: true }));
    expect(second.entries.every((entry) => entry.action === "unchanged")).toBe(true);
    expect(await readFile(path.join(destination, FIRST, RECEIPT), "utf8")).toBe(receiptBefore);
    expect(await readFile(path.join(destination, FIRST, "SKILL.md"), "utf8")).toBe(markdown(FIRST));
  });

  it("installs only an explicitly selected subset using the supplied absolute roots", async () => {
    expect(path.isAbsolute(sourceRoot)).toBe(true);
    expect(sourceRoot).not.toBe(process.cwd());
    for (const name of NAMES.filter((name) => name !== SECOND)) {
      await rm(path.join(sourceRoot, name), { recursive: true });
    }
    const report = await manageSkills(request({ apply: true, skills: [SECOND] }));
    expect(report.entries).toEqual([expect.objectContaining({ name: SECOND, action: "install" })]);
    expect(await readdir(destination)).toEqual([SECOND]);
    expect(await readFile(path.join(destination, SECOND, "SKILL.md"), "utf8")).toBe(
      markdown(SECOND),
    );
  });

  it.each(["unknown", "../escape", "/tmp/escape", "mtg-edh/../escape", "MTG-EDH"])(
    "rejects unknown or unsafe selection %s without writes",
    async (name) => {
      await expectRefused(request({ apply: true, skills: [FIRST, name] }));
      expect(await exists(path.dirname(destination))).toBe(false);
    },
  );

  it("preflights the whole batch before an unmanaged collision can mutate an earlier skill", async () => {
    await mkdir(path.join(destination, SECOND), { recursive: true });
    await writeFile(path.join(destination, SECOND, "SKILL.md"), "User-authored instructions\n");
    const report = await manageSkills(request({ apply: true, skills: [FIRST, SECOND] }));
    expect(report.status).toBe("conflict");
    expect(report.entries).toContainEqual(
      expect.objectContaining({ name: SECOND, action: "conflict" }),
    );
    expect(await readdir(destination)).toEqual([SECOND]);
    expect(await readFile(path.join(destination, SECOND, "SKILL.md"), "utf8")).toBe(
      "User-authored instructions\n",
    );
  });

  it("requires explicit update permission and previews replacements without writing", async () => {
    await manageSkills(request({ apply: true, skills: [FIRST] }));
    const receiptBefore = await readFile(path.join(destination, FIRST, RECEIPT), "utf8");
    await writeFile(path.join(sourceRoot, FIRST, "SKILL.md"), markdown(FIRST, "Updated"));
    await expectRefused(request({ apply: true, skills: [FIRST] }));
    expect(await readFile(path.join(destination, FIRST, "SKILL.md"), "utf8")).toBe(markdown(FIRST));
    const preview = await manageSkills(request({ update: true, skills: [FIRST] }));
    expect(preview).toMatchObject({ mode: "preview", status: "ready" });
    expect(preview.entries).toEqual([expect.objectContaining({ name: FIRST, action: "update" })]);
    expect(await readFile(path.join(destination, FIRST, RECEIPT), "utf8")).toBe(receiptBefore);
    const applied = await manageSkills(request({ apply: true, update: true, skills: [FIRST] }));
    expect(applied.entries).toEqual([expect.objectContaining({ name: FIRST, action: "update" })]);
    expect(await readFile(path.join(destination, FIRST, "SKILL.md"), "utf8")).toBe(
      markdown(FIRST, "Updated"),
    );
    expect(
      (await manageSkills(request({ apply: true, update: true, skills: [FIRST] }))).entries,
    ).toEqual([expect.objectContaining({ name: FIRST, action: "unchanged" })]);
  });

  it.each(["edited", "extra", "missing"])(
    "refuses a managed update with %s files and preserves every selected installation",
    async (change) => {
      await manageSkills(request({ apply: true, skills: [FIRST, SECOND] }));
      const firstFile = path.join(destination, FIRST, "SKILL.md");
      if (change === "edited") await writeFile(firstFile, "User changes\n");
      if (change === "extra")
        await writeFile(path.join(destination, FIRST, "notes.md"), "User notes\n");
      if (change === "missing") await rm(path.join(destination, FIRST, "references", "guide.md"));
      await writeFile(path.join(sourceRoot, FIRST, "SKILL.md"), markdown(FIRST, "New"));
      await writeFile(path.join(sourceRoot, SECOND, "SKILL.md"), markdown(SECOND, "New"));
      await expectRefused(request({ apply: true, update: true, skills: [SECOND, FIRST] }));
      expect(await readFile(path.join(destination, SECOND, "SKILL.md"), "utf8")).toBe(
        markdown(SECOND),
      );
      expect(await readFile(firstFile, "utf8")).toBe(
        change === "edited" ? "User changes\n" : markdown(FIRST),
      );
      if (change === "extra")
        expect(await readFile(path.join(destination, FIRST, "notes.md"), "utf8")).toBe(
          "User notes\n",
        );
      if (change === "missing")
        expect(await exists(path.join(destination, FIRST, "references", "guide.md"))).toBe(false);
    },
  );

  it("previews uninstall, removes only the pristine managed selection, and preserves unrelated files", async () => {
    await manageSkills(request({ apply: true, skills: [FIRST, SECOND] }));
    await mkdir(path.join(destination, "unrelated"));
    await writeFile(path.join(destination, "unrelated", "SKILL.md"), "Leave me alone\n");
    await writeFile(path.join(destination, "notes.md"), "Caller notes\n");
    const preview = await manageSkills(request({ operation: "uninstall", skills: [FIRST] }));
    expect(preview).toMatchObject({ mode: "preview", status: "ready" });
    expect(preview.entries).toEqual([
      expect.objectContaining({ name: FIRST, action: "uninstall" }),
    ]);
    expect(await exists(path.join(destination, FIRST))).toBe(true);
    const applied = await manageSkills(
      request({ operation: "uninstall", apply: true, skills: [FIRST] }),
    );
    expect(applied.entries).toEqual([
      expect.objectContaining({ name: FIRST, action: "uninstall" }),
    ]);
    expect(await exists(path.join(destination, FIRST))).toBe(false);
    expect(await readFile(path.join(destination, SECOND, "SKILL.md"), "utf8")).toBe(
      markdown(SECOND),
    );
    expect(await readFile(path.join(destination, "unrelated", "SKILL.md"), "utf8")).toBe(
      "Leave me alone\n",
    );
    expect(await readFile(path.join(destination, "notes.md"), "utf8")).toBe("Caller notes\n");
    expect(
      (await manageSkills(request({ operation: "uninstall", apply: true, skills: [FIRST] })))
        .entries,
    ).toEqual([expect.objectContaining({ name: FIRST, action: "absent" })]);
  });

  it.each(["edited", "extra", "missing"])(
    "refuses a whole uninstall batch when a managed skill has %s files",
    async (change) => {
      await manageSkills(request({ apply: true, skills: [FIRST, SECOND] }));
      if (change === "edited")
        await writeFile(path.join(destination, SECOND, "SKILL.md"), "User changes\n");
      if (change === "extra")
        await writeFile(path.join(destination, SECOND, "notes.md"), "User notes\n");
      if (change === "missing") await rm(path.join(destination, SECOND, "references", "guide.md"));
      await expectRefused(
        request({ operation: "uninstall", apply: true, skills: [FIRST, SECOND] }),
      );
      expect(await exists(path.join(destination, FIRST, "SKILL.md"))).toBe(true);
      expect(await exists(path.join(destination, SECOND))).toBe(true);
    },
  );

  it("never uninstalls a folder without an owned receipt", async () => {
    await mkdir(path.join(destination, FIRST), { recursive: true });
    await writeFile(path.join(destination, FIRST, "SKILL.md"), markdown(FIRST));
    await expectRefused(request({ operation: "uninstall", apply: true, skills: [FIRST] }));
    expect(await readFile(path.join(destination, FIRST, "SKILL.md"), "utf8")).toBe(markdown(FIRST));
  });

  it.each([
    "source folder",
    "source file",
    "source parent",
    "destination folder",
    "destination parent",
  ])("rejects a symlink in the %s without following it", async (location) => {
    const alternate = path.join(root, "outside");
    await mkdir(alternate);
    await writeFile(path.join(alternate, "SKILL.md"), "Outside sentinel\n");
    let options = request({ apply: true, skills: [FIRST] });
    if (location === "source folder") {
      await rm(path.join(sourceRoot, FIRST), { recursive: true });
      await symlink(alternate, path.join(sourceRoot, FIRST));
    } else if (location === "source file") {
      await symlink(path.join(alternate, "SKILL.md"), path.join(sourceRoot, FIRST, "linked.md"));
    } else if (location === "source parent") {
      const alias = path.join(root, "package-alias");
      await symlink(path.dirname(sourceRoot), alias);
      options = request({ apply: true, skills: [FIRST], sourceRoot: path.join(alias, "skills") });
    } else if (location === "destination folder") {
      await mkdir(destination, { recursive: true });
      await symlink(alternate, path.join(destination, FIRST));
    } else {
      const alias = path.join(root, "target-alias");
      await symlink(alternate, alias);
      options = request({ apply: true, skills: [FIRST], destination: path.join(alias, "skills") });
    }
    await expectRefused(options);
    expect(await readdir(alternate)).toEqual(["SKILL.md"]);
    expect(await readFile(path.join(alternate, "SKILL.md"), "utf8")).toBe("Outside sentinel\n");
    if (location !== "destination folder") expect(await exists(destination)).toBe(false);
  });

  it.each(["helper.sh", "payload.js"])("rejects non-Markdown source payload %s", async (file) => {
    await writeFile(
      path.join(sourceRoot, FIRST, file),
      "console.log('unexpected executable payload');\n",
    );
    await expectRefused(request({ apply: true, skills: [FIRST] }));
    expect(await exists(destination)).toBe(false);
  });

  it("rejects executable Markdown source files", async () => {
    await chmod(path.join(sourceRoot, FIRST, "SKILL.md"), 0o755);
    await expectRefused(request({ apply: true, skills: [FIRST] }));
    expect(await exists(destination)).toBe(false);
  });

  it.each(["install", "uninstall"] as const)(
    "preserves an added empty directory by refusing %s of the changed managed skill",
    async (operation) => {
      await manageSkills(request({ apply: true, skills: [FIRST] }));
      const empty = path.join(destination, FIRST, "user-work");
      await mkdir(empty);
      await writeFile(path.join(sourceRoot, FIRST, "SKILL.md"), markdown(FIRST, "Updated"));
      await expectRefused(
        request({ operation, apply: true, skills: [FIRST], update: operation === "install" }),
      );
      expect(await lstat(empty)).toEqual(expect.objectContaining({ mode: expect.any(Number) }));
      expect(await readFile(path.join(destination, FIRST, "SKILL.md"), "utf8")).toBe(
        markdown(FIRST),
      );
    },
  );

  it("does not remove or rewrite a lock owned by an existing installation", async () => {
    const lock = path.join(destination, ".mtg-edh-install.lock");
    await mkdir(lock, { recursive: true });
    await writeFile(path.join(lock, "owner.json"), '{"pid":12345,"note":"existing owner"}\n');
    await expectRefused(request({ apply: true, skills: [FIRST] }));
    expect(await readdir(destination)).toEqual([".mtg-edh-install.lock"]);
    expect(await readFile(path.join(lock, "owner.json"), "utf8")).toBe(
      '{"pid":12345,"note":"existing owner"}\n',
    );
  });

  it.each(["install", "update", "uninstall"] as const)(
    "rolls back the entire %s batch after a single filesystem rename fails",
    async (operation) => {
      if (operation !== "install")
        await manageSkills(request({ apply: true, skills: [FIRST, SECOND] }));
      for (const name of [FIRST, SECOND])
        await writeFile(path.join(sourceRoot, name, "SKILL.md"), markdown(name, "Updated"));
      let failed = false;
      renameFault.fail = (from, to) => {
        const selectedMove =
          operation === "uninstall"
            ? from === path.join(destination, SECOND) && path.basename(to) === `old-${SECOND}`
            : path.basename(from) === SECOND && to === path.join(destination, SECOND);
        if (!failed && selectedMove) {
          failed = true;
          return new Error("Injected one-time filesystem rename failure");
        }
        return undefined;
      };
      await expect(
        manageSkills(
          request({
            operation: operation === "uninstall" ? "uninstall" : "install",
            update: operation === "update",
            apply: true,
            skills: [FIRST, SECOND],
          }),
        ),
      ).rejects.toThrow("Injected one-time filesystem rename failure");
      expect(failed).toBe(true);
      expect((await readdir(destination)).sort()).toEqual(
        operation === "install" ? [] : [FIRST, SECOND],
      );
      if (operation !== "install") {
        for (const name of [FIRST, SECOND]) {
          expect(await readFile(path.join(destination, name, "SKILL.md"), "utf8")).toBe(
            markdown(name),
          );
          expect((await manageSkills(request({ update: true, skills: [name] }))).entries).toEqual([
            expect.objectContaining({ name, action: "update" }),
          ]);
        }
      }
    },
  );

  it("retains the owned lock and original backup when rollback itself fails", async () => {
    await manageSkills(request({ apply: true, skills: [FIRST, SECOND] }));
    for (const name of [FIRST, SECOND])
      await writeFile(path.join(sourceRoot, name, "SKILL.md"), markdown(name, "Updated"));
    renameFault.fail = (from, to) => {
      if (path.basename(from) === SECOND && to === path.join(destination, SECOND))
        return new Error("Injected apply failure");
      if (path.basename(from) === `old-${FIRST}` && to === path.join(destination, FIRST))
        return new Error("Injected rollback failure");
      return undefined;
    };
    await expect(
      manageSkills(request({ apply: true, update: true, skills: [FIRST, SECOND] })),
    ).rejects.toThrow("lock retained");
    const owner: unknown = JSON.parse(
      await readFile(path.join(destination, ".mtg-edh-install.lock", "owner.json"), "utf8"),
    );
    if (
      !owner ||
      typeof owner !== "object" ||
      !("transaction" in owner) ||
      typeof owner.transaction !== "string"
    )
      throw new Error("Missing recovery transaction path");
    expect(await readFile(path.join(owner.transaction, `old-${FIRST}`, "SKILL.md"), "utf8")).toBe(
      markdown(FIRST),
    );
    expect(
      await readFile(path.join(owner.transaction, `failed-${FIRST}`, "SKILL.md"), "utf8"),
    ).toBe(markdown(FIRST, "Updated"));
    expect(await readFile(path.join(destination, SECOND, "SKILL.md"), "utf8")).toBe(
      markdown(SECOND),
    );
    expect(await exists(path.join(destination, FIRST))).toBe(false);
  });

  it.each(['[Guide](references/guide.md "Reference guide")', "[Guide](<references/guide.md>)"])(
    "accepts valid Markdown local reference syntax %s",
    async (link) => {
      await writeFile(path.join(sourceRoot, FIRST, "SKILL.md"), markdown(FIRST) + `\n${link}\n`);
      const report = await manageSkills(request({ apply: true, skills: [FIRST] }));
      expect(report.status).toBe("applied");
      expect(await readFile(path.join(destination, FIRST, "SKILL.md"), "utf8")).toContain(link);
    },
  );

  it.each([
    "[Missing](references/absent.md)",
    "[Escape](../../outside.md)",
    '[Escape](<../../outside.md> "Outside file")',
  ])("rejects invalid source reference %s before writing any selected skill", async (link) => {
    await writeFile(path.join(sourceRoot, SECOND, "SKILL.md"), markdown(SECOND) + `\n${link}\n`);
    await expectRefused(request({ apply: true, skills: [FIRST, SECOND] }));
    expect(await exists(path.dirname(destination))).toBe(false);
  });
});
