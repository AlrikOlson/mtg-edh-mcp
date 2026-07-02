# mtg-edh-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for **Magic:
The Gathering Commander/EDH deckbuilding**. It gives an AI agent the _primitives_
to build, validate, and analyze Commander decks — card knowledge (local Scryfall
index + query grammar), versioned deck state, rules validation, deck analysis,
and meta enrichment (EDHREC, Commander Spellbook, brackets) — while making zero
strategic decisions of its own.

See [`commander-deckbuilder-mcp-spec.md`](./commander-deckbuilder-mcp-spec.md) for
the full design and [`ROADMAP.md`](./ROADMAP.md) for delivery status.

> **Status:** feature-complete v1. All seven phases have shipped — card knowledge,
> versioned deck state, validation, analysis, meta enrichment, multi-tenancy, and
> the determinism/latency gate — with 230 tests green. The three §10 worked-example
> decks build end-to-end through the tools alone.

## Requirements

- Node.js ≥ 18 (developed on Node 24)
- npm

## Running the server

The server speaks the [Model Context Protocol](https://modelcontextprotocol.io)
over two transports from one core (`createServer`):

- **stdio** (default) — for local MCP clients (Claude Desktop, IDE extensions).
  `mtg-edh-mcp` (the `bin`) launches it; point your client's MCP config at the
  command.
- **Streamable HTTP** — for hosted clients. Stateless: a fresh server is created
  per POST, all sharing one card index (read-only) and one deck store.

**Transport security posture:** the desktop GUI (`gui/`) spawns the engine as a
child process and speaks MCP over **stdio pipes** — a default app launch owns no
TCP listener at all, so nothing is reachable from browsers or LAN peers. The
HTTP transport is for hosted deployments and local development only (opt in from
the GUI with `MTG_EDH_DEV_HTTP=1`); it binds `127.0.0.1` by default and carries
no authentication, so never expose it beyond localhost as-is.

Both expose the same tools and resources. Deck state is scoped per **principal**:
over HTTP the principal is read from the `x-mcp-principal` request header (so two
callers get isolated decks); stdio and header-less requests use the single
`local` session. Deck mutations are versioned — pass `expected_version` to
`deck_add` / `deck_remove` / `deck_set_commander` for an optimistic-concurrency
check that returns a conflict instead of clobbering a concurrent edit.

## Tool catalog

| Group        | Tools                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------- |
| Card         | `card_search`, `card_get`, `card_resolve_name`, `card_printings`                                        |
| Deck (state) | `deck_create`, `deck_get`, `deck_list`, `deck_delete`, `deck_set_commander`, `deck_add`, `deck_remove`  |
| Versioning   | `deck_snapshot`, `deck_diff`, `deck_restore`, `deck_import`, `deck_export`                              |
| Validation   | `validate_deck`, `validate_card`, `validate_commander`                                                  |
| Analysis     | `analyze_curve`, `analyze_composition`, `analyze_stats`, `analyze_mana_base`, `analyze_role_coverage`   |
| Meta         | `meta_commander_profile`, `meta_themes`, `meta_recommendations`, `meta_combos`, `meta_classify_bracket` |

The server makes **zero strategic decisions** — it answers questions, mutates
state, computes statistics, and validates. The agent supplies the taste.

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

## Observability & graceful degradation

Every tool response is stamped with `data_snapshot` — the registry wrapper
(`src/server/registry.ts`) applies it uniformly, so a client can always tell
which card-data vintage produced an answer. Enrichment calls (EDHREC, Commander
Spellbook, Game Changers) go through a TTL cache that **degrades gracefully**:
on an upstream failure it serves the last good value if one is cached, and only
surfaces `UPSTREAM_UNAVAILABLE` when there is nothing to fall back on. Core
search / validation / analysis never touch the network, so the server stays
fully functional local-only when upstreams are down.

## Compliance (Scryfall Fan Content)

This project honors [Scryfall's Fan Content terms](https://scryfall.com/docs/api):

- Every outbound request sends one descriptive **User-Agent** (defined once in
  `src/types/userAgent.ts`) identifying the app, version, and a contact URL.
- Live Scryfall calls are a rate-limited fallback (≥100 ms spacing, <2 req/s for
  search-class endpoints); the steady state is the local bulk index.
- Card data is **not paywalled or re-sold** — the server adds genuine value
  (state, validation, analysis) on top of it rather than proxying raw data.

Portions of the data are © Wizards of the Coast. This is unofficial Fan Content;
not approved/endorsed by Wizards. Card data via Scryfall.

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

## Support

This is a free, open-source hobby project. If it's useful to you and you feel
like saying thanks:

- [GitHub Sponsors](https://github.com/sponsors/AlrikOlson)
- [Buy Me a Coffee](https://buymeacoffee.com/alrikolson)

## License

MIT
