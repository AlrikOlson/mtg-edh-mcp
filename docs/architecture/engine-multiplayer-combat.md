# Attacking any opponent and blocking per defending player

Accepted for `engine-mvp-multiplayer-combat` under the [engine charter](../ENGINE-CHARTER.md). It is the second of three units split from `engine-mvp-multiplayer` (reasoning `think:362`); the research finding is `think:367`, the plan `think:368`, the implementation findings `think:369`, and the defect found while preparing this receipt `think:370`. Native Magistr records hold execution status.

The [source pin](../../engine/source.json) advances to canonical `mtg-game-engine` commit `81df46ad14a37385fbb60da87db9bef62e6a3eff` on `main`. The root `Cargo.lock`, the worker protocol and every generated contract derivative are byte-identical; only the manifest's source revision changes. Combat decisions are not part of the worker protocol yet, so nothing in the schema moves.

## What was wrong

Sizing against the code at pin `14935a4` found five gaps, fewer consumers than the chunk text assumed, and one thing that already worked.

- `declare_attackers` validated the creature and never the target: the attacker's own controller, a departed player or a non-planeswalker were all accepted.
- `validate_blocker` checked who controls the blocker but not whom the attacker is attacking, and must-block was judged over every attacker.
- The loop asked one `default_defender` for blocks.
- `CombatState` could not express an attacker that is attacking nothing, so a creature attacking a departed player would still have dealt damage to them.
- Only the human agent, the desktop and two test agents override the combat hooks. The heuristic, search, CLI and worker policies use the trait default.
- Damage recipients already followed the declared target: unblocked damage, trample excess and lifelink needed fixtures, not code.

## What was delivered

| Owner or consumer                         | Before                                         | Now                                                                                                                                                                                                                    |
| ----------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `combat::attack`                          | any target accepted                            | `legal_attack_targets`: living opponents in turn order from the attacker, then the planeswalkers they control; `declare_attackers` rejects anything else with `IllegalAttackTarget` before a single creature is tapped |
| `combat::block`                           | blocker control only; must-block over everyone | `attackers_against` and `defending_players` (APNAP); a defender may block only what attacks them or their planeswalkers (`NotAttackingDefender`); menace and must-block ignore creatures attacking other players       |
| `combat::state`                           | every attacker had a target                    | targets are optional: removing an attacked planeswalker from combat, or `remove_defending_player`, leaves the creature attacking nothing, and it deals no damage unblocked                                             |
| `combat::error`                           | unused `InvalidAttackTarget`                   | replaced by the two typed variants above                                                                                                                                                                               |
| `mtg_engine::elimination`                 | removed the leaver's own combatants            | also calls `remove_defending_player`, so no combat damage is assigned to a departed player                                                                                                                             |
| `PlayerAgent` hooks                       | one `defender`                                 | `choose_attackers` receives the target set and picks per attacker; `choose_blockers` receives the attackers that defender may block; the default attacks the next opponent in turn order                               |
| `game_loop.rs`                            | `default_defender` for attacks and blocks      | offers the target set; asks each defending player in APNAP order, applying each declaration before the next; a resumed step never asks a defender twice; `default_defender` is deleted                                 |
| `HumanAgent`, `ReplayHumanAgent`, desktop | single defender in prompt, DTO and picker      | prompt carries `attack_targets` and the blockable `attackers`; the submit command takes attacker/target index pairs; the picker selects a target per attacker; no single-defender shim remains                         |

Reuse was the default. The new check in `validate_blocker` sits after blocker eligibility, so existing control errors keep precedence and no existing test changed beyond the two test agents whose hook signatures moved. `legal_block_targets`, which the desktop uses to gate pairings, inherits the defender scope from `validate_blocker`. The elimination owner gained one call, not a second combat path.

## Rules basis

Wizards' Comprehensive Rules, published 2026-08-19, effective 2026-08-07. 506.2 and 802.2: all of the attacking player's opponents are defending players. 506.3, 508.1b and 802.3: each attacker attacks a defending player or a planeswalker one controls, and an illegal declaration returns the game to the moment before it (508.1). 509.1a and 802.4–802.4b: defending players declare blockers in APNAP order, only against creatures attacking them or their planeswalkers, and their blocks are judged ignoring creatures attacking other players. 508.5 and 802.2a: the defending player for an attacker is the player it attacks or the controller of the planeswalker it attacks. 506.4c: when an attacked planeswalker is removed from combat its attacker keeps attacking, attacks nothing, may be blocked and deals no damage unblocked. 800.4e: no combat damage is assigned to a player who has left.

