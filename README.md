# mtg-edh-mcp

**Give your AI assistant a Commander deckbuilding workbench.**

[![CI](https://github.com/AlrikOlson/mtg-edh-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/AlrikOlson/mtg-edh-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

An open-source [Model Context Protocol](https://modelcontextprotocol.io) server
for Magic: The Gathering Commander / EDH. Search real card data, build and save
decks, check legality, explore mana and budget, and consult community combo and
recommendation data—all through your existing MCP client.

The assistant chooses the deck's direction. The server supplies the card
knowledge, durable state, and checks to make those choices reviewable.

- **Local card knowledge.** A Scryfall bulk-data index with SQLite full-text
  search, a Scryfall-style query language, Oracle text, and printing prices.
- **A deck you can iterate on.** Batch additions by card name, per-card legality
  feedback, persistent decks, snapshots, diffs, and restores.
- **Useful answers in one call.** `deck_status` brings together the count,
  legality, curve, mana coverage, role gaps, and estimated price.
- **Deeper analysis when needed.** Seeded opening-hand simulations, mana-source
  analysis, owned-card filtering, and cheaper-printing budget plans.
- **Reviewable advice.** EDHREC additions and budget-swap cuts explain role and
  synergy evidence, lost roles, price impact, uncertainty, and source freshness.
- **Correctable role labels.** Save per-deck role overrides, including custom
  combo pieces and payoffs; reset restores inferred roles without changing legality.
- **Combo prerequisites.** Preserve Spellbook quantities, zones, commander and
  face requirements, templates, mana and steps. Separate card inclusion from
  checked deck prerequisites; execution stays unknown. Advisory bracket estimates
  expose provider failures, stale observations and incomplete combo coverage.
- **Declared playgroup policies.** Save bracket and custom category limits with
  casual, thematic or competitive goals. Get separate policy findings, protected
  card constraints, versioned sources and explicit unknowns through `meta_check_policy`.
- **Verbatim rules evidence.** Exact Comprehensive Rules lookup, bounded keyword
  search and per-card rulings from a versioned local corpus with release dates,
  digests and staleness; unknown rule numbers are reported, never guessed.

**Start here:** [Installation](./docs/INSTALL.md) ·
[Agent cookbook](./docs/AGENT-COOKBOOK.md) ·
[Workflow evidence](./docs/evaluation/README.md) ·
[Contributing](./CONTRIBUTING.md) · [Security](./SECURITY.md)

## Quick start

Use **Node.js 24** and npm. No API key is required for the standalone server.
The initial Scryfall download and index build can take several minutes and
requires substantial disk space; allow several GB for versioned card data.

```sh
git clone https://github.com/AlrikOlson/mtg-edh-mcp.git
cd mtg-edh-mcp
npm ci
npm run build
export MCP_DATA_DIR="$HOME/.mtg-edh-mcp/cards"
node dist/main.js setup
npm run ingest
node dist/main.js doctor
```

`setup` safely initializes local storage and prints a client configuration with
absolute paths. `doctor` reports readiness and actionable fixes without changing
files. You can also connect before downloading and use `data_ingest`; indexed
tools become available on the same connection when ingestion finishes.

Add the server to your MCP client's local **stdio** configuration. This is the
`mcpServers` format used by Claude Desktop and other compatible clients:

```json
{
  "mcpServers": {
    "mtg-edh": {
      "command": "node",
      "args": ["/absolute/path/to/mtg-edh-mcp/dist/main.js"],
      "env": {
        "MCP_DATA_DIR": "/absolute/path/to/your/home/.mtg-edh-mcp/cards"
      }
    }
  }
}
```

Replace **both absolute paths** with your real paths. The data directory must
match the one used for ingest; JSON configuration does not expand `$HOME` or
`~`. If your client cannot find `node`, use its absolute executable path too.
Restart the client to load the server.

Then ask:

> Check that the card database is ready. Build a Commander deck around Atraxa,
> Praetors' Voice with a counters theme and a $150 target. Explain your choices,
> check legality and mana, and export the finished list.

For an existing deck:

> Import this decklist, set its commander, and show me its biggest mana and
> role gaps. Take a snapshot before making any changes.

The server is installed from source. See the [installation guide](./docs/INSTALL.md)
for configuration, updates, and troubleshooting. This repository contains the
MCP server and its tooling; desktop clients are developed separately.

Stdio and local HTTP support MCP **2026-07-28** and older initialization-based
clients. Existing client configuration and the tool catalog remain compatible;
see [protocol compatibility](./docs/INSTALL.md#protocol-compatibility).

## What the server exposes

With a card index loaded, the server exposes **50 tools**, **3 workflow
prompts**, and addressable card, deck, and collection resources. Tool schemas
and descriptions are available through MCP `tools/list`.

| Group                | Tools                                                                                                                                                                                               |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Data                 | `ping`, `data_status`, `data_ingest`                                                                                                                                                                |
| Cards                | `card_search`, `card_get`, `card_resolve_name`, `card_printings`                                                                                                                                    |
| Collection           | `collection_set`, `collection_add`, `collection_get`, `collection_clear`                                                                                                                            |
| Decks                | `deck_create`, `deck_get`, `deck_list`, `deck_rename`, `deck_delete`, `deck_set_commander`, `deck_set_companion`, `deck_set_roles`, `deck_get_intent`, `deck_set_intent`, `deck_add`, `deck_remove` |
| History and exchange | `deck_snapshot`, `deck_diff`, `deck_restore`, `deck_import`, `deck_export`                                                                                                                          |
| Validation           | `validate_deck`, `validate_card`, `validate_commander`                                                                                                                                              |
| Rules and rulings    | `rules_lookup`, `rules_search`, `rules_refresh`, `card_rulings`                                                                                                                                     |
| Analysis             | `deck_status`, `analyze_curve`, `analyze_composition`, `analyze_stats`, `analyze_mana_base`, `analyze_role_coverage`, `simulate_deck`, `budget_plan`                                                |
| Community data       | `meta_commander_profile`, `meta_recommend`, `meta_budget_swaps`, `meta_combos`, `meta_classify_bracket`, `meta_check_policy`                                                                        |

The prompts `build_commander_deck`, `tune_deck`, and `fit_budget` teach clients
the corresponding workflows. Resources use `card://{oracle_id}`,
`deck://{deck_id}`, and `collection://{session}` URIs.

Card inputs such as `deck_add` and `card_get` accept names or Oracle IDs.
Content-changing deck operations return `vitals` so the assistant can see the
new count, identity, legality, and version without fetching the deck again.
Batch additions report rejected cards and unresolved names individually.

### Search examples

Pass a query to `card_search` with a separate `limit` or `order` argument:

| Find                                          | Query                                     |
| --------------------------------------------- | ----------------------------------------- |
| Proliferate creatures in Atraxa's identity    | `id<=wubg t:creature o:proliferate mv<=4` |
| Low-cost green or colorless cards             | `id<=g mv<=2 usd<=3`                      |
| Dragons or Angels                             | `(t:dragon or t:angel) mv<=5`             |
| A printing from a particular set              | `set:cmm rarity:rare`                     |
| Cards marked as Game Changers in the snapshot | `is:gamechanger`                          |

This implements a subset of Scryfall syntax. Unsupported or malformed queries
return `INVALID_QUERY`; [the cookbook](./docs/AGENT-COOKBOOK.md) covers recovery.

## Data, privacy, and limits

Core search, deck management, validation, and analysis use the local index.
The server checks for Scryfall updates in the background by default; set
`MCP_AUTO_REFRESH=0` to disable that scheduler. `data_ingest` and the `meta_*`
tools may access external services even when automatic refresh is disabled.
Card refreshes publish only complete validated snapshots, preserve the previous
version, and reuse unchanged indexes. See [refresh recovery and disk cleanup](./docs/INSTALL.md#card-refresh-recovery).

- **Scryfall** supplies card data and printing prices through bulk exports.
  `data_snapshot` identifies the card-data vintage in structured tool results.
- **EDHREC** supplies commander profiles and recommendations through an
  unofficial endpoint, which may change or become unavailable.
- **Commander Spellbook** receives commander and main-deck card names for
  combo lookup, including during bracket classification and applicable playgroup checks.
- **Game Changers** come from the local Scryfall snapshot, with a live Scryfall
  fallback for older indexes. Brackets, role coverage, simulations, and prices
  are advisory; they are not guarantees about a deck's performance or cost.

Enrichment uses cached data when available and reports upstream failures. The
local tools continue to work without those services. Your MCP client and model
provider have their own policies for the tool results they receive.

Decks, snapshots, and owned-card collections persist transactionally in
`user-data.sqlite` under `MCP_DATA_DIR`. Multiple local server processes can
share that directory; successful mutations are committed before the response.
Existing `decks.json` data migrates once with its source preserved. Automatic
backups and an explicit restore command provide a [user-data recovery path](./docs/INSTALL.md#user-data-backup-and-restore).

**stdio is the default transport.** Streamable HTTP is available for trusted
local clients and binds to `127.0.0.1` by default. It has no authentication.
The `x-mcp-principal` header selects a data namespace; it does not establish
identity. See [Security](./SECURITY.md) before changing the bind address.

## Development

```sh
npm ci
npm run build
npm run typecheck
npm test
npm run lint
npm run test:package
npm run lint:rust
npm run test:rust
```

The server gate is **build + typecheck + test + lint**, plus an installed-package
smoke test and a [real Rust rmcp client](./scripts/rust-client/README.md)
(Rust/Cargo 1.88+). The tests use small fixtures, so a full card-data download is not required. See
[Contributing](./CONTRIBUTING.md) for the project layout and contribution workflow,
[Protocol workflow evaluation](./docs/evaluation/README.md) for the pinned baseline,
and [Changelog](./CHANGELOG.md) for changes. The server is pre-1.0; interfaces
may change as the project develops.

## Credits and license

MIT licensed. See [LICENSE](./LICENSE).

Card data and card rulings via [Scryfall](https://scryfall.com). Comprehensive
Rules text is downloaded from the official
[Wizards of the Coast rules page](https://magic.wizards.com/en/rules). Community
data via [EDHREC](https://edhrec.com) and
[Commander Spellbook](https://commanderspellbook.com).
Magic: The Gathering is owned by Wizards of the Coast. This is an unofficial
fan project, unaffiliated with and not endorsed by these organizations.

If this project is useful to you, you can support its development through
[GitHub Sponsors](https://github.com/sponsors/AlrikOlson) or
[Buy Me a Coffee](https://buymeacoffee.com/alrikolson).
