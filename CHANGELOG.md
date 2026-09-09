# Changelog

Notable changes to the MCP server. Historical entries also cover the former
bundled desktop application.
The project is pre-1.0; minor releases may include breaking changes.

## 0.3.0 (unreleased)

- Add `deck_construct` (56 tools total), a bounded deterministic local builder
  for complete Commander decks from commander, theme and partial requests.
  Found candidates pass shared complete-deck validation and return reviewed
  atomic plans for `deck_plan_apply`, with supported game plans, dependencies,
  whole-deck budget evidence and baseline mana limitations. Direct conflicts
  and search exhaustion are distinct; unknown hard requirements cannot pass.
  The build prompt now teaches construction, review, atomic apply and independent
  checks. Pinned diverse builds and real MCP/process rollback tests cover the flow.

- Add `deck_plan_preview` and `deck_plan_apply` (55 tools total) for complete
  new decks and full revisions. Preview returns exact desired inventory, complete
  zone and metadata diffs, legality and constraint evidence without saving.
  Apply revalidates deck and exact card-data revisions, then writes the deck,
  pre-change snapshot and durable retry receipt atomically. Exact retries return
  the original receipt after restart, later edits or deletion. Unsupported hard
  constraints and inventory-revision guarantees remain explicit blockers.

- Add `construction_spec` (53 tools total), a read-only versioned specification
  for empty, theme, commander, partial-list and saved-deck requests. It reuses
  saved intent, distinguishes hard constraints from preferences and explicit
  unbounded budgets from targets and caps, preserves command-zone alternatives
  and outside-deck companion accounting, and returns actionable choices,
  conflicts and unresolved requirements. It does not search, mutate decks or
  prove feasibility. `build_commander_deck` now accepts an optional commander
  and an existing `deck_id`.

- Make `meta_recommend` default to local contextual ranking over the bounded
  installed pool: all commanders, library interactions, role deficits, curve and
  saved intent influence suggestions. Prospective constraints, unmet requirements,
  opportunity costs and coverage remain explicit. Optional EDHREC enrichment
  preserves per-commander metric names, raw scales and freshness without changing
  local scores; current `num_decks` payloads and legacy inclusion are both handled.
  Explicit synergy/inclusion ranks preserve provider browsing. Read-version checks
  and modern/legacy MCP tests cover the changed default.

- Add `analyze_strategy` (52 tools total) for offline analysis of the actual
  command zone and library. Evidence-linked candidate support, resource
  dependencies, bottlenecks, redundancy, recovery, possible package conflicts
  and payoff requirements preserve authored intent and role overrides.
  Reports keep unmodeled interactions and execution uncertainty explicit;
  modern and legacy MCP clients receive the same versioned JSON evidence.

- Add `card_discover` (51 tools total) for local mechanics/theme retrieval and
  validated single or paired commander choices without recommendation providers.
  Results include Oracle evidence, query fallback, identity/intent exclusions,
  deck and extractor versions, snapshot provenance and explicit scan/pair/output
  bounds. Commander validation now rejects duplicate partners, back-face ability
  leakage and noncreature Doctor companions. A 14-task curated recall benchmark
  and modern/legacy MCP HTTP tests cover the new read-only contract.

- Add `meta_check_policy` (50 tools total) and persisted `intent.playgroup`
  declarations for profile goals, bracket restrictions and custom category limits.
  Policy compatibility is independent of legality and deck quality. Reports retain
  hard exclusions, protected quantities and soft objectives with pinned Wizards
  sources, card/package evidence and explicit classification, timing and provider
  uncertainty. Existing decks gain no invented policy; declarations follow normal
  version checks, merge patches, snapshots and durable storage.

- Preserve Commander Spellbook variant status, quantities, starting zones/state,
  commander/face requirements, templates, mana, prerequisites, steps and outputs
  with provider links and explicit missingness. `meta_combos` reports all six
  provider categories, bounded deck applicability, freshness and coverage;
  inventory inclusion never proves execution. Requests preserve saved quantities
  and do not duplicate commanders in the library. Malformed refreshes retain
  stale usable results; cold failures return `UPSTREAM_UNAVAILABLE`. Bracket
  estimates report unresolved/failed combo evidence, only use supported static
  candidates and remain provisional; mana or face uncertainty cannot silently
  become an early-combo claim.

