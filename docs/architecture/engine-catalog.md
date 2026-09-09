# ADR: immutable catalog transfer

Accepted 2026-09-09 for `engine-mvp-catalog`, under the
[engine charter](../ENGINE-CHARTER.md) and [generated contract](engine-contract.md).

## Delivered boundary

MCP captures the session's authored deck from `DeckStore` inside a synchronous
`CardIndex.withRead` transaction. It checks the expected deck version and actual
index revision, reads the served `SnapshotProvider`, and rejects a deck whose
snapshot label differs. The server must inject its paired index/provider;
a label or digest is provenance, never an authorization credential. The same
server activation mechanism owns their atomic swap. A later job supervisor must
retain the captured bytes and acquire inputs from these same services.

Capture reads each referenced Oracle record once, including commanders and an
optional companion outside the library. It keeps quantities and chosen printing
identities separate from Oracle identities. Generated schemas preserve source
characteristics, supplied color identity, ordered faces and paths, nulls,
Unicode, fractional mana values and related printing links. The frozen corpus
exposed Scryfall's retained related-card `object` tag, which is now explicitly
modeled without changing ingestion or the baseline.

Missing source, stale metadata, malformed fields and printing ownership errors
reject. Successful capture runs the same `validateDeck` composition used by the
public `validate_deck` tool and deck-plan legality: the existing core, commander
and companion modules still own their decisions. Errors reject capture; existing
warnings are retained. This is the public construction gate, not a claim that
all construction uncertainty or gameplay support has been resolved.

The generated envelope contains the exact UTF-8 JSON payload, its SHA-256 and
expected index/deck/version binding. All envelope fields are scalars and the
returned envelope is frozen. Rust `VerifiedCatalog` verifies the digest over
received bytes, generated shapes, binding and referential integrity, then
shares private immutable data through `Arc`. The `catalog_check` reply returns
the original envelope. Rust neither revalidates Commander construction nor
allocates a game. The worker performs no catalog lookup, download or price query.

## Ownership and remaining integration

| Decision or representation             | Owner and disposition                                                                                                                                                                                             |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canonical card/source/printing data    | MCP ingestion and CardIndex; worker receives a generated transport projection.                                                                                                                                    |
| Authored deck, session and version     | MCP DeckStore; captured reads never mutate it.                                                                                                                                                                    |
| Whole-deck construction verdict        | MCP validateDeck composes existing rules; public tool, deck plan and capture share it.                                                                                                                            |
| Extra construction diagnostics         | Existing deckPlan/construction guards remain. Consolidate their bounded-copy, format/overlap and companion uncertainty differences before enabling play in catalog-objects. Do not implement those rules in Rust. |
| Transfer schema and validation         | Canonical worker contract generator; MCP copies are checked derivatives. Rust integrity checks decide no gameplay rule.                                                                                           |
| Physical state and executable behavior | Existing Rust core; catalog-objects must use GameState, ZoneManager, factory and Commander history after their prerequisites.                                                                                     |
| Rust construction APIs                 | Core deck_validator and FormatChecker/plugin paths remain for existing engine consumers. Never call them on the MCP admission path; adapt any overlapping setup consumer before worker execution.                 |
| CLI starter state / desktop setup      | Existing consumers, not worker prerequisites. Extract shared setup into core during catalog-objects; the CLI's starter CardBuilder demo is not a catalog adapter.                                                 |
| Legacy TypeScript simulation           | Frozen until engine-mvp-cutover switches routes and deletes overlap atomically, as recorded in engine-source.                                                                                                     |

The original four-seat, 400-object acceptance needs state and Commander history
that do not yet exist in the pinned core. Before implementation, native
`think:300` split that acceptance into backlog `engine-mvp-catalog-objects`,
dependent on catalog, state and commander. Worker execution now depends on that
split. The original independent ownership, command history, per-object usage,
moves, tokens and face identity requirements remain mandatory. No physical
setup or gameplay admission is claimed here; all four capability flags remain false.

## Evidence and reproduction

Canonical source commits are `3eb027584d54a41ea6f5e02c2a52425a6b47ee24`
and `8b5e05490d25c8efb04846df38e7887e130bd691` (the final pin).
The original dirty engine checkout was preserved. A separate clean clone at the
pin passed source/lock verification before and after the macOS arm64 release build.

Recorded checks cover:

- All 77 frozen gameplay records through SQLite capture and the real Rust worker,
  preserving every source value. The test installation supplies legalities only
  as fixture metadata; it does not establish a new real-deck legality baseline.
- Concurrent SQLite commits, stale stored deck versions, foreign sessions,
  changed snapshot labels, missing cards, printing mismatches and malformed source.
- Twelve tampered/rehashed catalog variants followed by successful recovery,
  ordered multiface data, Unicode, explicit nulls and finite fractional values.
- Real MCP `validate_deck` parity for accepted and rejected construction.
- Canonical worker/core tests, generator drift tests, strict worker Clippy,
  clean native build and all recorded MCP typecheck/test/lint gates.

Reproduce from a clean canonical checkout obtained using [engine-source](engine-source.md):

```sh
node scripts/engine-contract.mjs --check build/engine-mvp-catalog-clean
CARGO_TARGET_DIR="$PWD/build/engine-mvp-native-target" cargo build --manifest-path build/engine-mvp-catalog-clean/Cargo.toml --locked --offline -p mtg-worker --release --target aarch64-apple-darwin
MTG_WORKER_BINARY="$PWD/build/engine-mvp-native-target/aarch64-apple-darwin/release/mtg-worker" npx vitest run src/engine/catalog.test.ts src/engine/workerProtocol.test.ts
```

Offline building assumes the locked crates are already cached. The six native
tests require the explicit binary path; ordinary MCP tests skip them. Operational
limits include a 1 MiB payload string, 2 MiB frame, 32 KiB source text field,
16 faces per record and 1,000 total supplied copies. These are transfer limits,
not Commander rules or runtime performance qualification.

The source boundary follows Scryfall's separate
[card identities](https://github.com/scryfall/api-types/blob/main/src/objects/Card/CardFields.ts)
and [face data](https://github.com/scryfall/api-types/blob/main/src/objects/Card/CardFace.ts).
Rust's [Arc](https://doc.rust-lang.org/std/sync/struct.Arc.html) supports immutable
sharing; required nullable fields use explicit
[Serde deserialization](https://serde.rs/field-attrs.html) to distinguish missing
required source from supplied null. Optional wire metadata can normalize when
reserialized, but the original payload bytes are always retained.
