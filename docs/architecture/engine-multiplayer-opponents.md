# Every living opponent: opponent scope, trigger order and built-in policies

Accepted for `engine-mvp-multiplayer-opponents` under the [engine charter](../ENGINE-CHARTER.md). It is the third of three units split from `engine-mvp-multiplayer` (reasoning `think:362`); the research finding and plan are `think:372`, the implementation findings `think:373`, and the served-snapshot finding made during the pin advance `think:374`. Native Magistr records hold execution status.

The [source pin](../../engine/source.json) advances to canonical `mtg-game-engine` commit `e2b247ed25389af8d68c45bbb8a443acdb201c4a` on `main`. The root `Cargo.lock`, the worker protocol and every generated contract derivative are byte-identical; only the manifest's source revision changes.

## What was wrong

Sizing against the code at pin `81df46a` found less rules work than the chunk text assumed, one rules defect the split decision had missed, and two policy defects.

- `EventBus::drain_pending_apnap` separated the active player's triggers from everyone else's and kept the rest in registration order. That is APNAP only for two players. `think:362` had read it as already general; `think:372` revises that.
- The heuristic and search agents each owned a private `find_opponent` returning the first living non-self player. Damage aimed at the second or third opponent, or at their creatures, was scored as self-harm (-100), and board evaluation ignored two opponents.
- Search rollouts seated a policy only for the viewpoint and that first opponent. The loop lets an unseated player pass, so nothing failed: the other two opponents were simply modeled as inert.
- "Living opponents in turn order" existed only inline in `legal_attack_targets`, and the APNAP rotation only inline in `defending_players`.
- Already general, needing fixtures and no code: player targets list every player who has not lost; `TriggerOwnership::Opponent` is any player other than the controller; `OpponentLandColors` reads every land the controller does not control, and a departed player's permanents are gone; the determinizer iterates every player.
- Not present at all: any each-opponent or target-opponent effect, and any player-scoped replacement. There is nothing to rescope, and inventing effect vocabulary belongs to `engine-mvp-effects`, whose acceptance now carries the four-seat fixtures for it.

## What was delivered

