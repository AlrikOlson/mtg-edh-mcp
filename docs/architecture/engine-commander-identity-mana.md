# Identity-bound mana: Command Tower and Arcane Signet

Accepted for `engine-commander-identity-mana` under the [engine charter](../ENGINE-CHARTER.md). It is the last of the five Commander rule units split out of `engine-mvp-commander`. The research finding and plan are `think:401` and the implementation finding is `think:402`. Native Magistr records hold execution status.

The [source pin](../../engine/source.json) advances to canonical `mtg-game-engine` commit `d078572d92b1e7681a99f9b2b47e433f88ff6087` on `main`. The root `Cargo.lock`, the worker protocol and every generated contract derivative are byte-identical; only the manifest's source revision changes.

## Scope

CR 903.4a and 903.4f: an ability that refers to a commander's color identity uses the identity established for that card as the game began, wherever the card is; for a player with no commander the quality is undefined and that part of the ability does nothing. Research found that the mana context owner already computes grounded contextual output for Reflecting Pool and Exotic Orchard style sources from the source's layer-derived controller, and that the Commander registry already answers `color_identity_of` with `None` for no commander and `Some(empty)` for an empty identity, but that nothing in mana read it. The MCP mana-source fixtures stood in for the two cards with an Opulent Palace that offered black, green and blue, and the coverage record still named `engine-mvp-commander` as an owner of both cards.

## What was delivered

