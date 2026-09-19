# Commander casting from the command zone and commander tax

Accepted for `engine-commander-cast-tax` under the [engine charter](../ENGINE-CHARTER.md). It is the second of the five units split out of `engine-mvp-commander` and builds on [Commander setup](engine-commander-setup.md). The research finding and plan are `think:389`. Native Magistr records hold execution status.

The [source pin](../../engine/source.json) advances to canonical `mtg-game-engine` commit `3a3b75234980de6b5aa1530ad4058e969b7d08ce` on `main`. The root `Cargo.lock`, the worker protocol and every generated contract derivative are byte-identical; only the manifest's source revision changes.

## What was delivered

| Owner or consumer                           | Before                                    | Now                                                                                                                                                                                                                                                             |
| ------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `commander::CommanderRegistry`              | designations only                         | also a serialized, ordered history of `CommandCastCount { card, caster, count }`. Reads: `command_casts`, `commander_tax` (two generic per previous cast). `record_command_cast` is crate-private                                                               |
| `casting::cast_spell_transaction`           | source zone is the hand, or the graveyard | the command zone is a source only for a designated commander. The existing ownership check refuses everyone but its owner; any other card in the command zone is still `NotInHand`. The cast is recorded after payment succeeds, inside the private transaction |
| `mana::costs::spell_cost`                   | did not exist                             | the cost of this caster casting this card from where it is: the tax enters the same CR 601.2f total as registered increases, before reductions, and only while the card is in the command zone. `adjusted_cost` is unchanged for activations                    |
| `turn::heuristic_agent` affordability check | `adjusted_cost` by player                 | `spell_cost`, so it does not rate an unaffordable taxed cast as castable                                                                                                                                                                                        |
| `decisions::decision_requests_of`           | listed spells in the hand                 | also lists the player's commanders currently in the command zone, under the same timing rule. `candidate_responses` and the legal-action enumerator follow unchanged, so an unaffordable taxed cast is offered but samples no answer                            |
| `CommanderRegistry::remove_owned_by`        | dropped the leaver's designations         | also drops the history of the leaver's cards and of the leaver's casts                                                                                                                                                                                          |
| `snapshot::CORE_SNAPSHOT_VERSION`           | 9                                         | 10, because a serialized field was added. Nothing in the worker contract or MCP reads the version                                                                                                                                                               |

## Ownership and reuse review

- **One cast transaction.** `cast_spell`, the declaration entry and the affordability probe all run `cast_spell_transaction`, so admitting the command zone there covers every entry, and the probe can never count a cast because it runs on a discarded clone. No command-cast entry point was added.
- **Not an alternative cost.** A `CastingOptions` variant was considered and rejected: casting from the command zone is a permission plus an additional cost, so modelling it as an alternative cost would block a commander's real alternative costs and would let a caller choose whether tax applies. The zone the card is in decides.
- **One cost pipeline.** The tax is fed into the shared increase-then-reduce computation rather than added to the mana cost beforehand or afterwards. A scenario with a three-generic reducer proves the tax is reducible and the colored requirement stays (`{2}{G}` + `{2}` − `{3}` = `{1}{G}`).
- **One Commander state.** The history lives in the registry beside the designation it refers to, keyed by physical card and caster. Identical commanders in a mirror pod are distinct cards, so nothing is shared by name or Oracle identity.
- **When it counts.** CR 601.2i makes the spell cast once costs are paid. Recording there means a countered cast counts, and a cast refused for mana leaves canonical bytes identical.
- **Overlap.** None added. The desktop's commander-in-hand setup remains the duplicate path whose removal milestone is `engine-mvp-commander`.

## Rules basis

From the engine's retained Comprehensive Rules snapshot (`crates/mtg-engine/src/cards/support/preview_sources/comprehensive-rules.txt`): 903.8 (a player may cast a commander they own from the command zone; an additional {2} for each previous time the player casting it has cast it from the command zone that game), 118.8 (additional costs are paid with the mana cost), 601.2f (total cost is the mana or alternative cost plus additional costs and increases, minus reductions), 601.2i (the spell becomes cast after costs are paid), 800.4a (a leaving player's objects leave the game).