| Owner or consumer                 | Before                                          | Now                                                                                                                                                                                                                                             |
| --------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TurnManager`                     | `player_order`, rotations computed by callers   | `order_from(player)` and `apnap_order()`; once the active player has left, APNAP begins at the next seat (CR 800.4j), matching `first_priority_player`                                                                                          |
| `GameState::living_opponents`     | did not exist                                   | the one owner of who is an opponent (CR 102.2–102.3, 800.4a): every other player who has not lost, in turn order after the asker; the loser of a finished game whose position is kept intact is still no opponent                               |
| `combat::attack`, `combat::block` | inline rotations                                | `legal_attack_targets` reuses `living_opponents`; `defending_players` reuses `apnap_order`                                                                                                                                                      |
| `EventBus::drain_pending_apnap`   | active player first, then registration order    | takes the APNAP order and sorts stably by the controller's position, so order within one controller is preserved for a later ordering choice (CR 101.4, 603.3b)                                                                                 |
| `game_loop.rs` trigger placement  | passed the active player                        | passes `apnap_order()`                                                                                                                                                                                                                          |
| `heuristic_agent`                 | one `opponent_id` threaded through every scorer | no opponent parameter; `evaluate_board(state, player)` is the worst matchup across living opponents; damage scoring treats any living opponent or their creature as hostile; removal weighs the biggest opposing board; `find_opponent` deleted |
| `search_agent`                    | one opponent seated and measured                | every living opponent gets a rollout policy; the life differential measures against the healthiest; a viewpoint eliminated from a game the others continue scores as a loss; `find_opponent` deleted                                            |

## Ownership and reuse review

One owner per decision holds. Who is an opponent, and in what order, is decided by `GameState::living_opponents` over `TurnManager::order_from`; combat and both policies consume it and no second computation remains. APNAP order is decided by `TurnManager::apnap_order`; the trigger scheduler and the block sequencer consume it. No TypeScript, worker protocol or MCP route changed. `should_attack` keeps an explicit opponent parameter because it is a per-defender question; it has no production caller.

Worst matchup was chosen over a sum for board evaluation because callers read the sign of the score ("am I ahead"): a sum across three opponents is strongly negative even when every player is level, while the minimum keeps "ahead means ahead of everyone" and reduces to the plain difference with one opponent.

## Rules basis

Wizards' Comprehensive Rules effective 2026-08-07 (release `20260819`, the frozen corpus): 102.2–102.3 (in a multiplayer game each other player is an opponent), 101.4 and 603.3b (APNAP order for simultaneous triggered abilities), 800.4a and 800.4j (a player who left the game; the next seat when the active player has left).

## Evidence

`crates/mtg-engine/tests/multiplayer_opponents.rs` was written first and failed only on the absent API. Thirteen scenarios: the opponent set and its order at four seats and after an elimination; two players as each other's only opponent, and no opponent once one has lost; player targets never listing an eliminated seat; the APNAP order owner; a five-trigger, four-controller drain whose registration order disagrees with turn order, including two triggers of one controller; loop-level placement with the second seat active; an opponent-scoped upkeep trigger firing three times, and twice with a seat eliminated; opponent land colors across three opponents, stopping with a departed one; heuristic lethal damage against each of the three opponents in turn; removal of the third opponent's creature; worst-matchup board evaluation; and unchanged two-player arithmetic. Two unit tests in `search_agent.rs` cover rollout seating and the terminal differential.

Seven mutations were applied and restored byte for byte (SHA-256 checked): seating only the first opponent in rollouts, partitioning the drain into active versus everyone else, keeping eliminated players as opponents, returning only the first opponent, taking the best instead of the worst matchup, ignoring the active player in APNAP order, and measuring rollouts against the weakest opponent. All seven are caught. Three survived the first round and were not waved through: each exposed a weak or missing assertion of mine, and tightening one of them exposed the real defect described below.

Two-player behavior is unchanged through the same code: the full engine suite, including the seeded determinism transcripts, the heuristic stress runs and search-versus-pass, passes unmodified apart from call-site signatures.

Recorded gates on engine `main`: workspace check with all targets including the desktop crate, Clippy with pedantic warnings denied, rustfmt, 1,713 tests (3 pre-existing skips) plus doctests. On the pin task: clean-clone identity before and after the locked offline arm64 release worker build, the empty-directory self-check, contract sync and check, 147 native MCP tests against the clean-clone binary, and the 13-test evidence requalification run in the clean clone.

## A defect found by a surviving mutant

The rollout seating test first failed against the new code with a score of 460. The viewpoint was dead at 0 life, but three opponents were still playing, so the game had no winner and the terminal score counted it as unfinished (500 plus the life differential). Two players can never reach that state, which is why it had never shown. An eliminated viewpoint now scores as a loss.

## Measured limits of the built-in policies at four seats

These are recorded rather than implied, and none is claimed as strong multiplayer play.

- **Attacks.** Heuristic, search, CLI and worker policies use the `choose_attackers` trait default, which sends every attacker at the next opponent in turn order. They never split attacks or pick the weakest defender.
- **Threat model.** Board evaluation is a worst-matchup scalar. It has no notion of politics, of who is attacking whom, or of two opponents weakening each other.
- **Search.** Rollouts model every opponent as the heuristic policy. Cost grows with the table: each simulated round is four turns, so `rollout_depth_turns` buys a quarter of the look-ahead it buys at two seats. No strength measurement at four seats exists yet.
- **MCTS.** `search::mcts` backs up `1 - reward` for every node that is not the viewpoint's. At four seats that is the paranoid reduction (all opponents as one coalition). It is left as is and documented, not silently changed to max-n.
- **Determinizer.** It shuffles each player's library and already iterates every player; nothing assumed one opponent.
- **Match and rating harness.** `MatchSpec` (`player_a`, `player_b`), the match store, `mtg-cli rate` and the pairwise Glicko-2 feed are a two-seat tournament harness. That is a different owner from in-game policy evaluation and is split into `engine-eval-multiplayer-matches`. It follows `engine-mvp-multiplayer` and gates `engine-mvp-policies`, which needs measured strength; it deliberately does not gate four-player rules support or Commander play. The Glicko-2 arithmetic itself takes a list of pairwise results and assumes nothing about table size.

## Evidence update, and a served snapshot that moved mid-session

Advancing the pin ran the [evidence maintenance workflow](engine-evolution-rules-evidence.md). This time the engine was not the only thing that moved. The committed census was bound to served snapshot version `2026-09-18T16-23-27-276Z-…` (index revision `2ce64aff…`); during this iteration the data root began serving `2026-09-18T21-16-15-477Z-…` (index revision `019a6fd8…`). Nothing in this iteration writes to the data root; what refreshed it was not observed.

The first update run reported `pool +0 -0 ~56`: 31,830 legal and 83 banned identities, keyword labels, the rules release and the rulings export are unchanged, and 56 identities carry a new exact-source digest. All 56 make or refer to tokens, consistent with an upstream Oracle wording update:

> Dreadhorde Invasion; Funeral Pyre; Elspeth, Sun's Champion; Skrelv's Hive; Lingering Souls; Staff of the Storyteller; Chandra, Torch of Defiance; Goblin Goliath; Mogg Alarm; Goblin Offensive; Security Detail; Martial Coup; Angelic Favor; Empty the Warrens; Warbreak Trumpeter; Mastermind Plum; Myr Matrix; Goblin Marshal; Urbis Protector; Launch Mishap; Windcrag Siege; Pia Nalaar, Consul of Revival; Iron Man, Titan of Innovation; Even the Odds; Occult Epiphany; Origin of the Hulk; Kher Keep; Goblin Gang Leader; Mogg War Marshal; Overlord of the Mistmoors; Kjeldoran Outpost; Shark Typhoon; Restless Anchorage; Seize the Soul; Currency Converter; Goblin Rally; Siege-Gang Lieutenant; Doomed Traveler; White Sun's Twilight; Lena, Selfless Champion; Ironroot Warlord; Secure the Wastes; March of Souls; Ardoz, Cobbler of War; Goblin Warrens; Emissary Green; Mogg Infestation; Myr Incubator; General Kreat, the Boltbringer; Grand Crescendo; Covetous Elegy; Siege-Gang Commander; Hunted Phantasm; Thopter Squadron; Transluminant; Sarpadian Empires, Vol. VII

That run opened 31 `pool_identities` units, every one routed to an existing pending owner (the largest: `engine-mvp-catalog-objects` with 1,012 rows, `engine-mvp-layers` 154, `engine-any-copy-composite-objects` 59, and 56 each on `engine-mvp-cost-choices` and `engine-mvp-support-runtime`), the owner-less `engine_revision` unit for the three `intrinsic-basic-mana` rows, and the already-owned `baseline_corpus` unit. No qualified row belongs to a changed identity, so the Oracle change invalidated no qualified evidence. Per the [census README](../evaluation/engine-any/README.md), owned units are absorbed by their pending chunks' scope.

The basic-mana evidence was re-run in the clean clone at the pin, `CORE_SUPPORT_REVISION` was re-pinned, and the binding run wrote the committed [requalification record](../evaluation/engine-any/requalification-v1.json): engine same, census matching the served snapshot, and only the owned `baseline_corpus` unit open. Because the binding run diffs against the first run's output, the committed JSON no longer carries the 56-identity diff; this section and the Git history of the ledger are its record.

One procedural mistake, corrected: the update step is stateful, and I re-ran it before reading the first report, which overwrote the diff. I restored the three generated files from Git, reproduced the first run into a scratch directory, and only then re-pinned and bound.

## Roadmap reconciliation

- `engine-eval-multiplayer-matches` filed pending: N-seat match specification, store and CLI rating with a stated multiplayer decomposition for Glicko-2, and the first measured four-seat policy strength. It depends on `engine-mvp-multiplayer`, and `engine-mvp-policies` now depends on it.
- `engine-mvp-effects` acceptance gained: each-opponent and target-opponent effects resolve against `GameState::living_opponents` with four-seat fixtures.
- This chunk's third acceptance item named rating code; that obligation moved to the new chunk with this evidence rather than being dropped.

## Known limits

- Simultaneous triggers of one controller keep registration order; the controller's ordering choice (CR 603.3b) is not yet a decision.
- The policies' four-seat strength is unmeasured; see the limits above.
- No each-opponent effect exists yet, so opponent scope for effects is proven only through the owner those effects will call.
