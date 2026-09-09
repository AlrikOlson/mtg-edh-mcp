import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { VersionedStore } from "../ingest/index.js";
import { buildIndex, CardIndex } from "../index/index.js";

export function rawCard(name: string, oracle_text: string, extra: Record<string, unknown> = {}) {
  return {
    id: name,
    oracle_id: name,
    name,
    oracle_text,
    layout: "normal",
    cmc: 2,
    mana_cost: "{1}",
    type_line: "Creature — Human",
    colors: [],
    color_identity: [],
    legalities: { commander: "legal" },
    ...extra,
  };
}
export async function discoveryFixture(cards: Record<string, unknown>[]) {
  const root = await mkdtemp(path.join(tmpdir(), "mtg-discovery-"));
  const store = new VersionedStore(root);
  await store.createVersion("2026-09-08");
  await writeFile(store.filePath("2026-09-08", "oracle_cards.json"), JSON.stringify(cards));
  await writeFile(store.filePath("2026-09-08", "default_cards.json"), "[]");
  await store.publish("2026-09-08");
  const index = CardIndex.open((await buildIndex({ store })).dbPath);
  return {
    index,
    async close() {
      index.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
