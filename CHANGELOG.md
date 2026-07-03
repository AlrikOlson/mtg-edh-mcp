# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

The project is pre-1.0: **1.0.0 will be the first signed, notarized public
release of the desktop app.** Until then the engine + app evolve on `main`
under 0.x, and breaking changes may land in minor versions.

## [Unreleased]

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
