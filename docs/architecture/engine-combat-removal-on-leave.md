# Leaving combat: permanents that leave the battlefield or change controller

Accepted for `engine-combat-removal-on-leave` under the [engine charter](../ENGINE-CHARTER.md). The defect was found while closing [multiplayer combat](engine-multiplayer-combat.md) (`think:370`); the research finding and plan are `think:376` and the implementation findings `think:377`. Native Magistr records hold execution status.

The [source pin](../../engine/source.json) advances to canonical `mtg-game-engine` commit `3bc0fd248a02dffad18f959965f8df8c5bdd1da7` on `main`. The root `Cargo.lock`, the worker protocol and every generated contract derivative are byte-identical; only the manifest's source revision changes.

## What was wrong

`CombatState::remove_combat_participant` already modelled removal from combat correctly: a removed attacker frees its blockers, a removed blocker leaves its attacker blocked, and an attacked planeswalker releases its attackers, who keep attacking nothing. Its only production caller was player elimination. Nothing called it when a creature died, was exiled or returned to hand, or changed controller.

- An attacker killed in the first-strike damage step still dealt its regular damage from the graveyard, because damage resolution looked the card up in any zone. The same held for a blocker killed by a first-striking attacker.
- A stolen attacker kept attacking for the player who no longer controlled it.
- Once removal works, a second defect appears: the regular damage sub-step called the resolver unguarded, and the resolver reports an error when there is no attacker. A lone attacker dying to first strike would have paused the game as a failure.

## What was delivered

| Owner or consumer                     | Before                                           | Now                                                                                                                                                                                                                              |
| ------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GameState::reconcile_control`        | tracked incarnation and controller per permanent | also calls `remove_combat_participant` for every permanent whose history is dropped (it left the battlefield), whose incarnation changed or whose layer-derived controller changed. It is the primitive's only production caller |
| `elimination::forget_object`          | called the primitive itself                      | call removed as overlap; removing or exiling the departed player's objects reaches combat through the owner above                                                                                                                |
| `GameLoop`, regular damage sub-step   | always resolved                                  | skipped when first strike left no attacker                                                                                                                                                                                       |
| `combat::damage` attacker and blocker | any card found in any zone assigned damage       | a participant absent from the layer-derived battlefield view assigns none (CR 510.1)                                                                                                                                             |

## Ownership and reuse review

Every zone mutation (`ZonesMut`) and every continuous-effect mutation (`EffectsMut`) already ends in `reconcile_control`, which compares each battlefield permanent's incarnation and derived controller with its history. Those transitions are exactly the first two causes in CR 506.4, so one call site covers destruction, sacrifice, exile, return to hand, flicker, theft, theft ending and elimination without touching any individual effect.

The alternative, calling the primitive from `ZoneManager::move_card` and separately from control effects, was rejected: the zone manager does not own combat, control derives from layers, and an expiring control effect would have needed a third call site.

Removal is driven by transitions, not by sweeping combat for anything that is not on the battlefield, so fixtures that build a `CombatState` from bare identifiers are unaffected. No TypeScript, worker protocol or MCP route changed.

## Rules basis

Wizards' Comprehensive Rules effective 2026-08-07, read from the published text during this unit: 506.4 (causes and consequences of removal from combat), 506.4b (tapping does not remove), 506.4c (attackers of a removed planeswalker keep attacking nothing), 509.1h and 510.1c (a blocked attacker with no blocker left assigns no damage), 702.19e (unless it has trample), 510.1 and 510.4 (only remaining attackers and blockers assign damage in the second step), 400.7 (a returning object is new).

## Evidence

`crates/mtg-engine/tests/combat_removal.rs` was written first. Eleven of its twelve original scenarios failed on behavior and the twelfth, a control, passed. A thirteenth was added with the resolver guard.

- Through the game loop: an attacker killed by a first striker deals nothing and the game continues; a blocker killed by a first-striking attacker deals nothing; at four seats only the dead attacker stops dealing damage while an attack on another player lands.
- Through the state's own combat: attacker and blocker leaving to the graveyard, exile and hand; a trampler whose only blocker left assigns everything to the player; a flickered creature is outside combat; a stolen attacker, a stolen blocker, and control reverting when the control effect is removed; an attacked planeswalker exiled or stolen.
- Control: tapping, untapping, counters, marked damage, and a bystander dying or being stolen leave combat untouched.
- A caller-held combat that still names dead creatures gets no damage from them.

Destruction and sacrifice are the same zone change to the graveyard and share one fixture; no sacrifice-specific path exists to test separately.

Seven mutations were applied and restored byte for byte (SHA-256 checked): never recording departed permanents, never recording changed ones, comparing incarnation but not controller, the unguarded regular sub-step, the attacker guard removed, the blocker guard removed, and a removed blocker unblocking its attacker. All seven are caught. The first also fails the existing elimination scenario in `multiplayer_combat.rs`, which shows elimination now genuinely depends on this owner.

One comparison is not independently observable for combat: a card cannot become a new battlefield object without first leaving, which the departed path already catches. The incarnation comparison is kept because it is the existing control-history condition.

Two-player and four-player results are otherwise unchanged: the whole engine suite, including seeded determinism transcripts and the stress runs, passes unmodified.

Recorded gates on engine `main`: workspace check with all targets including the desktop crate, Clippy with pedantic warnings denied (the first run failed on a by-value parameter in my test helper and was fixed), rustfmt, 1,726 tests (3 pre-existing skips) plus doctests. On the pin task: clean-clone identity before and after the locked offline arm64 release worker build, the empty-directory self-check, contract sync and check, 147 native MCP tests against the clean-clone binary, and the 13-test evidence requalification run in the clean clone.

## Evidence update

The served snapshot did not move; the ledger is byte-identical. The first update run, read before anything else, reported the engine changed, the owner-less `engine_revision` unit for the three `intrinsic-basic-mana` rows, and the already-owned `baseline_corpus` unit. The basic-mana evidence had been re-run in the clean clone at the pin and `CORE_SUPPORT_REVISION` re-pinned; the binding run wrote the committed [requalification record](../evaluation/engine-any/requalification-v1.json) with the engine same and only the owned `baseline_corpus` unit open.

## Roadmap reconciliation

- `engine-combat-damage-assignment` filed pending at priority 112, and `engine-mvp-combat-objects` now depends on it. Writing the control fixture showed that a blocked attacker without trample assigns only lethal damage and discards the rest (a 4/4 deals 2 to a 2/2), contrary to CR 510.1c, which also undercounts lifelink. Lethal is computed from printed toughness and a combat-local damage map. It is a separate owner and a separate tested unit.
- `engine-mvp-layers` gained: a creature that stops being a creature, or an attacked planeswalker that stops being one, leaves combat through the same single caller (CR 506.4, 506.4d).
- `engine-any-combat-families` gained the remaining causes: phasing, regeneration, effects that remove from combat, battles and protectors, and a blocker of a departed attacker remaining a blocking creature.

## Known limits

- Only leaving the battlefield and changing controller are implemented. The other causes in CR 506.4 need vocabulary that does not exist yet and are owned as above.
- When an attacker is removed its blockers are dropped from the blocker map. Damage is correct, but an effect asking for "blocking creatures" would not see them.
- Removal emits no event. Nothing in the vocabulary triggers on removal from combat.
