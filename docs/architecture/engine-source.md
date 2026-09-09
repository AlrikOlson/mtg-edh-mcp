# ADR: canonical engine source and headless worker

Accepted 2026-09-09 for `engine-mvp-source`; follows [the engine charter](../ENGINE-CHARTER.md). The native roadmap owns implementation status.

## Decision and dependency direction

The existing **mtg-game-engine** repository remains the sole production gameplay source. Its `crates/mtg-engine` package owns rules, card behavior, physical objects, payments, RNG, legal decisions and execution. The new `crates/mtg-worker` package lives in that same repository and depends on `../mtg-engine` with `default-features = false`. CLI and desktop already depend on that exact workspace package; no fork, copied modules or TypeScript port is introduced.

MCP's [source pin](../../engine/source.json) identifies the complete canonical Git commit, root Cargo.lock SHA-256, relative worker manifest, package and measured toolchain/target. The engine commit includes both the core repairs and worker. The repository currently has **no configured Git remote**. The repository URL in its Cargo workspace metadata is not treated as a verified retrieval endpoint. A developer supplies the canonical local Git repository or a Git bundle containing the pinned commit. A future verified remote can replace this transfer mechanism without moving ownership.

`engine-mvp-contract` will put the single versioned wire schema in the canonical worker package and generate/check both Rust and TypeScript bindings. It must publish the schema's exact path and generation command with the implementation. There is no simulation protocol in this source integration. `--self-check` is a build probe that initializes the existing two-player core and reports its player count and seed; it does not accept decks, start trials or certify Commander support.

The worker is downstream of the core, never of the CLI or desktop. The existing `GameState::new_seeded` constructor is sufficient for this probe. No desktop setup routine is required or copied. The desktop's `commands/play.rs` preset/name resolution, commander-in-opening-hand setup and snapshot reruns, and the CLI's `build_starter_deck`, are presentation/demo paths. Future four-seat setup, command zones, mulligans and replay must be implemented once in the core (`engine-mvp-multiplayer`, `engine-mvp-commander`, `engine-mvp-mulligans`, `engine-mvp-replay`) and existing consumers adapted where applicable. Do not promote the demo's incorrect Commander setup into the worker.

## Reproducible local source delivery

The canonical changes were committed on the isolated `engine-mvp-source` branch, based on clean `b2d9018`. The original engine main checkout and all its dirty/untracked work remain untouched. MCP's two pre-existing `.claude` edits are excluded from this delivery.

For each cross-repository change:

1. Create an isolated canonical worktree; fix and test reusable behavior there. Keep independent gameplay scenarios in that repository, boundary tests with their adapter.
2. Run the applicable engine and consumer gates and commit the canonical source plus Cargo.lock atomically. Do not pin an uncommitted diff.
3. Advance MCP's source pin to that commit and lock digest. Review the canonical diff and compatibility implications.
4. Build from a separate clean clone at the pin, verify source before and after, inspect the selected dependency graph, run the executable probe and MCP gates, then commit the MCP pin/adapter atomically.
5. Preserve both commits for rollback. A branch is a retention aid; the full commit and digest determine identity. Pushing and npm publication are separate actions; neither is performed here.

Example, from the MCP checkout with `MTG_ENGINE_SOURCE` set to the canonical repository or bundle and an unused `build/engine-clean` destination:

```sh
git clone --no-local --no-checkout "$MTG_ENGINE_SOURCE" build/engine-clean
MTG_ENGINE_REV=$(node -p "require('./engine/source.json').revision")
git -C build/engine-clean checkout --detach "$MTG_ENGINE_REV"
node scripts/check-engine-source.mjs build/engine-clean
CARGO_TARGET_DIR="$PWD/build/engine-target" CARGO_BUILD_JOBS=4 cargo build \
  --manifest-path build/engine-clean/Cargo.toml --locked --offline \
  -p mtg-worker --release --target aarch64-apple-darwin
build/engine-target/aarch64-apple-darwin/release/mtg-worker --self-check
node scripts/check-engine-source.mjs build/engine-clean
```

The source checker is read-only and uses explicit Git argument arrays. It rejects wrong revisions, wrong lock digests, nested paths that merely discover a parent repository, modified/staged/untracked/ignored inputs, and index flags that hide tracked changes. Build output must be outside the source checkout. It does not reset, fetch, checkout, clean or rewrite source. The self-check must run successfully from an empty working directory with no card catalog.

Use Rust/Cargo 1.95.0 and the preregistered macOS arm64 host for this baseline. `--offline` requires a populated dependency cache; a deliberate build-time dependency fetch is permitted when preparing that cache. No runtime catalog download is needed. This is pinned source provenance, not a hermetic toolchain/dependency environment: ambient Cargo configuration and artifact reproducibility remain packaging/release gates.

To transfer offline, the source owner may create a Git bundle containing the integration branch with `git bundle create <bundle-path> engine-mvp-source`. Build from the commit rather than copying an edited source directory. The eventual installed MCP package will contain a qualified native executable and notices, and will not require Rust, Cargo, a GUI or a source checkout. That packaging is owned by `engine-mvp-package`, not this probe.

## Ownership and retirement inventory

Paths in the first column are relative to MCP unless prefixed `engine:`.

