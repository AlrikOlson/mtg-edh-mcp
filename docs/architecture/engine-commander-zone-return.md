# Returning a commander to the command zone as a state-based action

Accepted for `engine-commander-zone-return` under the [engine charter](../ENGINE-CHARTER.md). It is the third Commander rule unit split out of `engine-mvp-commander` and builds on [Commander setup](engine-commander-setup.md) and [command casting and tax](engine-commander-cast-tax.md). The research finding and split are `think:391`, the plan is `think:392` and the verification finding is `think:393`. Native Magistr records hold execution status.

The [source pin](../../engine/source.json) advances to canonical `mtg-game-engine` commit `7cf2ff1134331a3a7c87b1b80675a7ccdc1d9d1c` on `main`. The root `Cargo.lock`, the worker protocol and every generated contract derivative are byte-identical; only the manifest's source revision changes.

## Scope, and the split

The chunk as filed covered two rules: the state-based choice from a graveyard or exile (CR 903.9a, 704.6d) and the replacement for a hand or library (CR 903.9b). Research showed they share nothing but the destination. The engine's only suspended choice was a resolution frame on the top stack object, and `ReplacementRegistry::apply_replacements` has no production caller, so no zone move consults the replacement owner yet. Each rule therefore needs its own machinery, and each is independently testable. This unit delivers the state-based path. The replacement is the new pending chunk `engine-commander-zone-replacement`, which depends on this one; `engine-mvp-commander` depends on both. The original acceptance sentence, that the two paths are independently proven and neither implements the other, is carried by the pair.

## What was delivered

| Owner or consumer                                             | Before                                       | Now                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `commander::CommanderRegistry`                                | designations and command-cast history        | also serialized `zone_arrivals` (commander objects put into a graveyard or exile since the last check) and `return_offers` (opened, not yet answered), both keyed by card and object. Record, take, open and close are crate-private                     |
| `game_state::ZonesMut::move_card`, `move_card_from`           | moved and reconciled control                 | also note a commander whose destination is a graveyard or exile. Every production move passes this facade, and it is the one place that sees both the move and the designation. Hand and library destinations record nothing                             |
| `sba::commander_return` (new, inside the SBA owner)           | did not exist                                | `open_offers` runs first in `check_and_perform`, keeps arrivals that are still the same object, still a commander and owned by a player who has not lost, and orders them by APNAP. `pending_offer` presents the request; `answer_offer` executes it     |
| `decisions`                                                   | pending request was a resolution choice only | `DecisionRequest::CommanderReturn`, `DecisionResponse::CommanderReturn`, `DecisionOutcome::CommanderReturn { card_id, returned }`. `pending_decision` presents an open offer first; while one is open `decision_requests_of` lists only it, to its owner |
| `GameState::choice_pending`                                   | five guards each asked `is_resolving`        | one predicate, suspended resolution or open offer, used by the casting, activation, loyalty, trigger-placement and request-description guards and by the action enumerator                                                                               |
| Action validator and the heuristic, search and console agents | accepted a resolution request                | accept either request through the existing `Action::ChooseResolution`, so logs and transcripts keep one spelling. The console agent previously conceded on any other pending request                                                                     |
| `game_loop::check_state_based_actions`                        | looped while a check performed actions       | answers open offers after each check, before triggers are placed, repeats the check when an offer was answered, pauses with `ResolutionChoiceRequired` for an owner without an agent, and charges the execution budget per offer                         |
| `CommanderRegistry::remove_owned_by`                          | dropped designations and cast history        | also drops the arrivals and offers of the leaver's cards                                                                                                                                                                                                 |
| `snapshot::CORE_SNAPSHOT_VERSION`                             | 10                                           | 11, because serialized fields were added. Nothing in the worker contract or MCP reads the version                                                                                                                                                        |

## Ownership and reuse review

