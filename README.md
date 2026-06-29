# mtg-edh-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for **Magic:
The Gathering Commander/EDH deckbuilding**. It gives an AI agent the _primitives_
to build, validate, and analyze Commander decks — card knowledge (local Scryfall
index + query grammar), versioned deck state, rules validation, deck analysis,
and meta enrichment (EDHREC, Commander Spellbook, brackets) — while making zero
strategic decisions of its own.

See [`commander-deckbuilder-mcp-spec.md`](./commander-deckbuilder-mcp-spec.md) for
the full design and [`ROADMAP.md`](./ROADMAP.md) for delivery status.

> **Status:** early scaffold. Only the project skeleton exists today; the MCP
> server and tools are being built phase by phase (see the roadmap).

## Requirements

- Node.js ≥ 18 (developed on Node 24)
- npm

## Development

```sh
npm install        # installs deps (compiles the better-sqlite3 native addon)
npm run build      # bundle the server entrypoint to dist/ (tsup, ESM + .d.ts)
npm run typecheck  # tsc --noEmit
npm test           # vitest
npm run lint       # eslint + prettier --check
npm run format     # prettier --write
```

The release gate is **build + typecheck + test + lint all green**.

## Data freshness & provenance

The server answers from a local Scryfall bulk index staged under a versioned
store (default `data/cards/`, override with `MCP_DATA_DIR`). Every tool response
is stamped with `data_snapshot` — the ISO date of the card index, read from the
current version's manifest at startup.

Refresh cadence (spec §3) is configurable via env vars:

| Variable                | Default      | Meaning                             |
| ----------------------- | ------------ | ----------------------------------- |
| `MCP_DATA_DIR`          | `data/cards` | Root of the versioned card store    |
| `MCP_BULK_INTERVAL_MS`  | `43200000`   | Full bulk re-ingest cadence (~12h)  |
| `MCP_PRICE_INTERVAL_MS` | `86400000`   | Price-only refresh cadence (~daily) |

A **price-only refresh** (`refreshPrices`) re-downloads `default_cards` and
updates the printings' prices in place — no rebuild of the cards table or FTS
index. Oracle-level card prices refresh on a full bulk rebuild.

## Project layout

The source is organized around the spec's engine groupings:

| Path            | Engine                                         |
| --------------- | ---------------------------------------------- |
| `src/server/`   | MCP transport + tool registration (entrypoint) |
| `src/ingest/`   | Scryfall bulk download + atomic swap           |
| `src/index/`    | Local card index (SQLite + FTS5)               |
| `src/query/`    | Scryfall query grammar parser + evaluator      |
| `src/deck/`     | Versioned deck store + lifecycle tools         |
| `src/validate/` | Rules / validation engine                      |
| `src/analyze/`  | Curve / composition / mana-base analysis       |
| `src/meta/`     | EDHREC / Spellbook / bracket enrichment        |
| `src/types/`    | Canonical data model + error taxonomy          |

## License

MIT