| Existing path / consumers                                                                                                                         | Authority and disposition                                                                                                                                                                                                                                                                          | Required milestone                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `src/analyze/manaModel.ts` cost/source parsers and payment witnesses; `manaSequence.ts` payment search, physical-zone/turn transitions and replay | Freeze new behavior. Rust becomes the only executing owner when qualified; delete overlapping production implementations.                                                                                                                                                                          | `engine-mvp-decisions`, `engine-mvp-lands`, atomic `engine-mvp-cutover`                        |
| `src/analyze/sim.ts` mulberry32 RNG, shuffle, aggregate and sequence trials; `src/server/analyzeTools.ts` `simulate_deck`                         | Switch both public modes to engine evidence, keep reporting only, reject unsupported behavior and worker errors without fallback.                                                                                                                                                                  | `engine-mvp-cutover`                                                                           |
| `src/server/index.ts`, `src/analyze/index.ts` public model/parser/solver exports; `src/analyze/mana.ts` and `analyze_mana_base` model consumers   | Remove or adapt these indirect public consumers in the same cutover. Static source counts may remain explicitly advisory; they cannot certify payment/runtime support.                                                                                                                             | `engine-mvp-cutover`, packaged entrypoint gate at release                                      |
| `src/index/refresh.ts`, `src/ingest/store.ts`, `src/server/cardData.ts`, `src/index/cardIndex.ts`, `src/index/map.ts`; shared CLI/MCP ingestion   | MCP owns Oracle identity, faces, text, snapshots and refresh. Capture exact job definitions under existing read boundaries, digest and retain them. Snapshot date/path alone is insufficient: exported `refreshPrices` can mutate printings within a version.                                      | `engine-mvp-catalog`, retention with `engine-mvp-replay`                                       |
| `engine:cards/bulk_download.rs`, `scryfall.rs`, `registry.rs`, desktop/CLI download features                                                      | Downloader is feature-disabled for the worker. Use the registry only as an index over supplied immutable definitions; no live lookup, identity substitution or independent refresh in jobs. Existing standalone UI/CLI onboarding stays outside the MCP job boundary and must adapt if integrated. | `engine-mvp-catalog`; feature graph checked here and at packaging                              |
| `src/validate/{coreRules,commanderRules,companionRules}.ts`; validate tools, deck plans, vitals, recommendations                                  | Existing MCP services remain construction legality/policy authority. Admission composes that verdict with separate engine runtime support; it never reruns a second construction validator.                                                                                                        | `engine-mvp-catalog`, `engine-mvp-coverage`, `engine-mvp-mcp-workflow`                         |
| `engine:cards/deck_validator.rs`, `format.rs`, `banlist.rs`, `brackets.rs`, `format_plugin*.rs` and prelude exports                               | Existing standalone construction verdicts are not called by the worker. Before integrating those consumers into the MCP product, adapt them to the MCP verdict and retire overlapping Commander authority; name/identity resolution must not imply construction approval.                          | `engine-mvp-coverage`, confirm no duplicate integrated verdict at `engine-mvp-cutover`/release |
| `src/analyze/mechanics.ts`, strategy/discovery/recommendation consumers; engine heuristic `cards/coverage.rs`                                     | MCP annotations remain static evidence. Neither a parsed keyword nor engine heuristic coverage admits complete runtime behavior. Core clause support and independent scenarios own admission.                                                                                                      | `engine-mvp-coverage`, `engine-mvp-corpus`                                                     |
| `src/deck/{deckStore,deckPlan,intent,playgroupPolicy}.ts`, `src/storage/{userData,driver}.ts`, collection/pricing services                        | Reuse authored deck versions, reviewed plans, principals, transactional storage and undo. Jobs capture immutable inputs, never mutate authored state; do not duplicate collection or price storage.                                                                                                | `engine-mvp-supervision`, `engine-mvp-mcp-workflow`, `engine-mvp-deck-evidence`                |

This explicitly allows the charter's temporary qualification phase: legacy public TS routes retain their existing owner while the internal Rust path is developed. The cutover switches routes and removes overlapping production truth together. No fallback is added.

## Acceptance and limits

The source commit repairs four doctest import errors, funds the resolution example's real `{1}{G}` payment, and replaces the descending comparator with stable `sort_by_key(Reverse(score))`. It does not waive mana costs, expose private modules or change equal-score ordering. Independent review checked these properties.

Recorded scoped gates cover core/worker check, unit/integration tests, all documentation tests, Rust formatting, strict Clippy with pedantic warnings denied, CLI compilation and clean-clone worker build. MCP's standard test command includes the source-checker regression suite and the existing real MCP transport/client tests. No new public MCP route exists in this chunk. Desktop GUI build/rendering, complete fixed-corpus support, protocol conformance, four-player gameplay, replay/resume, installed native packaging and performance qualification remain their declared downstream acceptance obligations.

The canonical workspace declares MIT licensing; retain its source history and declarations. Native dependency licenses and required distributed notices must be collected with the executable in `engine-mvp-package`; the current MCP package does not yet include this worker binary.

Primary references: [Cargo dependency sources](https://doc.rust-lang.org/cargo/reference/specifying-dependencies.html), [Cargo feature selection](https://doc.rust-lang.org/cargo/reference/features.html), [Git porcelain status](https://git-scm.com/docs/git-status), [Rust stable key sorting](https://doc.rust-lang.org/std/primitive.slice.html#method.sort_by_key).