- **One Commander state.** Arrivals and offers live in the registry beside the designation they refer to. They are keyed by object as well as card because the rule speaks of the object that was put there, and a card that moved again is a new object (CR 400.7). A first draft also checked the zone when validating an arrival; the object check already implies it, so the redundant check was removed and the facade is the only place that decides which destinations count.
- **One recorder.** The zone manager does not know about commanders and the registry does not know about zones. The `ZonesMut` facade already existed as the single mutation path with the whole state in reach, the same seam that reconciles control on every move. No mover was changed.
- **The SBA owner keeps the action.** Opening and answering live in `sba`, not in `decisions` or the game loop. Opening runs first in a check, so what that check itself puts into a graveyard is seen by the next one; by then the dies and leaves-the-battlefield events have fired. Opening performs nothing and does not report an action.
- **One presentation.** The offer reuses `ChoiceRequest` with kind `Optional` and options yes then no, so the shared first-legal-answer default returns the commander. It is a distinct request and response kind, so a resolution answer cannot answer an offer and the two owners never execute each other's responses.
- **One blocking predicate.** Five guards and the enumerator asked `is_resolving` separately. They now ask `GameState::choice_pending`. The game loop keeps `is_resolving` for its step and priority cursors, which are about the stack.
- **Not the replacement.** A commander moved to a hand or library records no arrival and opens no offer, with a scenario proving it. CR 903.9b is left entirely to `engine-commander-zone-replacement`.
- **Overlap.** None added. The desktop's commander-in-hand setup remains the duplicate path whose removal milestone is `engine-mvp-commander`.

## Rules basis

From the engine's retained Comprehensive Rules snapshot (`crates/mtg-engine/src/cards/support/preview_sources/comprehensive-rules.txt`): 903.9a and 704.6d (a commander in a graveyard or in exile that was put there since the last state-based check may be put into the command zone by its owner), 704.3 (a check that performed actions is repeated; only then are waiting triggers put on the stack), 400.7 (an object that changes zones is a new object), 101.4 (simultaneous choices are made in APNAP order), 800.4a (a leaving player's objects leave the game and control effects they held end). 903.9b is cited only to mark what this unit does not implement.

## Evidence

`crates/mtg-engine/tests/commander_zone_return.rs`, written first against compile-level stubs: 13 of 16 failed on behavior and the three negative controls passed. The suite now holds 18 scenarios.

1. A commander that died is not offered by the check that destroyed it; the next check offers it to its owner as yes or no, and yes moves it to the command zone, still a commander, with no further offer.
2. A declined offer leaves the commander in the graveyard and is never repeated.
3. The commander's dies trigger is already pending when the offer opens and is still pending after the return.
4. A commander countered by a real counterspell is offered from the graveyard, and the returned commander owes its tax.
5. A commander put into exile is offered too.
6. A stolen commander's owner chooses; the controller's answer is refused and leaves canonical bytes unchanged.
7. An identical card that is not a commander records no arrival and is never offered, from the graveyard or from exile.
8. In a four-owner mirror pod three commanders are exiled in reverse seat order; the arrival order is asserted, and the offers are asked in APNAP order to each commander's own owner with mixed answers.
9. An arrival reanimated before any check lapses.
10. A hand or library arrival records nothing and opens nothing.
11. While an offer is open a cast is refused, describing a cast is refused, the other player is offered nothing, the owner is offered only the offer, and the action validator admits only the owner's valid answer; after the answer everything is legal again.
12. A forged state hash, a wrong option, two options, a resolution-spelled answer and a repeated answer all change nothing.
13. An arrival waiting for its check and an open offer are both in the versioned canonical bytes, survive restore, and the restored game executes the answer.
14. A leaving owner takes their open offer; another owner's open offer remains and is answered.
15. A player who loses in the same check that opened their offer is not asked, and no choice is pending.
16. A commander a leaving player had stolen returns to its owner's control without an offer, because the control effect ends and nothing is exiled.
17. The game loop asks only the owner, once, for yes and for no, and the commander ends in the matching zone.
18. The game loop pauses with `ResolutionChoiceRequired` for an owner without an agent, leaving the offer pending.

