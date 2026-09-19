# Catalog objects: the captured deck bound to physical Commander objects

Accepted for `engine-mvp-catalog-objects` under the [engine charter](../ENGINE-CHARTER.md). It is the dependency-aware split of the physical acceptance of [immutable catalog transfer](engine-catalog.md) (`think:300`), delivered after [deterministic canonical setup](engine-preview-setup.md), [exact core state](engine-state.md) and [Commander play](engine-mvp-commander.md). The research finding and plan are `think:407`; the implementation findings are `think:408`. Native Magistr records hold execution status.

The [source pin](../../engine/source.json) advances to canonical `mtg-game-engine` commit `84a73043f1f7034471e49098bb1533cc904a9a14` on `main`. The root `Cargo.lock` and every generated contract derivative except the synced README are byte-identical; the worker contract schema is unchanged.

## Scope

When this unit started, the owners it depends on had already delivered most of its original acceptance: `setup::build_game` allocates seats and copies through the checkpointed `IdentityAllocator` from shared `Arc<CardDefinition>` blueprints and returns a `PhysicalCard` inventory that keeps Oracle, printing and physical identity distinct; the integrated mirror pod proves four owners keep independent tax, damage totals, command-zone offers, counters and land drops; the worker binds a Commander scenario's 400 `physical_id`s to the captured deck, refuses identity, digest and zone mismatches before allocation and qualifies every card through `cards::support`; the catalog round trip preserves faces and digests. What remained is what this unit delivers: the correspondence between the adapter's physical cards and the engine's objects, the one allocation seam for tokens, and a 400-object proof at real deck size.

## What was delivered