| Owner or consumer                              | Before                                                      | Now                                                                                                                                                                                                                      |
| ---------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mana::context::ContextualMana`                | `ControlledLandTypes`, `OpponentLandColors`                 | also `CommanderIdentity`: one mana of any color in the controller's commander's established identity                                                                                                                     |
| `mana::context::grounded_bits`                 | scanned lands for both kinds                                | dispatches by kind: the two land kinds through `land_bits(opponents)`, the identity through `identity_bits`, which reads `CommanderRegistry::color_identity_of(controller)` and nothing else                             |
| `mana::context::potential_types`               | grounded contextual sources from each other                 | passes the state, so a `ControlledLandTypes` source sees the identity colors a Tower could add, and loses them when the Tower changes controller                                                                         |
| `CommanderRegistry::color_identity_of`         | no consumer in mana                                         | the one source of the identity; `None` (no commander) and `Some(empty)` both produce no bits, never colorless (CR 903.4f, 106.5)                                                                                         |
| `tests/mana_source_fixtures.rs` (test adapter) | a two-player `GameState::new_seeded`                        | a case may declare `commander_identity`; the harness then builds the state through `build_game` with a catalog-defined commander per seat whose identity is that list, so the identity is established by the setup owner |
| MCP fixture suite and coverage record          | Command Tower and Arcane Signet pointed at BGU Palace cases | twelve `commander-identity-*` cases; the two rows reference only those and carry one `engine-mvp-lands` binding each; the `engine-mvp-commander` bindings are closed                                                     |
| `snapshot::CORE_SNAPSHOT_VERSION`              | 13                                                          | 13. No serialized field was added; the identity was already canonical state                                                                                                                                              |

## Ownership and reuse review

- **One decision point for every identity-dependent source.** The identity is read inside the existing grounded-output owner, at the same place Reflecting Pool and Exotic Orchard resolve, so activation, payment planning, the post-cost menu and restore all go through the one path with no new consumer. Putting the read into the card factory or the payment planner was rejected: both would have made a second place that decides what a source can produce.
- **The controller's identity, from the designation owner.** `source_modes` already resolves the source's layer-derived controller; "your commander" is that player (CR 903.3e), which is why a stolen Tower reads the thief's identity. The identity itself is keyed by card in the registry, so zone changes and control changes of the commander cannot affect it (CR 903.3, 903.4a), and nothing is inferred from printed colors, mana cost, controlled lands, the mana pool or ownership.
- **No new state.** The registry established the identity in `engine-commander-setup`; this unit only reads it. The snapshot version is unchanged.
- **The fixture identity is real.** `CommanderRegistry::designate` is crate-private, so the harness cannot designate a card by hand; it goes through `build_game` with a `SeatBlueprint::commander`, the production setup path. An MCP fixture therefore supplies the catalog identity of a commander, not a list of mana outputs.
- **Overlap.** None added. The Oracle-text binding of the two cards (the card factory emitting `ManaAbility::Contextual`) stays with `engine-mvp-lands`; the worker's Commander admission and the desktop's commander-in-hand setup stay with `engine-mvp-commander`.

## Rules basis

From the engine's retained Comprehensive Rules snapshot (`crates/mtg-engine/src/cards/support/preview_sources/comprehensive-rules.txt`): 903.4 and 903.4a (identity from mana cost and rules text, established as the game began and used by any effect that refers to it), 903.4f (undefined without a commander; that part does nothing), 106.5 (mana of an undefined type is not produced), 106.7 (what a permanent could produce is read from its abilities as they would resolve now), 903.3 (the designation belongs to the card in every zone) and 903.3e ("your commander" is found by the player the ability refers to).

## Evidence

`crates/mtg-engine/tests/commander_identity_mana.rs`, written first against a compile-level stub whose identity arm counted nothing: 6 of 8 failed on behavior and the two negative controls passed.

1. A Tower-like land and a Signet-like artifact add exactly blue and green for a commander whose printed color and cost are green and whose rules text adds blue; white, black, red and colorless are rejected; one activation adds one unit; a tapped source cannot activate again.
2. The domain is the same with the commander in the command zone, on the battlefield, in the graveyard, in exile, in the hand and in the library.
3. An empty identity taps the source for no mana and no production event.
4. A player with no commander gets nothing from the source; the tap cost is still paid.
5. The identity is not inferred from a controlled green land, blue mana in the pool or the Tower's owner; a stolen Tower reads the thief's red identity and its owner cannot activate it.
6. Four seats with GU, R, empty and WB identities keep them apart.
7. A `ControlledLandTypes` source sees the identity colors the Tower could add and loses them when the Tower is stolen.
8. Planning leaves canonical bytes unchanged and the plan survives a restore.

The [MCP fixtures](../evaluation/engine-mvp/mana-source-fixtures-v1.json) add twelve independent cases: a choice within a BGU identity; red, white and colorless rejected; one unit per activation; a tapped Tower; a Signet-like artifact tapping immediately; Tower plus Signet paying `{G}{U}`; a controlled Island not extending a green identity to `{U}{U}` while `{G}{U}` across both sources pays; an empty identity; no commander. All 48 cases pass in the clean clone at the pin. The static `engineManaSources.test.ts` requires the new ids, asserts that every identity-bound case declares its identity (including an empty and an undefined one) and supplies no output list, and that the two cards carry no `engine-mvp-commander` binding.

### Mutation evidence

`cargo-mutants` 27.1.0 over the unit's diff, on copies of the tree, with the identity, context, contextual-cost, opponents and selected-costs suites: 15 mutants in 3 minutes: 13 caught, 1 unviable, no timeouts and 1 missed. The miss replaced `|` with `^` in the identity fold, which is equivalent from a zero accumulator over distinct bits. A first run with two parallel jobs and one shared `CARGO_TARGET_DIR` reported two misses on that line; the copies had raced on one binary directory, and the same diff run sequentially caught the real one. The rule is recorded on pending `engine-mutation-testing-practice`.

### Gates

Recorded on engine `main`: workspace check with all targets including the desktop crate, Clippy with pedantic warnings denied (the first run failed only on rustfmt line wrapping in the new scenario file, which was formatted), rustfmt, 1,846 tests (3 pre-existing skips) plus doctests. No existing test changed. On the pin task: clean-clone identity before and after the locked offline arm64 release worker build, the empty-directory self-check, contract sync and check, 152 native MCP tests against the clean-clone binary (unchanged: the preview never names a commander), the 13-test evidence requalification run in the clean clone, and the census check. On the MCP verification task: tsc, `npm test` (29 pretests; 1,601 vitest tests with 20 standard skips) and eslint with Prettier. The first `npm test` run failed on one pre-existing test outside this unit, `cardData.test.ts` "reports freshness for the served version when a different process publishes", which compares two wall-clock staleness reads rounded to a tenth of an hour and straddled a six-minute boundary (435 against 435.1); it passed on the rerun and the defect is recorded as pending `mcp-carddata-staleness-test-clock`.

## Evidence update

The served snapshot did not move; the ledger is byte-identical. The first update run, read before anything else, reported the engine changed, the owner-less `engine_revision` unit for the three `intrinsic-basic-mana` rows, and the already-owned `baseline_corpus` unit. The generated files were restored from Git, the basic-mana evidence was re-run in the clean clone at the pin, `CORE_SUPPORT_REVISION` was re-pinned, and the update and binding runs wrote the committed [requalification record](../evaluation/engine-any/requalification-v1.json) with the engine same and only the owned `baseline_corpus` unit open.

## Limits

- The card factory emits no `ManaAbility::Contextual`, so the real Command Tower and Arcane Signet Oracle text is not yet bound to this output; that binding, Arcane Signet's casting cost and its noncreature eligibility stay with `engine-mvp-lands`, whose acceptance now names them.
- A 903.4b color choice made before the game and melded or merged commanders (CR 903.3b-c) are not modeled; the identity is whatever the setup owner established.
- Costs that refer to the identity (CR 903.4f, unpayable) do not exist in the engine; only production reads it.
- The worker still answers `commander_preflight_unavailable` and `commander_admission_unavailable`; admission and the integrated mirror pod stay with `engine-mvp-commander`, which now has all five rule units done.