A registry unit test covers a leaving player taking the arrivals and offers of their own cards only.

Two scenarios I first wrote were wrong, not the engine: one funded mana after capturing the request, which changed the state hash, and one assumed a leaving thief's stolen permanent is exiled, when the elimination owner ends the control effect first.

### Mutation evidence

- **Hand mutants, first run:** 14 of the first 15 were caught. The survivor asked offers in arrival order instead of APNAP: the scenario killed the commanders through the state-based check, which processes cards in id order, so arrival order matched seat order by chance. The scenario now exiles in reverse seat order and asserts that arrival order; the mutant is caught.
- **A real defect found by a hang:** the run stalled twice on the mutant that leaves an answered offer open. With it the game loop's answer loop never ended, which showed that the loop did not charge the execution budget like every other loop in the game loop. It now does.
- **`cargo-mutants` 27.1.0 over the unit's diff, on copies of the tree:** 73 mutants in 6 minutes: 45 caught, 22 unviable, 2 timeouts and 4 missed. Both timeouts make an offer never close. Of the misses, two replace whole pre-existing functions (`ActionValidator::validate`, `push_triggered_ability_with_declaration`) whose tests are outside the scoped run; one replaced the request-description guard, and scenario 11 now asserts it; one makes an answer not repeat the check, which nothing in today's engine can observe (see Limits).
- **Rule-specific mutants a generator cannot express, run on a scratch copy:** leaving keeps offers, leaving clears every offer, an open offer does not block, offers skipped in serialization, arrivals skipped in serialization, the validator ignores the offer: 6 of 6 caught.

The in-place hand script is retired. It edited the real checkout, left a mutant applied each time it was interrupted, and rebuilt the whole crate per mutant. `engine-mutation-testing-practice` is filed as pending work to make the diff-scoped `cargo-mutants` run the standard.

### Gates

Recorded on engine `main`: workspace check with all targets including the desktop crate, Clippy with pedantic warnings denied, rustfmt, 1,809 tests (3 pre-existing skips) plus doctests. On the pin task: clean-clone identity before and after the locked offline arm64 release worker build, the empty-directory self-check, contract sync and check, 152 native MCP tests against the clean-clone binary (unchanged: the preview never names a commander), the 13-test evidence requalification run in the clean clone, and the census check.

## Evidence update

The served snapshot did not move; the ledger is byte-identical. The first update run, read before anything else, reported the engine changed, the owner-less `engine_revision` unit for the three `intrinsic-basic-mana` rows, and the already-owned `baseline_corpus` unit. The generated files were restored from Git, the basic-mana evidence was re-run in the clean clone at the pin, `CORE_SUPPORT_REVISION` was re-pinned, and the binding run wrote the committed [requalification record](../evaluation/engine-any/requalification-v1.json) with the engine same and only the owned `baseline_corpus` unit open.

## Limits

- A commander that would go to its owner's hand or library still goes there. That is `engine-commander-zone-replacement`.
- An answered offer repeats the state-based check, as CR 704.3 requires, but no current engine behavior depends on it, so no test distinguishes it. It becomes observable when something reacts to a commander entering the command zone.
- An owner who has lost is not asked; their cards leave with them in the same check. In a game that ends at that moment the final position keeps the unanswered arrival as evidence.
- The heuristic and search agents always say yes, because the request lists yes first. Choosing to leave a commander in the graveyard, for example for Muldrotha, is policy work on `engine-mvp-policies`.
- Melded and merged commanders (CR 903.9c) are any-deck layout work.
- The worker still answers `commander_preflight_unavailable` and `commander_admission_unavailable`, and decisions are not relayed through the worker protocol yet (`engine-mvp-decision-relay`); admission and the integrated mirror pod stay with `engine-mvp-commander`.
