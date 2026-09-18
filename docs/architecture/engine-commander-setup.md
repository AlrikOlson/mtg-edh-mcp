# Commander setup: designation, established identity and the command zone

Accepted for `engine-commander-setup` under the [engine charter](../ENGINE-CHARTER.md). It is the first of five units split out of `engine-mvp-commander`; the sizing and split are `think:386`, the research finding and plan are `think:387`. Native Magistr records hold execution status.

The [source pin](../../engine/source.json) advances to canonical `mtg-game-engine` commit `9175f4e19720e69a990114f005679f77816a5716` on `main`. The root `Cargo.lock`, the worker protocol and every generated contract derivative are byte-identical; only the manifest's source revision changes.

## Why the parent was split

The core had no Commander state of any kind: `Zone::Command` existed, and nothing else. "Implement Commander play" bundled six independent rule owners (designation and setup, command casting and tax, zone-return choices, commander damage, identity-bound mana, consumer migration). Each of the middle four depends only on the designation and is independently testable against a four-owner mirror pod, so they are now separate pending units. The parent keeps the desktop commander-in-hand migration, runtime variant rejection, worker Commander admission and the integrated mirror-pod acceptance, and depends on all five.

## What was delivered

| Owner or consumer                      | Before                     | Now                                                                                                                                                                                                                                                                           |
| -------------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mtg_engine::commander`                | did not exist              | `CommanderRegistry` on `GameState`: one `CommanderDesignation { card, owner, color_identity }` per designated physical card, in designation order, a duplicate refused. Reads: `is_commander`, `designation`, `commanders_of`, `color_identity_of`. Mutation is crate-private |
| `CommanderRegistry::color_identity_of` | did not exist              | the union of the owner's designations; `None` when the player has no commander, which is the undefined quality of CR 903.4f and distinct from an empty identity                                                                                                               |
| `setup::SeatBlueprint`                 | name, life, hand, library  | adds `commander: Option<CardBlueprint>`; `SeatBlueprint::commander(..)` builds a Commander seat at 40 life                                                                                                                                                                    |
| `setup::build_game`                    | placed hand and library    | allocates a seat's commander first, places it in the command zone with a manifest row, and designates it with the identity of the catalog definition. Games without commanders allocate and place exactly as before                                                           |
| `setup::validate_seats`                | seat count and names       | also refuses a pod where only some seats have a commander (`setup_commander_missing`) and a Commander seat not at 40 life (`setup_commander_life`)                                                                                                                            |
| `elimination::leave_game`              | removed the leaver's cards | also drops the leaver's designations. A finished game keeps its final position, as before                                                                                                                                                                                     |
| `snapshot::CORE_SNAPSHOT_VERSION`      | 8                          | 9, because a serialized field was added. The registry is an ordered list, so the snapshot's list of hash sets did not grow. Nothing in the worker contract or MCP reads the version                                                                                           |

## Ownership and reuse review

- **One owner of the fact.** CR 903.3 makes the designation an attribute of the card, kept in every zone. The engine's physical card identity already persists across zone changes, so the registry is keyed by it and needs no zone-change hook. Only setup designates and only the leave-the-game owner removes; every later Commander rule (tax, zone return, damage, identity-bound mana) reads this registry and must not keep its own notion of "is a commander".
- **Identity source.** CR 903.4 includes rules-text symbols and every face; 903.4a fixes the identity as the game begins. The catalog record's `color_identity` is that value and is what MCP's construction authority already validates against, so setup copies it once into the designation. It is deliberately not read from `Card::color_identity`: the card factory never passes the catalog identity to the card builder, so that accessor is derived from the mana cost alone. The fixture commander costs `{2}{G}` with a `{U}` activation and proves the difference.
- **Reuse.** Placement goes through the existing checked `try_add_card_owned` path and identity allocator; the manifest row is the existing `PhysicalCard`. Removal rides the existing `leave_game` loop. No second setup path and no TypeScript gameplay logic.
- **Consumers.** `SeatBlueprint` literals in seven integration suites, two search-agent unit tests and `prepare_preview_game` gained `commander: None`; no other existing test changed. The worker still answers `commander_preflight_unavailable` and `commander_admission_unavailable`, and the desktop still deals its commander into the hand; both are the parent's migration.
- **Overlap to remove.** The desktop's `commander_in_hand` setup in `apps/desktop/src-tauri/src/commands/play.rs` is the duplicate path; its removal milestone is `engine-mvp-commander`.

## Rules basis

From the engine's retained Comprehensive Rules snapshot (`crates/mtg-engine/src/cards/support/preview_sources/comprehensive-rules.txt`): 903.3 (designation is an attribute of the card and is retained across zones), 903.4 and 903.4a (identity and when it is established), 903.4f (undefined without a commander), 903.6 (face up in the command zone before the rest becomes the library), 903.7 (40 life, hand of seven), 800.4a (a leaving player's objects leave the game).

## Evidence

`crates/mtg-engine/tests/commander_setup.rs`, written first against compile-level stubs: ten of eleven failed on behavior and the no-commander control passed.

1. Identical commanders are designated once per owner at two and four seats, as distinct physical cards.
2. A commander starts in the command zone, apart from a seven-card hand and the library, at 40 life, with a command-zone manifest row.
3. The identity is the catalog identity, not the mana cost.
4. An empty identity is defined and differs from having no commander.
5. A game without commanders has no designation, an undefined identity and today's life total.
6. An identical copy in the same deck is not a commander.
7. The designation and identity follow the card through battlefield, graveyard, exile, hand, library and back to the command zone.
8. Designations are in the versioned canonical bytes, survive restore, and change the state hash.
9. A leaving player takes their commander and its designation; the other three keep theirs.
10. Setup refuses a pod where only some seats have a commander.
11. Setup refuses a Commander seat that does not start at 40 life.

Eight mutants, each applied alone and restored byte for byte (SHA-256), all caught: identity from the cost-derived card, designation kept on leaving, undefined identity reported as empty, life check removed, missing-commander check removed, designation skipped in serialization, leaving clears every designation, commander also dealt into the hand.

Recorded gates on engine `main`: workspace check with all targets including the desktop crate, Clippy with pedantic warnings denied, rustfmt, 1,776 tests (3 pre-existing skips) plus doctests. On the pin task: clean-clone identity before and after the locked offline arm64 release worker build, the empty-directory self-check, contract sync and check, 152 native MCP tests against the clean-clone binary (unchanged: the preview never names a commander), and the 13-test evidence requalification run in the clean clone.

## Evidence update

The served snapshot did not move; the ledger is byte-identical. The first update run, read before anything else, reported the engine changed, the owner-less `engine_revision` unit for the three `intrinsic-basic-mana` rows, and the already-owned `baseline_corpus` unit. The generated files were restored from Git, the basic-mana evidence was re-run in the clean clone at the pin, `CORE_SUPPORT_REVISION` was re-pinned, and the binding run wrote the committed [requalification record](../evaluation/engine-any/requalification-v1.json) with the engine same and only the owned `baseline_corpus` unit open.

## Limits

- `build_game` takes the hand it is given. Drawing seven, shuffling and mulligans stay with `engine-mvp-mulligans`; this unit proves only that the commander is apart from a seven-card hand.
- One commander per seat is admitted. The registry can hold several designations per owner, and `color_identity_of` already unions them, but partner, background, companion and Brawl semantics are not claimed; the parent decides which variants are rejected at runtime and successor any-deck work owns the rest.
- 903.4b (a color chosen before the game) is not represented; the established identity is the catalog record's.
- Nothing is castable from the command zone, no tax exists, no zone-return choice is offered, no commander damage is tracked and no mana source reads the identity yet. Those are `engine-commander-cast-tax`, `engine-commander-zone-return`, `engine-commander-damage` and `engine-commander-identity-mana`.
- Found while grounding: `DerivedCharacteristics::from_card` seeds an object's colors from `Card::color_identity`, which conflates two characteristics and only works today because the factory drops the catalog identity. Filed as `engine-layers-printed-colors`, a dependency of `engine-mvp-layers`.
