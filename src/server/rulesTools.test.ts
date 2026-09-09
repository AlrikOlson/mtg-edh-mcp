import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  Client,
  InMemoryTransport,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VersionedStore } from "../ingest/index.js";
import { buildIndex, CardIndex } from "../index/index.js";
import { RulesService, RulesStore } from "../rules/index.js";
import { FIXTURE_RULING, rulesFixture } from "../rules/fixture.js";
import { createServer } from "./createServer.js";
import { startHttp } from "./http.js";
import { staticSnapshotProvider } from "./snapshot.js";

const SNAPSHOT = "2026-09-08";
const ORACLE = [
  {
    id: "p-study",
    oracle_id: FIXTURE_RULING.oracle_id,
    name: "Rhystic Study",
    layout: "normal",
    cmc: 3,
    type_line: "Enchantment",
    oracle_text:
      "Whenever an opponent casts a spell, you may draw a card unless that player pays {1}.",
    colors: ["U"],
    color_identity: ["U"],
    legalities: { commander: "legal" },
  },
  {
    id: "p-ring",
    oracle_id: "o-ring",
    name: "Sol Ring",
    layout: "normal",
    cmc: 1,
    type_line: "Artifact",
    oracle_text: "{T}: Add {C}{C}.",
    colors: [],
    color_identity: [],
    legalities: { commander: "legal" },
  },
];

const provenance = z.object({
  status: z.enum(["current", "stale", "unavailable"]),
  version: z.string().nullable(),
  comprehensive_rules: z
    .object({
      url: z.string(),
      url_discovery: z.enum(["rules_page", "pinned_default", "explicit"]),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      effective_date: z.string().nullable(),
      published_version: z.string().nullable(),
      retrieved_at: z.string(),
      rule_count: z.number(),
    })
    .nullable(),
  rulings: z
    .object({
      source: z.literal("scryfall_bulk_rulings"),
      url: z.string(),
      updated_at: z.string(),
      sha256: z.string(),
      retrieved_at: z.string(),
      ruling_count: z.number(),
    })
    .nullable(),
  age_hours: z.number().nullable(),
  refresh_failed: z.boolean(),
  last_refresh: z
    .object({
      at: z.string(),
      ok: z.boolean(),
      skipped: z.boolean().optional(),
      error: z.string().optional(),
    })
    .nullable(),
});

const lookupBody = z.object({
  corpus: provenance,
  rules: z.array(
    z.object({ requested: z.string(), status: z.enum(["found", "unknown"]) }).passthrough(),
  ),
  glossary: z.array(
    z.object({ requested: z.string(), status: z.enum(["found", "unknown"]) }).passthrough(),
  ),
  found: z.number(),
  unknown: z.number(),
  data_snapshot: z.string(),
});

const rulingsBody = z.object({
  corpus: provenance,
  source_filter: z.enum(["all", "wizards_ruling", "provider_note"]),
  cards: z.array(
    z.object({
      oracle_id: z.string(),
      name: z.string(),
      rulings_status: z.enum(["recorded", "none_recorded", "unavailable"]),
      counts: z
        .object({
          total: z.number(),
          wizards_ruling: z.number(),
          provider_note: z.number(),
          other: z.number(),
        })
        .nullable(),
      rulings: z.array(
        z.object({
          oracle_id: z.string(),
          source: z.string(),
          source_type: z.enum(["wizards_ruling", "provider_note", "other"]),
          published_at: z.string().nullable(),
          comment: z.string(),
        }),
      ),
    }),
  ),
  missing: z.array(z.string()),
  data_snapshot: z.string(),
});

async function buildTestIndex(root: string): Promise<CardIndex> {
  const store = new VersionedStore(root);
  await store.createVersion(SNAPSHOT);
  await writeFile(store.filePath(SNAPSHOT, "oracle_cards.json"), JSON.stringify(ORACLE));
  await writeFile(store.filePath(SNAPSHOT, "default_cards.json"), "[]");
  await store.publish(SNAPSHOT);
  return CardIndex.open((await buildIndex({ store })).dbPath);
}

