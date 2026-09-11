# Canonical mana cost declarations

Implemented for `engine-mvp-mana-cost-choices`, the first prerequisite split from `engine-mvp-cost-choices`; native reasoning `think:319`. The original aggregate retains its full acceptance and stays incomplete. Follow the [engine charter](../ENGINE-CHARTER.md) and [source delivery contract](engine-source.md).

## Architecture and reuse

The sole production owner is canonical Rust `mtg-engine`. `mana/choices.rs` describes and validates declarations, then expands them into concrete mana and life demands. It does not allocate resources. Existing `mana/allocation.rs`, `mana/payment.rs`, `mana/costs.rs` and `mana/mana_ability.rs` still own allocation, source search, exact execution, adjustments and source activation.

`CastingOptions::mana_choice_request` composes the existing base/alternative/additional costs. `ActivatedAbility::mana_choice_request` composes the existing fixed ability cost components. Both return the same descriptor, so callers can present branches without interpreting mana symbols. `with_mana_choices` and `activate_ability_with_choices` submit explicit declarations to those canonical consumers. Existing no-choice entrypoints remain wrappers and reject costs that need undeclared choices.

The sequence is declarations, total-cost adjustments, mana window, then payment. Life required by the final cost is reserved while searching source activations and debited by the shared payment executor. The old ordinary-activation life debit and independent affordability check were removed. Opaque payment plans retain their exact state hash, restriction-aware spend and source fee witnesses; the added final life amount does not count as mana spent.

`turn/action_enumerator.rs`, `game_loop.rs`, CLI and desktop still use their existing default entrypoints. They gain no inferred hybrid/X choice. General legal action requests, scheduler suspension and serialized choices belong to the remaining aggregate work. The descriptor lists syntactic declaration branches, not a claim that each branch is affordable or a legal action.

No worker wire schema, core snapshot schema, support registry, Oracle parser or TypeScript execution changed. MCP only advances the immutable source and generated-contract provenance. The existing TypeScript payment/sequencing paths remain frozen until their removal at `engine-mvp-cutover`; no fallback is introduced.

## Represented behavior

Each hybrid/monohybrid/Phyrexian symbol requires one permitted branch in printed order. All X symbols share one explicitly supplied value, including zero. Missing, extra and invalid choices reject before payment. Hybrid branches use the selected color; monohybrid chooses its color or two generic mana; Phyrexian chooses its color or two life. Generic reductions operate on the declared mana branch and do not reduce colored or life costs.

The finite `ManaCost` representation supports total concrete mana value up to 65,535. Expansion and adjusted costs reject larger totals before exposing the existing `u16` mana-value API or searching resources. This is an explicit representation limit, not a candidate-scoring cutoff. Snow and unrepresented resources still reject.

## Independent evidence and corpus boundary

Canonical `tests/mana_cost_choices.rs` contains 19 independent expected-resource tests. Coverage includes both hybrid colors, all four two-symbol combinations, repeated and zero X, monohybrid reduction order, both Phyrexian branches, exact-life payment, insufficient life, source-life reservations, fixed-plus-Phyrexian activation costs, restricted mana, missing/extra/illegal declarations, alternative-plus-additional composition, complete state rollback, restored-state execution, stale and repeated plans, and numeric boundaries.

Two tests use the exact frozen cost clauses in [the immutable corpus](../evaluation/engine-mvp/corpus-v1.json):

| Oracle identity                                                   | Proven cost branch                                                                       | Remaining binding                                                                                            |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Tasigur, the Golden Fang — `837e3fde-241f-4826-ad04-f146fdcf2278` | `{2}{G/U}{G/U}`: all four independent hybrid choices consume exactly four mana           | Delve, selected opponent and graveyard card, mill/return, and actual casting expenditure                     |
| Pernicious Deed — `62e44e0d-eda0-4275-8367-49dab9a087c3`          | `{X}` plus sacrifice-self: zero and positive X; failed payment preserves the enchantment | Preserve announced X on the pending ability; resolve the simultaneous destruction through effect/zone owners |

These fixtures construct typed cost-only objects and never resolve their placeholder effects. They do not certify either entire card. Monohybrid and Phyrexian tests are additional reference cases, not invented frozen-corpus requirements.

Primary research: [official Comprehensive Rules](https://media.wizards.com/2026/downloads/MagicCompRules%2020260819.txt), particularly 107.3, 118.3, 601.2b/f–h and 602.2b. The declaration-before-cost-adjustment ordering and full life-payment requirement determine the independent expectations.

Independent review found a mixed X-plus-colored overflow. A failing boundary test reproduced it; the shared validator now guards complete totals both after expansion and after adjustment. Re-review found no remaining issue. This change also preserves all 36 independent MCP mana-source fixture outcomes.

## Qualification and retained work

Canonical source commit: `b83ca828022473706fdee2c8d72196d8743ce0cd`. Cargo.lock and dependencies are unchanged. Core/worker tests, 107 doctests, strict Clippy, formatting and CLI/desktop compilation passed. Desktop compilation needed the known ignored 32x32 PNG regenerated from tracked ICO; that temporary build input was removed. Desktop packaging and UI rendering are not qualified by compilation.

Integration follows a separate clean clone, pinned macOS arm64 release-worker build, source checks before and after, catalog-free self-check, dependency-graph inspection, real native protocol tests and recorded MCP gates. The internal worker still advertises its existing support-preflight scope; no playable full-corpus simulation is claimed.

The preserved dependency order is `engine-mvp-mana-cost-choices` → `engine-mvp-selected-costs` → `engine-mvp-resolution-choices` → `engine-mvp-ward-expend`, then aggregate cost-choice acceptance. Selected discard/sacrifice/exile (including Molt Tender), targets/modes/order, mandatory/optional resolution, persistent announced choices/X, contingent ward and per-turn actual casting expenditure remain required. Complete card effects stay with their established downstream owners; no reverse dependency cycle is introduced.
