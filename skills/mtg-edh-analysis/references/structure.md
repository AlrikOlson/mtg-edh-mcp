# Structural analysis

## Pick the report that answers the question

| Question                             | Tool and evidence                                                                                                                       |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Is the saved deck legal?             | `validate_deck`: `ok`, exact error/warning counts and violations. Echoes cap at 50; 100 cards alone proves nothing.                     |
| Is one prospective addition allowed? | `validate_card {deck_id,card,qty}`: card-scoped identity/banlist/singleton checks, without mutation.                                    |
| Is this command zone allowed?        | `validate_commander`: saved `deck_id`, or transient commanders and command-zone kind.                                                   |
| What is the overall standing?        | `deck_status`: vitals, legality, curve, mana overview, role gaps and scoped pricing.                                                    |
| Is the curve overloaded?             | `analyze_curve`: quantity-weighted buckets; optional `exclude_lands`, role or color filter.                                             |
| Which types/roles are present?       | `analyze_composition`: quantity-weighted counts. A multi-role card is still one physical card.                                          |
| What are the precise numbers?        | `analyze_stats`: counts, average mana values, pips and prices. Counts are library scope; full-deck pricing is separate.                 |
| What roles fall outside targets?     | `analyze_role_coverage`: explicit `bands` override saved intent, which overlays default bands. Advisory, not legality.                  |
| How does this particular list work?  | `analyze_strategy`: actual command zone, library and authored intent, with evidence and dependencies.                                   |
| What addition addresses a gap?       | `meta_recommend`: local contextual default, expected version and evidence/tradeoffs. It does not choose the needed cut for a full deck. |

Use `deck_get_intent` to distinguish actual authored goals from analysis defaults. If role counts seem wrong, inspect `card_get`/`card_mechanics` and deck role overrides. `deck_set_roles` is an authorized correction, not an analysis-side trick to meet a target: lists replace, `[]` clears and `null` restores inferred defaults.

## Explain supported strategy precisely

`analyze_strategy` returns `nodes`, evidence-bearing `edges`, `dependencies`, `bottlenecks`, `redundancy`, `recovery_options`, resource `conflicts`, `win_condition_requirements` and `game_plan`. Pair the explanation with `declared_intent`; do not replace a niche build with a community archetype. It models the command zone and library, excluding the outside-deck companion. Quantities count copies; redundancy counts distinct identities.

A zero-provider dependency means the supported catalog found no suitable provider, not that the card is unplayable. One provider signals fragility, several possible redundancy. Coverage is bounded at 250 distinct identities and 32 annotations per card; presentation can truncate edges/conflicts. `unknown_incomplete` and `provider_search_complete:false` prevent absence claims; `not_modeled` identifies an unsupported relationship/filter. Mechanics extraction alone does not prove a graph edge.

Local relationships retain exact Oracle spans, faces, ability addresses and unmet requirements. They do not establish simultaneous availability, timing, paid activation or a winning loop. Use `meta_combos` for external variants and `simulate_deck` only for its bounded mana payment question. Scores and inferred game plans do not establish win rate.

`meta_recommend` can narrow by `theme` or `oracle_query`. Compare scores only under comparable scan coverage; `coverage.scan_truncated` may omit stronger candidates. Optional EDHREC observations preserve their separate metrics and freshness and do not improve local legality or certify partner synergy. Recommendation failures can leave local analysis usable.
