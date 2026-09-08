# Changelog

Notable changes to the MCP server. Historical entries also cover the former
bundled desktop application.
The project is pre-1.0; minor releases may include breaking changes.

## Unreleased

- Add four offline MCP workflow journeys with a retained v0.2.0 protocol baseline,
  measured call/error/result-byte counts, and deterministic regression checks.
  Model-driven host evaluation remains a separate release requirement.

- Separate the desktop application, Rust client, design assets, and app packaging
  into a local GUI repository with their Git history and licenses preserved.
  This repository now contains the MCP server and its Node tooling only.
- Remove the stale generated roadmap view; native Magistr records remain the
  authoritative plan.

## 0.2.0 — 2026-09-08

First public GitHub release of the MCP server.

### Added

- A source-install guide, client configuration with stable data paths, an agent
  cookbook, contribution guide, security policy, and third-party asset notices.
- CLI help/version and explicit stdio selection. Invalid flags, transports,
  ports, empty data paths, and non-loopback HTTP hosts fail with useful errors.
- A package smoke test that installs the built archive outside the checkout,
  loads native SQLite, connects over real stdio, reads resources, and verifies
  saved decks survive a restart.
- CI for Node 22.13, 24, and 26 on Linux, plus Node 24 on macOS and Windows.
  Dependencies and GitHub Actions receive weekly update checks.

### Fixed

- Deck and collection resources now use the same session scope as tools.
  Deck subscriptions filter notifications by session; stateless HTTP no longer
  advertises subscriptions it cannot deliver.
- HTTP preserves enrichment caches between requests while giving every request
  its own MCP server and transport. Port conflicts reject startup cleanly.
- Concurrent upstream calls respect request spacing. JSON requests have a
  30-second deadline; large bulk downloads have a separate 15-minute deadline.
- Structured tool results include a JSON text fallback for clients that only
  consume text content.
- Package metadata points to the correct GitHub repository; packaging builds
  its own artifacts and supports the Node versions required by dependencies.
- Dependency security updates, including a scoped esbuild override for tsup.
  Package publication to npm remains disabled.

### Security

- The unauthenticated HTTP listener accepts loopback binds only, validates Host
  and Origin before processing requests, and limits JSON bodies to 1 MiB.
  Malformed JSON returns a parse error instead of an internal server error.
- Runtime namespace boundaries are covered by interleaved HTTP resource tests.
  The client-selected principal header is not an authentication mechanism.

## Earlier development

The following capabilities were built before the first public release.

### Added

- Query grammar: `set:`/`e:` (code or full set name), `rarity:`/`r:` (word or
  c/u/r/m/s/b letter), `year` comparisons, `is:gamechanger`, and
  `order:released` now evaluate against the local index instead of returning
  INVALID_QUERY. Several printing-level predicates under one AND merge into a
  single EXISTS, so `set:lea year<=1994` requires one printing satisfying both
  (Scryfall semantics).
- Freshness scheduler (spec §3, previously documented but never run): the
  server checks bulk-data age at startup and every `MCP_BULK_INTERVAL_MS`,
  re-ingests when upstream changed, and hot-swaps the served index +
  `data_snapshot` without a restart (also after GUI-triggered `data_ingest`).
  `data_status` now reports `bulk_age_hours` + `stale`. Opt out with
  `MCP_AUTO_REFRESH=0`.
- Bracket classification reads the Game Changers list from the local index
  (`game_changer` flag in Scryfall bulk data) — offline and versioned with the
  snapshot; pre-flag indexes fall back to the live Scryfall search.
- `serverInfo.version` now reports the real package version instead of a
  hardcoded `0.0.0`.

### Fixed

- Scryfall bulk ingestion: upstream retired the single-JSON-array
  `download_uri` (its URLs now 404) in favour of gzipped JSONL
  (`jsonl_download_uri`), which broke `npm run ingest` outright. The client now
  resolves and gunzips the JSONL export, versions stage as
  `oracle_cards.jsonl` / `default_cards.jsonl`, and the streaming reader sniffs
  the file shape so legacy staged versions and JSON-array fixtures still read.
- Game Changers list: `json.edhrec.com/pages/game-changers.json` was withdrawn
  upstream (403), leaving bracket classification with no source. It now reads
  WotC's list from Scryfall's `is:gamechanger` search, following `next_page`.

### Security

- Audited CVE-2026-25536 (MCP SDK cross-client leak in stateless deployments):
  not affected — the pinned SDK (`^1.29.0`) is past the 1.26.0 fix, and the
  HTTP transport constructs a fresh server + transport per request, so the
  vulnerable shared-instance pattern is structurally absent. An interleaved
  two-principal regression test now guards the property permanently.

### Added

- MCP server (stdio + streamable HTTP) with card knowledge (local Scryfall
  index + query grammar), versioned deck state, Commander rules validation,
  deck analysis (curve/composition/mana base/roles/seeded Monte Carlo sim),
  budget planning, and meta enrichment (EDHREC, Commander Spellbook, brackets).
- Desktop GUI (Dioxus): Browse, Workbench, Collection, and Gallery screens,
  the Oracle in-app agent (three-tier brain: Claude Code CLI → BYO Anthropic
  API key via keychain → scripted intents), what-if projections, session
  persistence, and a packaged macOS `.app` with the engine as a sidecar.
- Transport hardening: the desktop app speaks MCP to its engine over
  stdin/stdout pipes — a default launch owns no engine TCP listener.
- First-run onboarding: `data_status` / `data_ingest` tools + an in-app
  download-and-build flow for the card database, and a Settings action to
  update card data in place.
- Deck durability: decks and snapshots persist to `decks.json` under the data
  dir and survive app restarts.

### Release process

1. Run typecheck, tests, lint, and `npm run test:package`.
2. Update the package version, lockfile, and changelog together.
3. Commit the reviewed change, tag that commit, and push to GitHub.
4. Publish a GitHub Release with verified source/package artifacts and notes.

The MCP server is distributed through GitHub and source installs. It is not
published to npm. Desktop signing and notarization are a separate release path.
