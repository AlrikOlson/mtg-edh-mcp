# Destruction keywords: deathtouch destroys and indestructible permanents stay

Accepted for `engine-sba-deathtouch-indestructible` under the [engine charter](../ENGINE-CHARTER.md). The defect was found while closing [combat damage assignment](engine-combat-damage-assignment.md); the research finding and plan are `think:384`. Native Magistr records hold execution status.

The [source pin](../../engine/source.json) advances to canonical `mtg-game-engine` commit `e7b3107f4ba04c27e6461281610e55ae6fa01b6f` on `main`. The root `Cargo.lock`, the worker protocol and every generated contract derivative are byte-identical; only the manifest's source revision changes.

## What was wrong

`sba::check_creature_lethal_damage` was the engine's only destruction. It compared marked damage with layer-derived toughness and read no keyword.

- A creature dealt damage by a deathtouch source, but less than its toughness, survived. The combat damage event carried a deathtouch flag that was used only for the log line; noncombat damage never looked at its source at all.
- An indestructible creature with lethal damage was put into the graveyard.
- No destroy effect exists yet, so nothing else needed the keyword, and nothing would have applied it once one was added.

## What was delivered

| Owner or consumer                       | Before                             | Now                                                                                                                                                                                                            |
| --------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ZoneManager` damage record             | marked damage only                 | an ordered set of creatures dealt deathtouch damage, beside marked damage; one writer entry `mark_damage_from(card, amount, deathtouch)`; cleared wherever damage is cleared; drained by the state-based check |
| `GameLoop::resolve_damage_substep`      | marked the amount, logged the flag | passes the event's deathtouch flag to the zone record                                                                                                                                                          |
| `resolution::execute_deal_damage`       | received no source                 | receives the source and reads its deathtouch: layer-derived for a permanent, printed for a source elsewhere, such as a resolving spell                                                                         |
| `sba::destroy_permanent`                | did not exist                      | the engine's only destruction (CR 701.8a): refuses a permanent whose layer-derived keywords include indestructible, otherwise moves it to its owner's graveyard and emits the zone change                      |
| `sba::check_creature_lethal_damage`     | moved the creature itself          | destroys through the owner                                                                                                                                                                                     |
| `sba::check_creature_deathtouch_damage` | did not exist                      | CR 704.5h: takes the deathtouch facts from the zone record and destroys each creature with toughness above zero through the owner                                                                              |
| `StateBasedAction`                      | no deathtouch variant              | `CreatureDeathtouchDamage`; the planeswalker loyalty comments now cite 704.5i instead of 704.5h                                                                                                                |
| `snapshot::CORE_SNAPSHOT_VERSION`       | 7                                  | 8, because a serialized field was added. Nothing in the worker contract or MCP reads the version                                                                                                               |

## Ownership and reuse review

The zone record already owns marked damage, is written by both damage paths and is cleared by cleanup and by leaving the battlefield. The deathtouch fact lives beside it for the same reason the combat-local damage map was removed last unit: a second place could only drift, and a combat-only place would miss noncombat damage. The set is ordered, so the canonical snapshot encoding and the check need no sorting step and the snapshot's list of hash sets did not grow.

The check forgets the facts whether or not it destroys. Rule 704.5h looks at damage dealt since the last check, so an indestructible creature dealt deathtouch damage does not die later in the turn when it loses the keyword; it still dies to lethal marked damage, which persists until cleanup.

Destruction has one owner because indestructible is a property of destruction, not of any one cause. Zero toughness, the legend rule and sacrifice are not destruction (CR 701.8b, 704.5f, 701.21a) and do not go through it, which is why an indestructible creature still leaves for those reasons. The check takes the derived characteristics the state-based pass already computed; the public entry computes them once for outside callers.

No destroy effect vocabulary was added. It would touch the parser, the action enumerator, the agents and coverage, which is the scope of `engine-mvp-effects`; that chunk now requires every destroy effect to resolve through this owner. No TypeScript, worker protocol or MCP route changed.

## Rules basis

Wizards' Comprehensive Rules as retained in the engine's checksummed rules snapshot: 701.8a-b (destroy; only "destroy" effects and the 704.5g and 704.5h actions destroy), 702.2b and 704.5h (deathtouch damage since the last check destroys a creature with toughness above zero), 702.2d (deathtouch works from any zone), 702.12b (indestructible permanents can't be destroyed and ignore 704.5g), 704.5f (zero toughness is not destruction), 701.21a (sacrifice is not destruction), 120.3e and 120.6 (damage is marked and stays until cleanup).

## Evidence

`crates/mtg-engine/tests/destruction_keywords.rs` was written first: fifteen scenarios at two and four seats, through the game loop, the spell resolver and the state-based check. Against compile-only stubs nine failed on behavior, four controls passed, and two passed only because nothing was destroyed by deathtouch yet; the mutants below prove those two.

- Deathtouch: at four seats a 1/1 deathtouch blocker and the 5/5 it blocks both die and no life total moves; a 2/2 deathtouch attacker gives one damage to each of two 0/5 walls and both die; deathtouch gained through layers destroys and deathtouch removed through layers does not; one noncombat damage from a deathtouch source destroys a 0/5 and the same damage from an ordinary source does not.
- The fact: it is part of the canonical core bytes and is cleared with the damage.
- Indestructible: at four seats a 2/2 indestructible blocker takes 2 from a 5/5 trampler, 3 tramples over and the blocker stays; an indestructible blocker survives deathtouch damage; the keyword gained through layers saves a lethally damaged creature and the keyword lost through layers lets the lethal damage destroy it; the destroy owner destroys an ordinary creature and refuses printed and layer-granted indestructible.
- Still dies: an indestructible creature with zero toughness is put into the graveyard, and one can be sacrificed through the real sacrifice choice.
- Checked once: an indestructible creature dealt deathtouch damage survives the check, then loses the keyword and still survives with its damage marked.

Seven mutations were applied and restored byte for byte (SHA-256 checked): indestructible ignored, the fact not consumed, the combat writer dropping the flag, the noncombat writer dropping the flag, printed instead of derived indestructible, the fact surviving `clear_damage`, and the 704.5h check removed. All seven are caught.

No existing test changed: the whole engine suite, including seeded determinism transcripts and the stress runs, passes.

Recorded gates on engine `main`: workspace check with all targets including the desktop crate, Clippy with pedantic warnings denied, rustfmt, 1,765 tests (3 pre-existing skips) plus doctests. On the pin task: clean-clone identity before and after the locked offline arm64 release worker build, the empty-directory self-check, contract sync and check, 152 native MCP tests against the clean-clone binary (unchanged: the baseline policy never blocks and the fixture has neither keyword), and the 13-test evidence requalification run in the clean clone.

## Evidence update

The served snapshot did not move; the ledger is byte-identical. The first update run, read before anything else, reported the engine changed, the owner-less `engine_revision` unit for the three `intrinsic-basic-mana` rows, and the already-owned `baseline_corpus` unit. The generated files were restored from Git, the basic-mana evidence had been re-run in the clean clone at the pin, `CORE_SUPPORT_REVISION` was re-pinned, and the binding run wrote the committed [requalification record](../evaluation/engine-any/requalification-v1.json) with the engine same and only the owned `baseline_corpus` unit open.

## Roadmap reconciliation

- `engine-mvp-effects` now requires every destroy effect to resolve through `sba::destroy_permanent` with an effect-level indestructible fixture, and every damage effect to mark damage through `mark_damage_from` with its source's deathtouch, including last-known information for a source that has left its zone (CR 702.2e, 608.2h).
- `engine-any-trigger-replacement-composition` now names the destroy owner as the place regeneration and other replacements of destruction attach (CR 701.8c, 701.19).
- `engine-mvp-combat-objects` depended on this unit and is no longer held by it.

## Known limits

- No destroy effect exists, so indestructible against "destroy" is proven at the owner, not through a resolving spell.
- A noncombat source that has left the zone it dealt damage from is read from its printed keywords, not from last-known information. Combat damage is unaffected: its flag comes from the characteristics snapshot taken when damage is resolved.
- Regeneration is not modeled; nothing replaces destruction yet.
- Damage to planeswalkers and battles is not marked through this record; deathtouch matters only for creatures (CR 702.2b).