The rules name no separate procedure for a creature attacking a player who leaves. This unit applies 506.4c's model to that case: the creature keeps attacking nothing, which gives exactly the 800.4e result.

## Independent evidence

`crates/mtg-engine/tests/multiplayer_combat.rs` was written before any production change and failed only on the absent API. Ten scenarios: the target set and its order, shrinking when a player leaves; six illegal targets each rejecting a two-creature declaration with canonical state bytes unchanged; attackers split between two opponents with each defender offered only their own attackers, in APNAP order, and the uninvolved player never asked; a defender refused a block on a creature attacking someone else but allowed to protect their planeswalker; a block requirement binding only the attacked player; trample excess, lifelink and planeswalker damage following the declared target; a defender conceding in the declare attackers step taking no damage and never being asked to block while the other defender is; attackers left attacking nothing after elimination and after a planeswalker is removed; two-player combat unchanged for agents with no combat logic.

Two fixtures of mine were wrong and were corrected without weakening an expectation: a battlefield planeswalker with no loyalty counters is removed by state-based actions before attackers are declared, and a defender with no untapped creatures is rightly never asked to block.

Seven mutations were applied and restored byte for byte. Dropping target validation, the defender-scoped block check, the elimination hook or planeswalker-removal clearing, and reversing APNAP order, each failed one to three scenarios. Two survived as equivalent: must-block scoping is already implied by the scoped `validate_blocker` (kept as the literal 802.4b reading), and the turn-order rotation offset was redundant because the attacker is filtered out, so that arithmetic was removed.

Recorded gates on engine `main`: workspace check with all targets including the desktop crate, Clippy with pedantic warnings denied, rustfmt, 1,698 tests (3 pre-existing skips) plus doctests, and the desktop frontend typecheck. On the pin task: clean-clone identity before and after the locked offline arm64 release worker build, the empty-directory self-check, contract sync and check, 147 native MCP tests against the clean-clone binary, and the 13-test evidence requalification run in the clean clone.

## Evidence update

Advancing the pin ran the [evidence maintenance workflow](engine-evolution-rules-evidence.md). Only the engine moved; the served snapshot is unchanged. The first run reported the owner-less `engine_revision` unit for the three `intrinsic-basic-mana` rows and the already-owned `baseline_corpus` unit. Their evidence was re-run in the clean clone at the pin, `CORE_SUPPORT_REVISION` was re-pinned, and the second run bound the [requalification record](../evaluation/engine-any/requalification-v1.json) with the census matching the served snapshot. The only open unit is the owned `baseline_corpus` one on `engine-mvp-corpus`.

## A defect found while writing this receipt

Checking who removes permanents from combat showed that the elimination owner is the only production caller of the removal primitive. A throwaway two-player probe confirmed the consequence: a 2/2 attacker killed by a 2/2 first-strike blocker still deals its regular combat damage from the graveyard and kills the blocker (contrary to CR 506.4 and 510.1). This predates the unit and is not specific to multiplayer, and its fix belongs to the zone-change and control owners this unit did not review. It is filed as pending `engine-combat-removal-on-leave` at priority 108 with the probe as its first fixture, and `engine-mvp-multiplayer` now depends on it.

## Retained work and known limits

- The engine tracks no commander damage yet. Combat damage events already carry the declared target; `engine-mvp-commander` now states explicitly that commander damage accumulates from those events per damaged player.
- The built-in policies use the trait default, so they attack the next opponent in turn order and never choose among opponents. Choosing targets and evaluating several opponents belongs to `engine-mvp-multiplayer-opponents`.
- Requirements and restrictions that apply to attacking a specific player (CR 802.3a), banding (802.3b) and battles are not modelled; none is in the fixed corpus. They stay with `engine-any-combat-families`.
- Damage to an attacked planeswalker is marked as damage, not removed loyalty; that is `engine-mvp-planeswalkers`.
- The desktop picker change was typechecked and the Rust side is unit-tested, but the picker was not exercised in a running app. The desktop remains a two-seat Play Lab, where the selector only appears when the opponent controls a planeswalker.
- Combat declarations are not yet canonical decision requests, so the worker cannot relay them; four-seat worker and MCP evidence remains an obligation of `engine-mvp-multiplayer` and `engine-mvp-decision-relay`.
