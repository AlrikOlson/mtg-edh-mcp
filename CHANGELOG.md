# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

The project is pre-1.0: **1.0.0 will be the first signed, notarized public
release of the desktop app.** Until then the engine + app evolve on `main`
under 0.x, and breaking changes may land in minor versions.

## [Unreleased]

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

Releases are cut from `main`:

1. `npm version <major|minor|patch>` (updates `package.json`, creates the tag)
2. `git push && git push --tags`
3. Build the artifacts: `./scripts/package-app.sh` (engine SEA binary →
   `dx bundle` → data snapshot injection → `.app` + `.dmg`; Developer ID
   signing + notarization land with the first 1.0 release)
4. Draft a GitHub Release on the tag; attach the artifact and summarize the
   `[Unreleased]` section here into a new version heading.
