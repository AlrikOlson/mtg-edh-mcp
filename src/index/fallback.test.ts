import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LiveScryfallClient, VersionedStore, type FetchFn } from "../ingest/index.js";
import { buildIndex, CardIndex } from "./cardIndex.js";
import { resolveCardByNameFallback } from "./fallback.js";

const ORACLE = [
  {
    oracle_id: "o-sol",
    id: "p-sol-1",
    name: "Sol Ring",
    cmc: 1,
    color_identity: [],
    type_line: "Artifact",
    oracle_text: "{T}: Add {C}{C}.",
    legalities: { commander: "legal" },
    prices: { usd: "1.50" },
  },
];

const NEW_CARD = {
  oracle_id: "o-new",
  id: "p-new",
  name: "Brand New Commander",
  cmc: 3,
  color_identity: ["U"],
  type_line: "Legendary Creature — Bird Wizard",
  oracle_text: "Flying.",
  legalities: { commander: "legal" },
  prices: {},
};

/** Live stub: /cards/named returns the brand-new card. */
function liveFetch(): FetchFn {
  return ((input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/cards/named"))
      return Promise.resolve(new Response(JSON.stringify(NEW_CARD)));
    return Promise.resolve(new Response("not found", { status: 404 }));
  }) as FetchFn;
}

let root: string;
let index: CardIndex;
let live: LiveScryfallClient;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "mtg-fallback-"));
  const store = new VersionedStore(root);
  await store.createVersion("v1");
  await writeFile(store.filePath("v1", "oracle_cards.json"), JSON.stringify(ORACLE), "utf8");
  await writeFile(store.filePath("v1", "default_cards.json"), JSON.stringify([]), "utf8");
  await store.publish("v1");
  const built = await buildIndex({ store });
  index = CardIndex.open(built.dbPath);
  live = new LiveScryfallClient({
    fetch: liveFetch(),
    sleep: () => Promise.resolve(),
    now: () => 0,
  });
});
afterEach(async () => {
  index.close();
  await rm(root, { recursive: true, force: true });
});

describe("resolveCardByNameFallback", () => {
  it("resolves a locally-indexed card from the index", async () => {
    const result = await resolveCardByNameFallback({ index, live, name: "Sol Ring" });
    expect(result.source).toBe("index");
    expect(result.card.name).toBe("Sol Ring");
  });

  it("falls back to live for a card newer than the snapshot (not in the index)", async () => {
    const result = await resolveCardByNameFallback({ index, live, name: "Brand New Commander" });
    expect(result.source).toBe("live");
    expect(result.card.name).toBe("Brand New Commander");
    expect(result.card.is_commander_eligible).toBe(true); // mapped via mapScryfallCard
  });
});
