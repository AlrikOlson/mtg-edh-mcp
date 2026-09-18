# Combat damage assignment: a blocked attacker assigns all of its damage

Accepted for `engine-combat-damage-assignment` under the [engine charter](../ENGINE-CHARTER.md). The defect was found while closing [leaving combat](engine-combat-removal-on-leave.md); the research finding and plan are `think:382`. Native Magistr records hold execution status.

The [source pin](../../engine/source.json) advances to canonical `mtg-game-engine` commit `22550f93eff2c498fbb0a48a5126226035ce57ad` on `main`. The root `Cargo.lock`, the worker protocol and every generated contract derivative are byte-identical; only the manifest's source revision changes.

## What was wrong

`combat::damage::auto_assign_damage` is the one place a blocked attacker's damage is divided. It is reached only through `resolve_combat_damage`, whose single production caller is the game loop's damage sub-step.

- It gave each blocker lethal damage and stopped. Only trample used what was left, so a 4/4 blocked by a 2/2 dealt 2, and a lifelink attacker gained too little.
- Lethal was computed from the blocker's printed toughness, so a pump or shrink on the blocker was invisible to a trampler.
- Marked damage was read from a map inside `CombatState` that nothing in production ever wrote. The game loop marks damage on the zone record, so damage from the first-strike step, or from earlier in the turn, never counted toward lethal.
- `lethal_damage_threshold` never returned less than 1, so a blocker already dealt lethal damage still absorbed one point of a trampler's damage.

## What was delivered

| Owner or consumer                          | Before                                                   | Now                                                                                                                                                           |
| ------------------------------------------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `combat::damage::auto_assign_damage`       | lethal to each blocker, remainder dropped unless trample | the whole power is assigned: lethal to each blocker in order, the rest to the attacked player under trample and otherwise to the last blocker assigned damage |
| lethal amount                              | printed toughness, combat-local damage map               | layer-derived toughness (printed as fallback) and `ZoneManager::get_damage`                                                                                   |
| `combat::damage::lethal_damage_threshold`  | floor of 1                                               | zero once marked damage reaches toughness; deathtouch needs at most 1                                                                                         |
| `CombatState::marked_damage` and accessors | serialized map with no production writer                 | removed; the zone record is the only owner of marked damage                                                                                                   |
| `snapshot::CORE_SNAPSHOT_VERSION`          | 6                                                        | 7, because a serialized field was removed. Nothing in the worker contract or MCP reads the version                                                            |

## Ownership and reuse review

The zone record already serves both damage sub-steps: `GameLoop::resolve_damage_substep` marks each event on the permanent before state-based actions and the next sub-step run. A second map beside it could only drift, and in practice was always empty. Removing it leaves one owner of marked damage, cleared by the existing cleanup step.

The derived characteristics snapshot taken once per resolution already supplies power, keywords and controller to this module; toughness now comes from the same snapshot, not a second layer evaluation.

Under the current rules a blocked attacker's damage is "divided as its controller chooses" among its blockers, with no ordering requirement. Lethal in order with the remainder on the last blocker is one legal division, made automatically. The player's choice of division is owned by `engine-any-choice-forms`, which now names it as an acceptance item and names this function as the default it replaces. No TypeScript, worker protocol or MCP route changed.

## Rules basis

Wizards' Comprehensive Rules effective 2026-08-07, extracted from the published text during this unit: 510.1a (combat damage equal to power), 510.1c (one blocker is assigned all of it; several blockers divide it as the controller chooses), 702.19b (trample: lethal to every blocker first, counting damage already marked, then the excess to the player, planeswalker or battle), 702.2c (any nonzero deathtouch damage is lethal for assignment), 120.6 (damage stays marked until cleanup), 120.3e. A first fetch through a summarizing tool returned invented paraphrases and was discarded.

## Evidence

`crates/mtg-engine/tests/combat_damage_assignment.rs` was written first: fourteen scenarios at two and four seats, through the resolver and through the game loop. Eleven failed on behavior against the unchanged engine and three controls passed (too little power, plain trample, deathtouch with trample).

- A 4/4 blocked by a 2/2 deals 4; a 5/5 lifelink attacker blocked by a 1/1 gains 5; a four-seat game logs 4 damage, moves the attacker's controller from 40 to 44 life and leaves the two bystanders untouched.
- Several blockers: lethal in order with the remainder on the last; too little power stops where it runs out; deathtouch without trample assigns 1 and then the rest.
- Current state: a blocker pumped +0/+2 takes 4 of a trampler's 5; shrunk -0/-2 it takes 2; a pumped first blocker absorbs everything and the second gets none.
- Marked damage: 3 damage from earlier in the turn leaves 1 lethal; a blocker already dealt lethal damage takes none from a trampler; through the game loop, a 3/3 double-striking trampler blocked by a 0/5 deals 3, then 2 and 1 to the player.

Five mutations were applied and restored byte for byte (SHA-256 checked): the remainder dropped, printed toughness, marked damage ignored, the floor of one restored, the remainder on the first blocker. All five are caught.

One existing unit test pinned the floor of one and was changed deliberately. No other existing test changed: the whole engine suite, including seeded determinism transcripts and the stress runs, passes.

Recorded gates on engine `main`: workspace check with all targets including the desktop crate, Clippy with pedantic warnings denied, rustfmt, worker contract drift, 1,750 tests (3 pre-existing skips) plus doctests. On the pin task: clean-clone identity before and after the locked offline arm64 release worker build, the empty-directory self-check, contract sync and check, 152 native MCP tests against the clean-clone binary (unchanged: the baseline policy never blocks, so fixture games do not move), and the 13-test evidence requalification run in the clean clone.

## Evidence update

The served snapshot did not move; the ledger is byte-identical. The first update run, read before anything else, reported the engine changed, the owner-less `engine_revision` unit for the three `intrinsic-basic-mana` rows, and the already-owned `baseline_corpus` unit. The basic-mana evidence had been re-run in the clean clone at the pin and `CORE_SUPPORT_REVISION` re-pinned; the binding run wrote the committed [requalification record](../evaluation/engine-any/requalification-v1.json) with the engine same and only the owned `baseline_corpus` unit open.

## Roadmap reconciliation

- `engine-sba-deathtouch-indestructible` filed pending at priority 114, and `engine-mvp-combat-objects` now depends on it. A probe through the game loop showed a 0/5 dealt 1 deathtouch damage survives and an indestructible 3/1 dealt 2 damage dies: no state-based or destruction code reads either keyword (CR 702.2b, 704.5h, 702.12b). Assignment is correct; destruction is a separate owner and a separate tested unit.
- `engine-any-choice-forms` gained the combat damage division choice, for attackers, for blockers of several attackers (CR 510.1d) and for a trampler's excess.
- `engine-mvp-planeswalkers` gained the trample excess slot for an attacked planeswalker.

## Known limits

- The division is automatic. It is always legal, but a player cannot yet choose to spread damage differently.
- A trampler attacking a planeswalker leaves its excess on the last blocker, because the assignment has only a player slot. Legal, but the excess never reaches the planeswalker.
- Lethal for trample does not count damage other attackers assign to the same blocker in the same step (CR 702.19b); each attacker is assigned independently. Owned with the division choice.
- `CombatState` maps each blocker to one attacker, so a creature that can block several attackers (CR 510.1d) has no representation yet. Owned with the division choice.
- Deathtouch and indestructible do not yet affect destruction, as above.
