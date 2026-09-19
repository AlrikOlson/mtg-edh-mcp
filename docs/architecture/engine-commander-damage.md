# Commander damage: 21 combat damage from one commander

Accepted for `engine-commander-damage` under the [engine charter](../ENGINE-CHARTER.md). It is the fifth Commander rule unit split out of `engine-mvp-commander`. The research finding and plan are `think:398` and the implementation finding is `think:399`. Native Magistr records hold execution status.

The [source pin](../../engine/source.json) advances to canonical `mtg-game-engine` commit `9c85884856c9cefeb8c95b589a929ccfcc069521` on `main`. The root `Cargo.lock`, the worker protocol and every generated contract derivative are byte-identical; only the manifest's source revision changes.

## Scope

CR 903.10a, 704.6c and 104.3j: a player who has been dealt 21 or more combat damage by the same commander over the course of the game loses, as a state-based action. Research found that the multi-defender combat owner already computes one `CombatDamageEvent` per source and target, following each attacker's declared defender, but that the only code applying those events was the game loop, which changed life totals and marked damage itself. Noncombat damage is applied in the resolution owner and never becomes a combat damage event.

## What was delivered

| Owner or consumer                          | Before                                                   | Now                                                                                                                                                                                                                              |
| ------------------------------------------ | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `commander::CommanderRegistry`             | designations, cast history, arrivals, offers             | also the serialized `CommanderDamageTotal { card, player, amount }` list in first-damage order, `combat_damage`, `combat_damage_totals`, `has_lethal_combat_damage` and `COMMANDER_DAMAGE_THRESHOLD`. Recording is crate-private |
| `combat::damage::apply_combat_damage`(new) | did not exist; the game loop applied events              | the one place combat damage is applied: life loss, damage marks with deathtouch, lifelink gains, and the commander total for damage a commander deals to a player                                                                |
| `game_loop::resolve_damage_substep`        | logged and applied each event                            | logs the events and the lifelink gains, then calls the combat owner. The log order is unchanged                                                                                                                                  |
| `sba::check_and_perform`                   | life and poison losses                                   | `check_commander_damage` after them, reporting `SbaLossReason::CommanderDamage`. A player who already lost in this check is skipped, so zero life plus lethal commander damage is one loss                                       |
| `elimination`, `GameOverReason`            | four loss reasons                                        | `EliminationReason::CommanderDamage` and `GameOverReason::CommanderDamage(player)`, a rules outcome. The elimination owner itself is unchanged                                                                                   |
| `CommanderRegistry::remove_owned_by`       | dropped a leaver's designations, casts, arrivals, offers | also drops the totals of the leaver's commanders and the totals against the leaver                                                                                                                                               |
| `mtg-worker` `trial::rules_reason`         | five rules reasons                                       | `commander_damage`. The protocol's reason is a free string, so the contract did not change; the worker still refuses Commander scenarios, so nothing can produce it through MCP yet                                              |
| desktop `commands/play.rs`                 | exhaustive reason display                                | one more arm. No desktop behavior was migrated                                                                                                                                                                                   |
| `snapshot::CORE_SNAPSHOT_VERSION`          | 12                                                       | 13, because a serialized field was added. Nothing in the worker contract or MCP reads the version                                                                                                                                |

## Ownership and reuse review

- **Combat applies combat damage.** The loop used to own a rules step that no other consumer could reach; a test or a future consumer that resolved combat directly could not apply it. Moving the application into the combat owner gave the total exactly one recording point, and counting inside the loop's match arm was rejected because it would have made the loop a second rules owner.
- **Noncombat damage is excluded by construction.** It is applied by the resolution owner and never passes through `apply_combat_damage`. Damage to planeswalkers and creatures is a different arm of the same match.
- **One Commander designation, one history.** The total is keyed by the commander's `CardId` and the damaged `PlayerId` in the registry that already owns the designation, so it needs no zone, object or controller bookkeeping to survive zone changes, control changes and restores, and identical commanders of four owners stay distinct. Damage from a card that is not designated is ignored at the recording point.
- **The state-based owner decides, the elimination owner removes.** The loss follows the same path as zero life and poison; the loop only maps the reason.
- **Overlap.** None added; the loop's duplicate application of combat damage was removed. The desktop's commander-in-hand setup remains the duplicate path whose removal milestone is `engine-mvp-commander`.

## Rules basis

