/** Shipped instructions stay portable and describe the real MCP wire contract. */
import { lstat, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Client,
  InMemoryTransport,
  type Tool,
  type JsonSchemaType,
} from "@modelcontextprotocol/client";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import { VersionedStore } from "../ingest/index.js";
import { buildIndex, CardIndex } from "../index/index.js";
import { DeckStore } from "../deck/index.js";
import { createServer } from "../server/createServer.js";
import { staticSnapshotProvider } from "../server/snapshot.js";
import { manageSkills, SKILL_NAMES } from "./install.js";

const sourceRoot = await realpath(fileURLToPath(new URL("../../skills/", import.meta.url)));
const payloads = new Map<string, Map<string, string>>();
let root: string;
let index: CardIndex;
let client: Client;
let tools: Tool[];

/** This bundle uses only standard one-line YAML strings and optional string metadata. */
function scalar(value: string): string {
  if (value.startsWith('"')) {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "string") throw new Error("Expected a quoted string");
    return parsed;
  }
  if (value.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(value)) throw new Error("Invalid single-quoted scalar");
    return value.slice(1, -1).replaceAll("''", "'");
  }
  if (
    !value ||
    /^[[\]{}>|&*!?%@`#]/.test(value) ||
    /:\s|\s#/.test(value) ||
    /^(?:null|true|false|[\d.+-]+)$/i.test(value)
  )
    throw new Error("Quote YAML-special, non-string or multiline values");
  return value;
}
function frontmatter(markdown: string) {
  const header = /^---\n([\s\S]*?)\n---\n/.exec(markdown);
  if (!header?.[1]) throw new Error("Missing standard YAML frontmatter");
  const fields = new Map<string, string>();
  const metadata = new Map<string, string>();
  let inMetadata = false;
  for (const line of header[1].split("\n")) {
    if (line === "metadata:") {
      if (inMetadata || fields.has("metadata")) throw new Error("Duplicate metadata");
      inMetadata = true;
      fields.set("metadata", "");
      continue;
    }
    const entry = /^( *)([a-zA-Z0-9_-]+): (.+)$/.exec(line);
    if (!entry?.[2] || !entry[3]) throw new Error(`Unsupported frontmatter line: ${line}`);
    if (entry[1] === "  " && inMetadata) {
      if (metadata.has(entry[2])) throw new Error("Duplicate metadata field");
      metadata.set(entry[2], scalar(entry[3]));
    } else {
      inMetadata = false;
      if (entry[1] !== "" || fields.has(entry[2])) throw new Error("Indented or duplicate field");
      fields.set(entry[2], scalar(entry[3]));
    }
  }
  return { fields, body: markdown.slice(header[0].length) };
}
async function readBundle(folder: string, prefix = ""): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const entry of await readdir(path.join(folder, prefix))) {
    const relative = path.posix.join(prefix, entry);
    const location = path.join(folder, relative);
    const stat = await lstat(location);
    expect(stat.isSymbolicLink(), location).toBe(false);
    if (stat.isDirectory()) {
      for (const pair of await readBundle(folder, relative)) result.set(...pair);
    } else {
      expect(stat.isFile() && stat.nlink === 1 && (stat.mode & 0o111) === 0, location).toBe(true);
      expect(relative, "Only portable Markdown payloads ship in a skill").toMatch(/\.md$/);
      result.set(relative, await readFile(location, "utf8"));
    }
  }
  return result;
}

beforeAll(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "mtg-skill-content-")));
  const store = new VersionedStore(path.join(root, "data"));
  await store.createVersion("v1");
  await writeFile(
    store.filePath("v1", "oracle_cards.json"),
    JSON.stringify([
      {
        oracle_id: "o-sol",
        id: "p-sol",
        name: "Sol Ring",
        cmc: 1,
        colors: [],
        color_identity: [],
        type_line: "Artifact",
        oracle_text: "{T}: Add {C}{C}.",
        legalities: { commander: "legal" },
        prices: { usd: "1.50" },
      },
    ]),
  );
  await writeFile(store.filePath("v1", "default_cards.json"), "[]");
  await store.publish("v1");
  index = CardIndex.open((await buildIndex({ store })).dbPath);
  const server = createServer({
    index,
    deckStore: new DeckStore(),
    snapshot: staticSnapshotProvider("2026-09-09"),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: "skill-content-conformance", version: "1.0.0" });
  await client.connect(clientTransport);
  tools = (await client.listTools()).tools;
  for (const name of SKILL_NAMES) payloads.set(name, await readBundle(path.join(sourceRoot, name)));
});
afterAll(async () => {
  await client?.close();
  index?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

describe("shipped portable skill content", () => {
  it("routes every actual registered tool exactly once without invented tools", () => {
    const router = payloads.get("mtg-edh")?.get("references/tools.md") ?? "";
    const documented = [...router.matchAll(/^\| `([a-z_]+)`\s*\|/gm)].map((m) => m[1]);
    expect(tools).toHaveLength(56);
    expect(new Set(documented).size).toBe(documented.length);
    expect(documented.sort()).toEqual(tools.map((tool) => tool.name).sort());
  });

  it.each(SKILL_NAMES)(
    "keeps %s metadata standard and its guidance independently readable",
    (name) => {
      const payload = payloads.get(name);
      const entry = payload?.get("SKILL.md") ?? "";
      const { fields, body } = frontmatter(entry);
      expect(
        [...fields.keys()].filter(
          (key) => !["name", "description", "license", "metadata"].includes(key),
        ),
      ).toEqual([]);
      expect(fields.get("name")).toBe(name);
      expect(name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(name.length).toBeLessThanOrEqual(64);
      expect(fields.get("description")?.length).toBeGreaterThan(20);
      expect(fields.get("description")?.length).toBeLessThanOrEqual(1024);
      expect(body.split("\n").length).toBeLessThan(500);
      expect(Buffer.byteLength(body)).toBeLessThan(16000);
      expect(payload?.get("LICENSE.md")).toContain("Copyright (c) 2026 Alrik Olson");
      expect(payload?.get("LICENSE.md")).toContain("Permission is hereby granted");
      for (const [file, content] of payload ?? []) {
        // A copied absolute machine path or host permission field would break portability.
        expect(content, `${name}/${file}`).not.toMatch(
          /(?:\/Users\/|\/home\/|[A-Za-z]:\\|\b(?:allowed-tools|disable-model-invocation):)/,
        );
        for (const match of content.matchAll(/\]\(([^)]+)\)/g)) {
          const link = match[1] ?? "";
          if (link.startsWith("https://") || link.startsWith("#")) continue;
          expect(
            path.posix.isAbsolute(link) || /[:\\]/.test(link),
            `${name}/${file}: ${link}`,
          ).toBe(false);
          const resolved = path.posix.normalize(
            path.posix.join(path.posix.dirname(file), link.split("#")[0] ?? ""),
          );
          expect(resolved.startsWith("../"), `${name}/${file}: ${link}`).toBe(false);
          expect(payload?.has(resolved), `${name}/${file}: missing ${link}`).toBe(true);
        }
      }
    },
  );

  it("validates every complete fenced tool-call example against its live input schema", () => {
    const validator = new AjvJsonSchemaValidator();
    let checked = 0;
    for (const [skill, payload] of payloads) {
      for (const [file, content] of payload) {
        for (const block of content.matchAll(/```text\n([\s\S]*?)\n```/g)) {
          for (const line of (block[1] ?? "").split("\n").filter(Boolean)) {
            const call = /^([a-z_]+) (\{.*\})$/.exec(line);
            if (!call?.[1] || !call[2])
              throw new Error(
                `Expected a complete illustrative tool call: ${skill}/${file}: ${line}`,
              );
            const tool = tools.find((t) => t.name === call[1]);
            if (!tool) throw new Error(`Unknown example tool ${call[1]}`);
            const args: unknown = JSON.parse(call[2]);
            // Wire Tool types permit generic JSON values; these schemas were generated
            // by the real registry. The SDK compiler validates their schema semantics.
            const result = validator.getValidator(tool.inputSchema as JsonSchemaType)(args);
            expect(result.valid, `${skill}/${file}: ${line}: ${result.errorMessage ?? ""}`).toBe(
              true,
            );
            checked++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it.each(SKILL_NAMES)(
    "installs the real %s folder alone with byte-identical references",
    async (name) => {
      const destination = path.join(root, "individual", name);
      const report = await manageSkills({
        sourceRoot,
        destination,
        operation: "install",
        skills: [name],
        apply: true,
      });
      expect(report.status).toBe("applied");
      expect(await readdir(destination)).toEqual([name]);
      const payload = payloads.get(name);
      expect(payload?.size).toBeGreaterThan(1);
      for (const [file, original] of payload ?? []) {
        expect(await readFile(path.join(destination, name, file), "utf8"), file).toBe(original);
      }
    },
  );
});
