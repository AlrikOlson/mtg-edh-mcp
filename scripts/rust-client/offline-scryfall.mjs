// Only upstream HTTP is stubbed. The real CLI, ingestion pipeline, SQLite store,
// MCP server, and Rust client execute without live Scryfall downloads.
import { gzipSync } from "node:zlib";

const card = {
  oracle_id: "00000000-0000-4000-8000-000000000001",
  id: "00000000-0000-4000-8000-000000000002",
  name: "Rust Acceptance Artifact",
  cmc: 1,
  colors: [],
  color_identity: [],
  type_line: "Artifact",
  oracle_text: "{T}: Add {C}.",
  legalities: { commander: "legal" },
  set: "tst",
  set_name: "Rust client fixture",
  collector_number: "1",
  rarity: "common",
  prices: { usd: "1.00" },
};

globalThis.fetch = async (input) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url === "https://api.scryfall.com/bulk-data") {
    return Response.json({
      data: ["oracle_cards", "default_cards"].map((type) => ({
        type,
        updated_at: "2026-09-01T09:00:00.000Z",
        jsonl_download_uri: `https://offline.invalid/${type}.jsonl.gz`,
      })),
    });
  }
  if (
    url === "https://offline.invalid/oracle_cards.jsonl.gz" ||
    url === "https://offline.invalid/default_cards.jsonl.gz"
  ) {
    return new Response(gzipSync(`${JSON.stringify(card)}\n`));
  }
  throw new Error(`Unexpected network request in Rust acceptance: ${url}`);
};