From the engine's retained Comprehensive Rules snapshot (`crates/mtg-engine/src/cards/support/preview_sources/comprehensive-rules.txt`): 903.10a, 704.6c and 104.3j (the loss and that it is a state-based action), 903.3 (the designation is an attribute of the card in every zone and under any controller, which is why the owner can lose to their own stolen commander), 120.3a (damage to a player is lost life, so gaining life takes no damage back), 510.2 (combat damage is dealt as assigned) and 800.4a (a leaving player's objects leave the game).

## Evidence

`crates/mtg-engine/tests/commander_damage.rs`, written first against compile-level stubs: 8 of 11 failed on behavior and the three negative controls passed.

1. In a four-seat pod a commander's damage is counted against the player it attacked and nobody else, while an identical card that is not a commander attacks another seat and counts for nothing.
2. Damage to a planeswalker, damage from a blocked commander to its blocker and damage from a blocking commander are not counted.
3. Twenty-one noncombat damage from the commander's owner is not counted and does not lose.
4. Twenty does not lose; the twenty-first does, through the state-based check, with the player at 119 life; the loss is decided once and the elimination owner removes the player from a continuing pod.
5. Twenty from each of two commanders, with lifegain between, does not lose; one more from the first does.
6. Zero life and lethal commander damage in the same check are one loss.
7. The total survives the commander going to a graveyard, the command zone and back to the battlefield, and a control change; a stolen commander adds to the same total and counts against its own owner.
8. Four identical commanders deal different amounts in one damage step; the totals are separate, recorded in first-damage order, and 42 damage in all loses only because one commander dealt 21.
9. Two states with equal life and different totals have different canonical hashes; the total survives a restore and the restored game reaches the loss.
10. A leaving player takes their commander's totals and the totals against them; the others are untouched.
11. The game loop ends a two-player game with `GameOverReason::CommanderDamage` while the loser has 75 life, the winner is the other player, and the total is 25.

### Mutation evidence

`cargo-mutants` 27.1.0 over the unit's diff, on copies of the tree, with the combat, elimination and library suites: 36 mutants in 3 minutes: 31 caught, 4 unviable, no timeouts and 1 missed. The miss replaced `GameOverReason::is_game_outcome` with `true`, a whole existing function whose negative cases are tested outside the scoped run; the loop scenario now also asserts that a turn limit is not a rules outcome.

### Gates

Recorded on engine `main`: workspace check with all targets including the desktop crate, Clippy with pedantic warnings denied (the first run failed on two similar binding names in a scenario, which were renamed), rustfmt, 1,838 tests (3 pre-existing skips) plus doctests. One existing test changed by design: the `commander_setup` assertion that pins the snapshot version. The first full test run after the final edits failed only on the wall-clock `search_decision_time_is_bounded` test, because the lint and test gates had been started at the same time; run alone on the same tree it passed, and that is the recorded result. On the pin task: clean-clone identity before and after the locked offline arm64 release worker build, the empty-directory self-check, contract sync and check, 152 native MCP tests against the clean-clone binary (unchanged: the preview never names a commander), the 13-test evidence requalification run in the clean clone, and the census check.

## Evidence update

The served snapshot did not move; the ledger is byte-identical. The first update run, read before anything else, reported the engine changed, the owner-less `engine_revision` unit for the three `intrinsic-basic-mana` rows, and the already-owned `baseline_corpus` unit. The generated files were restored from Git, the basic-mana evidence was re-run in the clean clone at the pin, `CORE_SUPPORT_REVISION` was re-pinned, and the update and binding runs wrote the committed [requalification record](../evaluation/engine-any/requalification-v1.json) with the engine same and only the owned `baseline_corpus` unit open.

## Limits

- Infect, damage prevention and damage redirection do not exist in combat yet. When they do, they must act before `apply_combat_damage` records the total, because only damage actually dealt counts.
- Melded and merged commanders (CR 903.9c) and a commander that is a copy are any-deck layout work; a token or a copy is never designated, so it counts for nothing today.
- The heuristic and search agents do not read the totals when they evaluate a position or choose blocks. That is policy work on `engine-mvp-policies`.
- The game loop logs lifelink gains by iterating a hash map, which predates this unit. With two lifelink controllers in one damage step the log order is not deterministic; it is recorded as pending `engine-combat-lifelink-order`.
- The worker still answers `commander_preflight_unavailable` and `commander_admission_unavailable`; admission and the integrated mirror pod stay with `engine-mvp-commander`.