- Add `rules_lookup`, `rules_search`, `rules_refresh` and `card_rulings` (49
  tools total): exact Comprehensive Rules and glossary lookup, bounded keyword
  search and per-card rulings answered verbatim from a versioned local corpus.
  `rules_refresh` is the only network path: it discovers the current release on
  the Wizards rules page (pinned fallback, explicit wizards.com override),
  downloads Scryfall's rulings export, validates both and publishes them
  atomically with URL, digest, effective date and retrieval time; a failed or
  malformed download keeps the previous corpus and reports it stale. Rulings
  separate Wizards rulings from provider notes and report missingness. Unknown
  rule numbers are reported with the nearest existing identifier, never guessed.
- Audit Commander validation against the 2026-08-07 Comprehensive Rules with a
  pinned excerpt and fixture: `Partner—[text]` cards now pair only with the same
  label (702.124i) and a Doctor's companion pairs only with a Time Lord Doctor
  that has no other creature types (702.124m). Eligibility, color identity,
  singleton exemptions and companion checks are verified unchanged.
- Add `card_mechanics` (45 tools total): read-time extraction of a declared
  catalog of triggers, costs, effects and permissions with exact Oracle
  evidence spans, subject and condition, explicit/inferred provenance and
  extractor version; unmodeled and uncertain text is reported, never guessed.
  Shared role evidence overlays deck corrections; legality is never evaluated.
  A 164-case annotated corpus with a pinned holdout gates precision at 0.95.
- Accept the advertised `ci` color-identity query alias. Real host traces exposed
  repeated failures on `ci<=r`; regression tests now execute the server's own
  recovery examples against the index.

- Retain comparative model-driven workflows through Claude Code and Codex CLI,
  with actual MCP traces, independent final-state checks, and observed usage.
  Preserve unsuccessful setup attempts and distinguish these runs from scripted CI.
- Fix Windows ESM native-module imports in process/SDK tests and normalize setup
  path assertions so the supported-platform matrix exercises the same contracts.

- Add `deck_set_roles` (42 tools total): persistent per-deck role replacements,
  empty labels, and reset to classifier defaults, with optimistic version checks.
  Composition, coverage, status gaps, and advisory role consumers use corrections;
  global card data and rules validation remain unchanged.
- Explain EDHREC additions and budget-swap cuts with role/synergy evidence,
  tradeoffs, uncertainty, local price impact, and cache freshness/stale fallback.
  Sort synergy recommendations by score; mark missing metrics and partial budgets.
  Propose one-copy swaps to avoid multiplying singleton replacement quantities.
- Verify public role set/clear/reset through actual MCP process kills, concurrent
  writers, storage failure rollback, snapshots, and modern/older clients.

- Migrate to stable MCP TypeScript SDK 2.0.0, enabling the 2026-07-28 protocol
  over stdio and local HTTP while retaining older-client initialization.
  Preserve the 41 tools, three prompts, annotations, and structured/text results.
- Keep HTTP stateless and isolated per principal; advertise no change streams
  and reject unsupported subscriptions. Persistent stdio supports notifications.
- Exercise modern and older transports, first ingestion, and isolation; add a
  locked Rust rmcp client that checks persistence after process termination.

- Add idempotent `setup` with absolute-path client configuration and read-only
  `doctor` diagnostics for runtime/native SQLite, storage permissions, index
  readiness, and freshness, with actionable exit codes.
- Activate the first successful ingestion in connected stdio and HTTP servers.
  Readiness, indexed tools, resources, and prompts become available without
  restarting; failed or interrupted initial downloads can be retried.
- Exercise setup reruns, non-mutating diagnostics, live first-ingest discovery,
  and interrupted-ingest recovery through the installed package.

- Persist decks, snapshots, and session-scoped collections with synchronous
  SQLite transactions shared across local server processes. Keep optimistic
  version checks and compound deck imports inside the transaction; report
  storage failures without acknowledging uncommitted changes.
- Migrate `decks.json` once with the source preserved, retain automatic user-data
  backups, and add `restore-user-data <backup-path>` for explicit offline
  recovery. Corrupted storage stops startup instead of silently creating an
  empty store.
- Persist per-deck role-override payloads through snapshots and restarts.

- Stage and validate complete card-data snapshots before atomic publication;
  retain previous and interrupted versions for recovery. Coordinate CLI/server
  refreshes across processes and reuse unchanged indexes without rebuilding.
- Prepare live query statements before activation, switch the index and
  `data_snapshot` together, and keep in-flight tool responses on one generation.
  Startup can recover the pointer's explicit previous snapshot.
- Add deterministic failure injection, real process-kill/concurrency checks,
  connected MCP activation checks, and a documented card-data recovery path.

- Add four offline MCP workflow journeys with a retained v0.2.0 protocol baseline,
  measured call/error/result-byte counts, and deterministic regression checks.
  Comparative real-host evidence is retained separately in `docs/evaluation/`.

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