describe.each(["2026-07-28", "2024-11-05"] as const)(
  "public rules tools over protocol %s",
  (revision) => {
    let root: string;
    let index: CardIndex;
    let client: Client;
    let running: Awaited<ReturnType<typeof startHttp>>;
    let rules: RulesService;
    let clock: number;
    let fixtureMode: "ok" | "dead";

    beforeEach(async () => {
      root = await mkdtemp(path.join(tmpdir(), "mtg-rules-tools-"));
      index = await buildTestIndex(root);
      clock = Date.parse("2026-09-08T22:00:00Z");
      fixtureMode = "ok";
      rules = new RulesService(new RulesStore(root), {
        client: () =>
          fixtureMode === "ok"
            ? rulesFixture().client
            : rulesFixture({ rulesPage: "fail", rulesText: "fail" }).client,
        now: () => clock,
      });
      await rules.load();
      running = await startHttp({ index, snapshot: staticSnapshotProvider(SNAPSHOT), rules });
      client = new Client(
        { name: "rules-test", version: "1.0.0" },
        {
          supportedProtocolVersions: [revision],
          versionNegotiation: {
            mode: revision === "2026-07-28" ? { pin: revision } : "legacy",
          },
        },
      );
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${running.port}/mcp`)),
      );
    });

    afterEach(async () => {
      await client.close();
      await running.close();
      index.close();
      await rm(root, { recursive: true, force: true });
    });

    it("refreshes explicitly, then answers exact lookups with release provenance and explicit unknowns", async () => {
      const cold = await client.callTool({ name: "rules_lookup", arguments: { rules: "903.3" } });
      expect(cold.isError).toBe(true);
      expect(JSON.stringify(cold.content)).toContain("UPSTREAM_UNAVAILABLE");

      const refreshed = await client.callTool({ name: "rules_refresh", arguments: {} });
      expect(refreshed.isError).not.toBe(true);
      expect(refreshed.structuredContent).toMatchObject({ ok: true, skipped: false });
      const again = await client.callTool({ name: "rules_refresh", arguments: {} });
      expect(again.structuredContent).toMatchObject({ ok: true, skipped: true });

      const result = await client.callTool({
        name: "rules_lookup",
        arguments: {
          rules: ["903.3", "903.3a", "903.3z", "903", "9", "commander"],
          glossary: ["commander tax", "Planechase"],
        },
      });
      expect(result.isError).not.toBe(true);
      const parsed = lookupBody.parse(result.structuredContent);
      expect(parsed.data_snapshot).toBe(SNAPSHOT);
      expect(result.content).toContainEqual({
        type: "text",
        text: JSON.stringify(result.structuredContent),
      });
      expect(parsed.corpus).toMatchObject({
        status: "current",
        comprehensive_rules: {
          url_discovery: "rules_page",
          effective_date: "2026-08-07",
          published_version: "20260901",
          rule_count: 1204,
        },
        rulings: { ruling_count: 2 },
        age_hours: 0,
        refresh_failed: false,
      });
      expect(parsed.found).toBe(5);
      expect(parsed.unknown).toBe(3);
      expect(parsed.rules[0]).toMatchObject({
        status: "found",
        kind: "rule",
        number: "903.3",
        section: { number: "903", title: "Commander" },
        rule: { text: expect.stringContaining("(b) a Vehicle card, or (c) a Spacecraft card") },
      });
      expect(parsed.rules[1]).toMatchObject({ status: "found", number: "903.3a" });
      expect(parsed.rules[2]).toEqual({
        requested: "903.3z",
        number: "903.3z",
        status: "unknown",
        reason: "not_in_corpus",
        nearest: "903.3",
      });
      expect(parsed.rules[3]).toMatchObject({ status: "found", kind: "section", rule_count: 1204 });
      expect(parsed.rules[4]).toMatchObject({ status: "found", kind: "chapter" });
      expect(parsed.rules[5]).toMatchObject({ status: "unknown", reason: "not_a_rule_number" });
      expect(parsed.glossary).toEqual([
        {
          requested: "commander tax",
          status: "found",
          term: "Commander Tax",
          text: "An informal term for the additional cost to cast a commander from the command zone.",
        },
        { requested: "Planechase", status: "unknown", reason: "not_in_corpus" },
      ]);
    });

    it("searches with bounded excerpts and returns card rulings by source type with missingness", async () => {
      await client.callTool({ name: "rules_refresh", arguments: {} });
      const search = await client.callTool({
        name: "rules_search",
        arguments: {
          query: "commander vehicle spacecraft",
          limit: 3,
          section: "903",
          excerpt_chars: 100,
        },
      });
      expect(search.isError).not.toBe(true);
      const found = z
        .object({
          corpus: provenance,
          tokens: z.array(z.string()),
          total_matches: z.number(),
          returned: z.number(),
          truncated: z.boolean(),
          results: z.array(
            z.object({
              number: z.string(),
              excerpt: z.string(),
              matches: z.number(),
              complete: z.boolean(),
            }),
          ),
          glossary: z.array(z.object({ term: z.string() })),
        })
        .parse(search.structuredContent);
      expect(found.tokens).toEqual(["commander", "vehicle", "spacecraft"]);
      expect(found.results.map((r) => r.number)).toEqual(["903.3"]);
      expect(found.results[0]!.excerpt.length).toBeLessThanOrEqual(102);
      expect(found.results[0]!.complete).toBe(false);
      expect(found.glossary).toEqual([]);

      const bad = await client.callTool({ name: "rules_lookup", arguments: {} });
      expect(bad.isError).toBe(true);
      expect(JSON.stringify(bad.content)).toContain("INVALID_QUERY");

      const rulings = rulingsBody.parse(
        (
          await client.callTool({
            name: "card_rulings",
            arguments: { cards: ["Rhystic Study", "Sol Ring", "o-nope"] },
          })
        ).structuredContent,
      );
      expect(rulings.missing).toEqual(["o-nope"]);
      expect(rulings.cards[0]).toMatchObject({
        oracle_id: FIXTURE_RULING.oracle_id,
        name: "Rhystic Study",
        rulings_status: "recorded",
        counts: { total: 2, wizards_ruling: 1, provider_note: 1, other: 0 },
      });
      expect(
        rulings.cards[0]!.rulings.map((r) => [r.source, r.source_type, r.published_at]),
      ).toEqual([
        ["wotc", "wizards_ruling", "2023-09-01"],
        ["scryfall", "provider_note", "2024-01-01"],
      ]);
      expect(rulings.cards[1]).toEqual({
        oracle_id: "o-ring",
        name: "Sol Ring",
        rulings_status: "none_recorded",
        counts: { total: 0, wizards_ruling: 0, provider_note: 0, other: 0 },
        rulings: [],
      });

      const onlyWizards = rulingsBody.parse(
        (
          await client.callTool({
            name: "card_rulings",
            arguments: { cards: "Rhystic Study", source: "wizards_ruling" },
          })
        ).structuredContent,
      );
      expect(onlyWizards.source_filter).toBe("wizards_ruling");
      expect(onlyWizards.cards[0]!.rulings).toHaveLength(1);
      expect(onlyWizards.cards[0]!.counts?.total).toBe(2);
    });

    it("keeps serving the last usable corpus with stale status after a failed refresh", async () => {
      await client.callTool({ name: "rules_refresh", arguments: {} });
      fixtureMode = "dead";
      clock += 60 * 60 * 1000;
      const failed = await client.callTool({ name: "rules_refresh", arguments: { force: true } });
      expect(failed.isError).toBe(true);
      expect(JSON.stringify(failed.content)).toContain("UPSTREAM_UNAVAILABLE");

      const lookup = lookupBody.parse(
        (await client.callTool({ name: "rules_lookup", arguments: { rules: "903.5a" } }))
          .structuredContent,
      );
      expect(lookup.rules[0]).toMatchObject({ status: "found", number: "903.5a" });
      expect(lookup.corpus).toMatchObject({
        status: "stale",
        refresh_failed: true,
        age_hours: 1,
        last_refresh: { ok: false, error: expect.stringContaining("UPSTREAM_UNAVAILABLE") },
      });
      const rulings = rulingsBody.parse(
        (await client.callTool({ name: "card_rulings", arguments: { cards: "Rhystic Study" } }))
          .structuredContent,
      );
      expect(rulings.cards[0]!.rulings_status).toBe("recorded");
      expect(rulings.corpus.status).toBe("stale");
    });

    it("rejects explicit release URLs outside wizards.com before touching the network", async () => {
      const result = await client.callTool({
        name: "rules_refresh",
        arguments: { url: "https://example.test/MagicCompRules%2020260819.txt" },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("INVALID_QUERY");
      expect(rules.status().last_refresh).toBeNull();
    });
  },
);

describe("rules tools on a cold corpus", () => {
  let root: string;
  let index: CardIndex;
  let client: Client;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "mtg-rules-cold-"));
    index = await buildTestIndex(root);
    const rules = new RulesService(new RulesStore(root), {
      client: () => rulesFixture({ rulesPage: "fail", rulesText: "fail" }).client,
    });
    await rules.load();
    const server = createServer({ index, rules, snapshot: staticSnapshotProvider(SNAPSHOT) });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "rules-cold-test", version: "1" });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    index.close();
    await rm(root, { recursive: true, force: true });
  });

  it("reports unavailable rulings per resolved card and an unavailable corpus for rules search", async () => {
    const rulings = rulingsBody.parse(
      (
        await client.callTool({
          name: "card_rulings",
          arguments: { cards: ["Sol Ring", "o-nope"] },
        })
      ).structuredContent,
    );
    expect(rulings.corpus).toMatchObject({ status: "unavailable", version: null, rulings: null });
    expect(rulings.cards).toEqual([
      {
        oracle_id: "o-ring",
        name: "Sol Ring",
        rulings_status: "unavailable",
        counts: null,
        rulings: [],
      },
    ]);
    expect(rulings.missing).toEqual(["o-nope"]);

    const search = await client.callTool({
      name: "rules_search",
      arguments: { query: "commander" },
    });
    expect(search.isError).toBe(true);
    expect(JSON.stringify(search.content)).toContain("rules_refresh");

    const refresh = await client.callTool({ name: "rules_refresh", arguments: {} });
    expect(refresh.isError).toBe(true);
    expect(JSON.stringify(refresh.content)).toContain("UPSTREAM_UNAVAILABLE");
    const after = rulingsBody.parse(
      (await client.callTool({ name: "card_rulings", arguments: { cards: "Sol Ring" } }))
        .structuredContent,
    );
    expect(after.corpus).toMatchObject({ status: "unavailable", refresh_failed: true });
  });
});