| Owner or consumer                                                       | Before                                                              | Now                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setup::CardBlueprint` and `setup::PhysicalCard`                        | Oracle identity, printing and allocated `CardId` only               | carry the admitting adapter's `physical_id` (the worker scenario's), so `PreparedGame.inventory` is the one correspondence between scenario cards and engine objects; `PreparedGame::physical_by_label` and `physical_of` read it. A label used twice in one pod is refused as `setup_physical_label_duplicate` in `validate_seats`, before any identity is allocated; unlabelled copies carry no constraint    |
| `GameState::create_token` (new)                                         | `CardId::new()` read OS entropy; no production path created a token | the one token seam: allocates the token's `CardId` from the checkpointed allocator, builds through `CardBuilder::id().token()` and enters through the checked zone path (CR 111.2); identical states create identical tokens, in independent processes and after an exact restore; a token is never in the inventory and ceases to exist off the battlefield through the existing state-based owner (CR 704.5d) |
| `mtg_worker::commander::seats`                                          | dropped the scenario `physical_id` when translating a seat          | carries each `CardInstance`'s `physical_id` into its blueprint; admission behavior is unchanged (`starting_procedure_unavailable` after translation)                                                                                                                                                                                                                                                            |
| worker protocol README                                                  | stage 5 described the blueprint only                                | documents the inventory correspondence and the setup owner's own duplicate refusal after the binding stage's                                                                                                                                                                                                                                                                                                    |
| the internal fixture path, eight engine suites, the desktop's blueprint | built `CardBlueprint` literals                                      | carry no label (`physical_id: None`); nothing else about them changed                                                                                                                                                                                                                                                                                                                                           |

## Ownership and reuse review

- **One owner for the mapping.** The setup owner already produced the inventory; carrying the adapter's label there means diagnostics and replay read one record instead of a worker-side manifest reconciled against it. The worker translates and never decides a rule; MCP keeps construction legality.
- **One allocator for every identity.** Players, physical cards and stack objects were already allocated from the checkpointed stream; tokens now are too, before any effect creates one. Future token and copy effects must call `create_token` and never `CardId::new()`.
- **Refusal before allocation.** The label check joins the seat-count, seat-identity and Commander checks in `validate_seats`, so a bad pod allocates nothing. The worker's binding stage refuses a repeated `physical_id` first; the setup owner refusing it again is the owner of the inventory protecting its own invariant, not a second validator of the scenario.
- **Left with their recorded owners.** `Card::color_identity` is still derived from the mana cost because the factory never passes the definition's identity; pending `engine-layers-printed-colors` records that fixing the factory alone would turn colorless lands with a colored identity into colored objects in the layers owner, so this unit did not touch the factory. The Commander rules read the supplied identity from the designation, which the new suite proves on a `{4}` commander with a `B G U` identity. Runtime `Card` carries no faces (owned by `engine-any-layouts-special-actions` and `mcp-catalog-face-inventory`); face data survives on the shared definition every copy is built from and reaches through its Oracle identity.
- **Overlap.** None added. No TypeScript gameplay, no construction rule, no contract schema change.

## Rules basis

From the engine's retained Comprehensive Rules snapshot: 100.2 (a deck is a collection of physical cards), 400.7 (an object that changes zones becomes a new object; its physical identity does not), 903.3 and 903.4a (the designation and the established identity are attributes of the card), 903.6 and 903.7 (command zone, 40 life), 111.2 (a token is created by an effect and is not a card in a deck), 704.5d (a token not on the battlefield ceases to exist).

## Evidence

### Engine

`crates/mtg-engine/tests/catalog_objects.rs`, written first and red until the owners existed: a four-seat pod of one commander plus 99 library cards from seven shared definitions (three basic lands, a creature, a transforming double-faced card, an artifact and the commander), every copy labelled.

1. 400 distinct physical instances with distinct labels, 100 owned per seat, the commander in the command zone and the library in declared order, Oracle, printing and physical identity distinct on every entry (128 Forests from one definition are 128 objects), the double-faced definition's two faces reachable through the copies' Oracle identity.
2. Every owner's designation carries the supplied `B G U` identity of a `{4}` commander, at 40 life, with no tax.
3. A label reused across seats or within a seat is refused as `setup_physical_label_duplicate`; an unlabelled pod builds with no labels.
4. Copies of one definition keep independent zone, tap, counter and damage state and share one `Arc`.
5. A move keeps `CardId` and label while the zone incarnation changes; the inventory records the starting zone.
6. Tokens: identical states allocate identical token identities; the token is outside the inventory, owned, on the battlefield, distinct from the next token; moved to a graveyard it ceases to exist through the state-based owner while every captured card remains.
7. Identical inputs give identical inventories, seats and hashes; another seed changes every identity and the hash but nothing else in the inventory.
8. After moves, counters, a commander on the battlefield and a token, the state survives an exact restore with every labelled card resolvable to its owner and the allocator cursor continued (the restored and the original state allocate the same next token).

### Worker

`crates/mtg-worker/tests/commander.rs`: the seat translation carries each scenario card's `physical_id`; a new test builds the translated pod through `build_game` and maps all 400 scenario ids to distinct engine ids with the scenario's seat, owner, Oracle identity, printing, starting zone and library position, one id per scenario card.

### Mutation evidence

`cargo-mutants` 27.1.0 over the unit's diff, on copies of the tree, one job at a time. Engine diff (`setup.rs`, `game_state.rs`) with the catalog-objects, commander-play, preview-setup and commander-setup suites: 13 mutants, 8 caught, 5 unviable, 0 missed, 0 timeouts. Worker diff (`commander.rs`) with the commander suite: 4 mutants, 2 caught, 2 unviable, 0 missed.

### Gates

Recorded on engine `main`, green on the first run: workspace check with all targets including the desktop crate, Clippy with pedantic warnings denied, rustfmt, 1,870 tests (nine new; 3 pre-existing skips) plus doctests. On the pin task: clean-clone identity before and after the locked offline arm64 release worker build, the empty-directory self-check, contract sync and check (only the manifest's source revision and the synced README change; the schema hash is unchanged), 153 native MCP tests against the clean-clone binary including the real MCP engine tool, the 13-test evidence requalification run in the clean clone, and the census check. On the MCP verification task: tsc, `npm test` and eslint with Prettier.

## Evidence update

The served snapshot did not move; the ledger is byte-identical. The first update run, read before anything else, reported the engine changed, the owner-less `engine_revision` unit for the three `intrinsic-basic-mana` rows, and the already-owned `baseline_corpus` unit. The generated files were restored from Git, the basic-mana evidence was re-run in the clean clone at the pin (13 tests), `CORE_SUPPORT_REVISION` was re-pinned, and the update and binding runs wrote the committed [requalification record](../evaluation/engine-any/requalification-v1.json) with the engine same and only the owned `baseline_corpus` unit open.

## The MCP construction consolidation, split before implementation

The chunk also asked that, before gameplay admission of a real deck, the MCP construction paths and the public core-rule validator be consolidated, and that Commander eligibility be audited in the existing MCP authority. Research (`think:407`) found the eligibility audit largely present: `src/evaluation/rulesAudit.ts` already audits CR 903.3 (creature, Vehicle, Spacecraft with a power/toughness box), 903.3a, every 702.124 partner kind, background and Doctor's companion pairings and the data-driven banlist against the frozen 20260819 excerpt, and bounded copies were consolidated in [rules evidence maintenance](engine-evolution-rules-evidence.md). The remaining divergences are real, independent TypeScript work that touches public `validate_deck` output, so they are filed as the pending chunk `mcp-construction-authority-consolidation`, a dependency of `engine-mvp-worker`, rather than folded into this engine unit:

- `validateDeck` accepts a card whose Commander legality is `not_legal` (only `banned` is a violation) while `deckPlan`, `deck/construction` and `build/construction` refuse it as `FORMAT_ILLEGAL`.
- `validateDeck` accepts a commander that also appears in the 99 and a companion inside the deck: `checkSingleton` inspects only entries with quantity above one, and `validateCompanion` skips the companion's own identity; the construction paths report `COMMANDER_LIBRARY_OVERLAP` and `COMPANION_DECK_OVERLAP`.
- An unmodeled or heuristic companion passes `validateDeck` silently, while three private copies of a companion-unknown predicate (in `deckPlan.ts`, `deck/construction.ts` and `build/construction.ts`) mark it `COMPANION_CONDITION_UNRESOLVED`.
- Eligibility of a legendary planeswalker that is a creature card in every zone but the battlefield is not represented; the audit has no case for it.

## Limits

- No real Commander deck can be admitted or run until the qualifier supports whole cards (`engine-mvp-corpus`, `engine-mvp-support-runtime`) and the starting procedure exists (`engine-mvp-mulligans`); the 400-object proof through the worker uses test-built definitions in place of the qualifier's output, as the seat translation test did before it.
- No effect creates a token yet; `create_token` is the seam they must use.
- `Card::color_identity` on runtime objects is still mana-cost derived (`engine-layers-printed-colors`); runtime cards carry no faces (`engine-any-layouts-special-actions`).
- The inventory records each card's starting zone and position; current zones are the zone owner's.
