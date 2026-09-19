# Putting a commander into the command zone instead of a hand or library

Accepted for `engine-commander-zone-replacement` under the [engine charter](../ENGINE-CHARTER.md). It is the fourth Commander rule unit split out of `engine-mvp-commander` and the second half of the pair that began with the [state-based return](engine-commander-zone-return.md). The split is `think:391`, the research finding and plan are `think:395`, the implementation finding is `think:396`. Native Magistr records hold execution status.

The [source pin](../../engine/source.json) advances to canonical `mtg-game-engine` commit `c1ec236491b0564df200b7c4a6e706bc592d2fd9` on `main`. The root `Cargo.lock`, the worker protocol and every generated contract derivative are byte-identical; only the manifest's source revision changes.

## Scope

CR 903.9b: if a commander would be put into its owner's hand or library from anywhere, its owner may put it into the command zone instead. Research found that the only production moves that reach a hand are the draw (the draw step and the `DrawCards` effect share `draw_card`) and the buyback return; nothing moves a card to a library after setup, and no bounce or tuck effect exists yet. The replacement registry still has no registered effect and no condition that could match a hand or library move, so consulting it for these moves would have been wiring with nothing behind it. The rule is generated from the designation itself, so registering one effect per commander would have made a second source of truth for who is a commander.

## What was delivered

| Owner or consumer                                 | Before                                                    | Now                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `replacement::commander_redirect` (new)           | did not exist                                             | the deciding owner. `move_card_replaced` either moves through the zone facade or, for a commander whose destination is a hand or library it is not already in and whose owner has not lost, moves nothing and reports `Suspended`. `pending_redirect` presents the request; `answer_redirect` applies it |
| `replacement::ReplacementRegistry`                | registered effects only                                   | also the one serialized `SuspendedMove { card, object, to }`. Suspend, take and drop are crate-private                                                                                                                                                                                                   |
| `turn::step_actions::draw_card`                   | raw move to the hand                                      | moves through the replacement owner. It still returns `false` only for an empty library                                                                                                                                                                                                                  |
| `resolution` (`DrawCards`, `resolve_transaction`) | drew `count` cards in one loop                            | when a draw waits, the draws after it go back onto the resolution's frames and the resolution stops with `ChoiceRequired`, exactly as for its own requests                                                                                                                                               |
| `decisions`                                       | resolution request and command-zone offer                 | `DecisionRequest::CommanderReplacement`, its response, and `DecisionOutcome::CommanderReplacement { card_id, redirected, resolution }`. It is presented first. Its submission continues a suspended resolution inside the same transaction and keeps an interruption an interruption                     |
| `DecisionRequest::into_choice` (new)              | four consumers each listed the engine-question kinds      | one method; the validator, the heuristic, search and console agents use it, so the third kind added no fourth list                                                                                                                                                                                       |
| `GameState::choice_pending`                       | suspended resolution or open offer                        | or a waiting commander move. The guards and the enumerator did not change                                                                                                                                                                                                                                |
| `game_loop`                                       | answered command-zone offers inside the state-based check | `answer_commander_requests` answers either Commander request. The draw step answers before it logs the draw and, resumed after a pause with the move still waiting, does not draw again. A waiting move inside a resolution is answered before the resolution is continued                               |
| `elimination::forget_object`                      | event bus, replacement effects, continuous effects        | also drops the waiting move of a card that leaves the game                                                                                                                                                                                                                                               |
| `zones::manager::ZoneError`                       | three variants                                            | `ChoicePending(card)` for a second replaced move while one waits; the state is unchanged                                                                                                                                                                                                                 |
| `snapshot::CORE_SNAPSHOT_VERSION`                 | 11                                                        | 12, because a serialized field was added. Nothing in the worker contract or MCP reads the version                                                                                                                                                                                                        |

## Ownership and reuse review

