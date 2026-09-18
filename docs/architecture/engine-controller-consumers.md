# Current control throughout the remaining gameplay consumers

Accepted for `engine-mvp-controller-consumers` under the [engine charter](../ENGINE-CHARTER.md), completing the follow-up that [canonical mana eligibility](engine-mana-eligibility.md) filed. Native Magistr records hold execution status; reasoning `think:357` opens the unit and the closing synthesis is linked from the chunk.

The [source pin](../../engine/source.json) advances to canonical `mtg-game-engine` commit `6bee9064eba38adbf9bfcb2d970ecb0b8c20af20` on `main`. The root `Cargo.lock`, the worker protocol and every generated contract derivative are byte-identical; only the manifest's source revision changes.

## What remained and what was delivered

The eligibility unit made the layer-derived controller (`GameState::controller_of`, `controlled_permanents`, `DerivedCharacteristics`) the only owner of current control and migrated mana activation, ordinary activation, untapping and attacking. Its independent review named the consumers that still read printed ownership as if it were control. This unit audited every `owner_of` and `cards_in_zone_owned_by` caller in the engine workspace and separated the two meanings:

| Consumer                                                                   | Before                                                             | Now                                                                                                                                                  |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `combat/block.rs` `validate_blocker`                                       | owner as the defending player; printed type, keywords, colors, P/T | derived controller (CR 509.1a); current type, keywords, colors and power for the blocker and the attacker's evasion                                  |
| `combat/block.rs` `legal_blockers`                                         | battlefield cards owned by the defender, printed creature type     | `controlled_permanents` filtered by current creature type and untapped status, so the generated choices are exactly what `declare_blockers` accepts  |
| `combat/damage.rs` lifelink recipient                                      | owner of the attacker or blocker                                   | derived controller (CR 702.15b)                                                                                                                      |
| `combat/triggers.rs` `find_controller` (`CombatDamageToPlayer.controller`) | owner, active player when absent                                   | `controller_of`, active player only when the source has already left the battlefield                                                                 |
| `abilities/loyalty.rs` `activate_loyalty_ability`                          | owner must equal the activating player                             | `controller_of` must equal the activating player (CR 606.3)                                                                                          |
| `sba/mod.rs` legend rule                                                   | grouped by owner                                                   | grouped by derived controller (CR 704.5j); the surplus copy still goes to its owner's graveyard                                                      |
| `turn/heuristic_agent.rs` board reads and burn/buff target scoring         | battlefield by owner, printed characteristics                      | `controlled_board` (controlled permanents with derived characteristics) and `controller_of`; the policy evaluates what each player actually controls |
| desktop `commands/play.rs` `build_player_snapshot`                         | battlefield grouped by owner                                       | battlefield grouped by `controlled_permanents`; hand, library, graveyard, exile and command counts remain ownership                                  |

Ownership keeps its meaning everywhere it is the rule: hand, library, graveyard, exile and command reads for drawing, discarding, casting from hand, mulligans and determinization; `ZoneChanged.owner` and graveyard destinations in state-based actions, resolution and selected costs; discard and graveyard-exile cost candidates; the layer-2 base controller in `DerivedCharacteristics::from_card` (a permanent's default controller is its owner until an effect changes it); canonical setup; the CLI's `owner:` labels; and the desktop coverage sample over all of a player's zones. No new service was added: every migrated consumer calls the existing owner.

## Rules basis

From the pinned Comprehensive Rules corpus (SHA-256 `4381ad1b…`, effective 2026-08-07): CR 108.3 and 110.2 separate owner from controller; CR 509.1a lets the defending player declare only creatures they control; CR 702.15b has the lifelink source's controller gain the life; CR 606.3 lets only the controller activate loyalty abilities; CR 704.5j applies the legend rule to permanents one player controls and sends the surplus to the owners' graveyards.

## Independent evidence

Canonical `tests/controller_consumers.rs` holds nine scenarios written before the migration (eight failed on owner-as-controller proxies, the ownership guard passed):

- A stolen creature blocks for its controller: it appears in Bob's legal blockers only, every listed blocker validates, the owner's declaration is rejected with identical state bytes and the controller's declaration executes.
- Regaining control restores the owner as the blocker and removes the thief.
- Blocker legality uses current characteristics: printed keywords cannot block a flyer, granted reach can, and a permanent that currently is not a creature is neither listed nor valid.
- A stolen lifelink attacker gains life for its controller, and the emitted combat-damage trigger names the controller; a stolen lifelink blocker and a stolen creature with granted lifelink gain for the controller.
- A stolen planeswalker rejects the owner before any counter moves and lets the controller activate, with the ability on the stack under the controller and once-per-turn recorded.
- Two same-name legends under different controllers coexist; stealing one applies the legend rule and the surplus returns to its owner's graveyard.
- Ownership-only zone reads are unchanged by control.

Four temporary mutations each fail at least one scenario and were reversed: reverting the blocker controller to the owner fails two; reverting the lifelink attacker recipient fails two; reverting loyalty activation fails one; reverting the legend rule fails one.

Recorded gates on engine `main`: workspace check with all targets including the desktop crate, 1,665 tests (3 pre-existing skips), 110 doctests, strict Clippy with pedantic warnings denied, rustfmt. No existing test changed. Clean-clone identity checks before and after the locked offline arm64 release worker build, the empty-directory self-check, contract sync and check, 147 native MCP tests against the clean-clone binary and the 13-test evidence requalification run are recorded on the pin task; MCP typecheck, tests and lint on the verification task.

## Evidence update

Advancing the pin ran the [evidence maintenance workflow](engine-evolution-rules-evidence.md). Only the engine moved: the served snapshot is unchanged (pool +0 −0 ~0, no ban, keyword, rules, rulings, vocabulary, construction or policy change). The first run reported the owner-less `engine_revision` unit for the three `intrinsic-basic-mana` rows plus the already-owned `baseline_corpus` unit. The rows' evidence was re-run in the clean clone at `6bee906` under the unchanged `core-support-v1` implementation, `CORE_SUPPORT_REVISION` was re-pinned, and the second run bound the [requalification record](../evaluation/engine-any/requalification-v1.json) with the census matching the served snapshot; the only open unit is the owned `baseline_corpus` one on `engine-mvp-corpus`.

## Boundaries and retained work

Attack-target legality is still not validated: `declare_attackers` accepts any `AttackTarget::Planeswalker` without checking that the planeswalker is on the battlefield under an opponent's control (CR 508.1a). That needs a new serialized `CombatError` variant and belongs to `engine-mvp-combat-objects`, which now depends on this unit. Loyalty activation is not enumerated by `enumerate_actions` or presented by the decision surface, so choice/execution agreement is proved here for blockers only; presenting loyalty activations belongs to `engine-mvp-planeswalkers` with the unified decision interface. The CLI console still labels battlefield cards by owner only. Four-player defending-player selection, multiple-blocker damage order and policy blocking remain with the multiplayer and combat-object units.
