# Mana and early turns

## Inspect the model before interpreting a count

`analyze_mana_base {deck_id,expected_version}` returns library `mana_model`, separate `command_zone_mana_model`, per-face costs/sources and quantity coverage for supported, unsupported, unresolved and overridden cards. Legacy counts labeled `summary_basis:legacy_heuristic` are not simultaneous mana or availability. A role or `produced_mana` field is not an unconditional source.

Respect generic costs, colored pips and true colorless `{C}` separately. Source output bundles are alternatives per activation; symbols within a selected bundle are simultaneous. Read activation costs, tapped entry, summoning delay and unsupported restrictions. Modal faces share one physical card. Recognized alternate/additional/modified costs are outside the model; printed-cost support does not certify every casting rule.

Overrides are explicit bounded per-face assumptions with a required reason. They do not persist or create missing cards and are counted separately. Do not invent an override to turn an unsupported result into a claimed fact; use it only for a scenario assumption supplied or clearly authorized by the user, then report it with the outcome.

## One replayable scenario

```text
simulate_deck {"deck_id":"DECK_ID","mode":"sequence","seed":7,"max_turns":5,"on_the_play":false,"target":{"oracle_id":"TARGET_ORACLE_ID","face_index":0,"zone":"command"}}
```

Use the target's real Oracle ID. `zone:library` needs a physical drawn copy; `zone:command` uses the saved command zone. Companion is excluded. Omit target for the first supported spell. Pass current `expected_version` when tying the report to a reviewed deck. `on_the_play:true` is the compatibility default and skips turn-one draw; use false for a first-turn draw, including the usual multiplayer Commander scenario. No actual mulligan redraw or bottoming occurs.

The policy plays the first eligible land in hand/face order, reserves named spell-target copies, tries the target, pays eligible accelerants in hand order and retries. Bounded exact payment search respects output choices, activation payment, paid rocks, source reuse, mana floating within the main phase, tapped entry and creature delay. Supported fetches consume a real remaining basic and put it in tapped; remaining library order stays fixed as a declared scenario assumption.

Inspect `sequence.turns` for draws, physical-copy actions, payments, cast and remaining pool. `sequence.replay` checks the trace independently against canonical source models and a reconstructed zone ledger. `physical_cards`, `library_order` and `sequence_options` retain replay inputs. A successful target payment ends further spells without resolving that spell's effects; subsequent land turns can continue. It does not model stack, opponents, combat, replacement effects, extra land drops, arbitrary effects, commander tax or recasts.

Bounds are 512 physical cards, 50 turns, 128 source actions per turn and `max_work` 1–50,000. Distinguish success, failure, unsupported and truncated outcomes. Failure means this policy found no successful payment within the scenario, not that every legal order fails. Truncation is not negative evidence. Success is conditional on excluded/overridden model coverage and stated assumptions.

## Aggregate hands

Default aggregate mode samples seeded opening hands. Keepable/mulligan rates and shape buckets are land/role heuristics, without simulating mulligan decisions. First-spell and land averages use only completed bounded sequences; inspect completed, truncated, unsupported and unprocessed counts plus the 2,000,000-unit total work cap. When `sequencing.metrics_available:false`, numeric zero averages are compatibility placeholders, not measurements.

Report the sample size, seed, draw policy, model coverage and completed fraction alongside any rate. These are conditional policy samples, not optimal castability, Commander win rates or confidence in an actual gameplay outcome. More trials do not repair unsupported rules or a systematically limited sequencing policy.