- **Decided in the replacement owner, applied by the mover's facade.** Whether the rule applies, who is asked and what the answer does live in `replacement::commander_redirect`. The move itself, either way, is one `ZonesMut::move_card`, the same facade every production move uses, so control history, combat removal and the state-based arrival recorder see it like any other move.
- **The event never happens (CR 614.6).** A suspended card does not move. A replaced draw is not a draw: the next card stays in the library, the game log records no `CardDrawn`, and a draw effect does not make the draw up.
- **One suspension shape for every mover.** The draw step has no resolution frame and a resolution has no step cursor, so the suspension is state, not a mover's local: it survives a snapshot, a pause and a resume identically in both. Reusing the resolution frame was rejected because it would have left the draw step without a suspension and put the decision in the resolution owner.
- **One Commander designation.** The rule reads `CommanderRegistry::designation`; nothing is registered per commander.
- **Neither path implements the other.** A move decided here records no state-based arrival and opens no offer, with both answers; a commander that dies is still asked about through `CommanderReturn`, and a replacement-spelled answer cannot answer that offer nor the reverse.
- **One presentation, one spelling.** The request reuses `ChoiceRequest` with kind `Optional` and options yes then no, like the offer, and agents answer through `Action::ChooseResolution`.
- **Explicit leaver cleanup.** Dropping a leaver's waiting move is its own call from elimination, not a side effect of `unregister_card`, which other code may call when a permanent merely leaves the battlefield.
- **Overlap.** None added; four duplicate request-kind lists removed. The desktop's commander-in-hand setup remains the duplicate path whose removal milestone is `engine-mvp-commander`.

Two corrections to the plan, both recorded in `think:396`. Buyback stays on the raw move with a comment: only an instant or sorcery resolves there and a commander is never one (CR 903.3), so routing it would be code no scenario can reach. And review found that a waiting move whose owner had lost would have blocked every later replaced move until elimination, while `draw_card` ignores that error, so another player's draw would silently not have happened. `move_card_replaced` now refuses only while the waiting move still stands and drops a lapsed one; a scenario covers it.

## Rules basis

From the engine's retained Comprehensive Rules snapshot (`crates/mtg-engine/src/cards/support/preview_sources/comprehensive-rules.txt`): 903.9b (the replacement, from anywhere, the owner's choice), 614.6 (a replaced event never happens), 400.3 (a hand or library is always the owner's, so the controller plays no part), 400.7 (an object that changes zones is a new object, which is why the waiting move is keyed by object), 800.4a (a leaving player's objects leave the game), 903.3 (what can be a commander). 903.9a is cited only to mark what this unit does not implement; 903.9c (melded and merged commanders) is out of scope.

## Evidence

`crates/mtg-engine/tests/commander_zone_replacement.rs`, written first against compile-level stubs: 13 of 17 failed on behavior and the four negative controls passed. The suite now holds 18 scenarios.

1. A commander that would be drawn is asked about at the move: the library was not empty, the card has not moved, the owner gets yes or no; yes puts it into the command zone, no card is drawn and the next card stays in the library.
2. A decline draws the commander, and the next draw is an ordinary one.
3. A two-card draw effect waits for the answer and then finishes its other draw; the answer's outcome carries the completed resolution. Both answers.
4. A commander that is the second of three draws leaves exactly one draw after the answer. Both answers.
5. From the battlefield, a graveyard, exile and the command zone, to a hand and to a library, with both answers; a commander that stays in the command zone stays the same object.
6. Other destinations and a move within the zone ask nothing.
7. A stolen commander asks its owner; the controller is offered nothing and their answer leaves canonical bytes unchanged.
8. An identical card that is not a commander is never asked about, moved or drawn.
9. In a four-owner mirror pod each commander is its own owner's choice, in reverse seat order with mixed answers; while one move waits a second is refused with bytes unchanged, and no other player can answer.
10. The state-based return is still its own request and a replacement answer does not answer it.
11. While a move waits a cast is refused, describing a cast is refused, the other player is offered nothing, the owner is offered only the request, and the action validator admits only the owner's valid answer; afterwards everything is legal again.
12. A forged state hash, a wrong option, two options, a resolution-spelled answer, a return-spelled answer and a repeated answer all change nothing.
13. A waiting move is in the versioned canonical bytes, survives restore, and the restored game executes the answer.
14. A leaving owner takes their waiting move; a leaving thief does not take the owner's.
15. An owner who has lost is not asked, and an owner who loses while their move waits no longer holds up anybody else's.
16. The game loop asks only the owner, once, in the draw step; a replaced draw is not logged as a draw and a declined one is.
17. The game loop pauses with `ResolutionChoiceRequired` for an owner without an agent and, resumed, draws once, not twice.
18. The game loop asks the owner inside a resolving draw effect and completes the resolution.