## Evidence

`crates/mtg-engine/tests/commander_cast_tax.rs`, written first against compile-level stubs: eleven of twelve failed on behavior and the non-commander control passed. Every cost is proven exact by first refusing one less mana and then emptying the pool.

1. An owner casts their commander from the command zone for its mana cost; it is on the stack under their control and still a commander.
2. The decision owner offers the cast to the owner only, its single sampled answer executes through `submit_decision`, and with tax due but only the mana cost available it samples nothing.
3. A commander is offered once from the command zone, not at all from the battlefield, and once (not twice) from the hand. Added after a mutant survived.
4. Another player cannot cast it; canonical bytes are unchanged.
5. An identical non-commander card in the command zone is neither castable nor offered.
6. Three successive casts cost 3, 5 and 7.
7. A three-generic reducer applies after the tax.
8. In a four-owner mirror pod one player's two casts leave the other three commanders at no tax, and each then pays only for their own history.
9. A cast from the hand neither pays nor increases the tax, and the next command-zone cast still owes it.
10. A command-zone cast countered by a real counterspell still counts.
11. A cast that cannot be paid is not counted and changes nothing.
12. The history is in the versioned canonical bytes, survives restore, and the restored game charges the tax.
13. A leaving player takes their history; another player's is kept and still charged.

A registry unit test covers the one path casting cannot reach today: a leaver's casts of someone else's commander leave with them.

Thirteen mutants, each applied alone and restored byte for byte (SHA-256). The first run left two survivors, the offer-from-any-zone gap above and the leaver's own history; after the added scenario and unit test all thirteen are caught: tax never charged, charged from any zone, added after reductions, cast never recorded, recorded from every zone, any command-zone card castable, count shared across casters, count shared across identical commanders, history skipped in serialization, leaving keeps history, leaving clears every history, commander not offered, commander offered from any zone.

Recorded gates on engine `main`: workspace check with all targets including the desktop crate, Clippy with pedantic warnings denied (the first run failed on an implicit clone in my test helper and was fixed), rustfmt, 1,790 tests (3 pre-existing skips) plus doctests. On the pin task: clean-clone identity before and after the locked offline arm64 release worker build, the empty-directory self-check, contract sync and check, 152 native MCP tests against the clean-clone binary (unchanged: the preview never names a commander), and the 13-test evidence requalification run in the clean clone.

## Evidence update

The served snapshot did not move; the ledger is byte-identical. The first update run, read before anything else, reported the engine changed, the owner-less `engine_revision` unit for the three `intrinsic-basic-mana` rows, and the already-owned `baseline_corpus` unit. The generated files were restored from Git, the basic-mana evidence was re-run in the clean clone at the pin, `CORE_SUPPORT_REVISION` was re-pinned, and the binding run wrote the committed [requalification record](../evaluation/engine-any/requalification-v1.json) with the engine same and only the owned `baseline_corpus` unit open.

## Limits

- A resolved commander stays on the battlefield and a countered one stays in the graveyard. Returning it to the command zone is `engine-commander-zone-return`; the scenarios move the card back by hand.
- Only the owner can cast from the command zone, so the per-caster key never holds a second caster in play. It exists because 903.8 counts per casting player; effects that let another player cast a commander are any-deck work.
- No spell-cast event is emitted yet, for a commander or any spell; that is `engine-cast-and-counter-events`.
- The heuristic agent prices a commander cast correctly but still reads only the hand when it values land colors, so it does not plan lands toward its commander. Recorded on `engine-mvp-policies`.
- The worker still answers `commander_preflight_unavailable` and `commander_admission_unavailable`; admission and the integrated mirror pod stay with `engine-mvp-commander`.