Neither answer leaves an arrival or an offer for the state-based rule; scenarios 1, 2 and 9 assert it, and the existing state-based scenario that a raw hand or library move opens no offer still passes unchanged.

### Mutation evidence

`cargo-mutants` 27.1.0 over the unit's diff, on copies of the tree: 80 mutants in 6 minutes: 49 caught, 24 unviable, 4 timeouts and 3 missed. All four timeouts make an answer never close, so the game loop runs into the test timeout. The misses:

- `count + drawn - 1` for the remaining draws is the same number when the commander is the first card drawn, which was the only case covered. Scenario 4 was added and the mutant confirmed caught on a scratch copy.
- `remaining >= 0` pushes a frame of zero draws, which does nothing: equivalent.
- The filter that withholds the game log's "Completed resolving object" line while the resolution still waits on a further request. It is log text only, and no fixture combines a replaced draw with a later request in one resolution.

### Gates

Recorded on engine `main`: workspace check with all targets including the desktop crate, Clippy with pedantic warnings denied (the first run failed on a too-long game-loop function, which was split), rustfmt, 1,827 tests (3 pre-existing skips) plus doctests. One existing test changed by design: the `commander_setup` assertion that pins the snapshot version. On the pin task: clean-clone identity before and after the locked offline arm64 release worker build, the empty-directory self-check, contract sync and check, 152 native MCP tests against the clean-clone binary (unchanged: the preview never names a commander), the 13-test evidence requalification run in the clean clone, and the census check.

## Evidence update

The served snapshot did not move; the ledger is byte-identical. The first update run, read before anything else, reported the engine changed, the owner-less `engine_revision` unit for the three `intrinsic-basic-mana` rows, and the already-owned `baseline_corpus` unit. The generated files were restored from Git, the basic-mana evidence was re-run in the clean clone at the pin, `CORE_SUPPORT_REVISION` was re-pinned, and the binding run wrote the committed [requalification record](../evaluation/engine-any/requalification-v1.json) with the engine same and only the owned `baseline_corpus` unit open.

## Limits

- Draws are the only production movers that reach a hand today. A future bounce, tuck, mulligan or library-manipulation effect must move through `move_card_replaced` and resume after the answer; the raw facade still moves a commander to a hand or library without asking, which setup and fixtures rely on.
- One move waits at a time. An effect that moves several cards at once must suspend per card, in APNAP order of their owners when they differ (CR 101.4).
- The rule may apply more than once to one event (the exception to CR 614.5) and interacts with other replacement effects through CR 616.1. No other replacement effect can match these moves yet, so neither is observable.
- A declined draw emits a zone-change event, which an ordinary draw does not. Draws emitting it generally is event work, not this unit's.
- The heuristic and search agents always say yes, because the request lists yes first. Choosing to draw a commander is policy work on `engine-mvp-policies`.
- Melded and merged commanders (CR 903.9c) are any-deck layout work.
- The worker still answers `commander_preflight_unavailable` and `commander_admission_unavailable`, and decisions are not relayed through the worker protocol yet (`engine-mvp-decision-relay`); admission and the integrated mirror pod stay with `engine-mvp-commander`.
