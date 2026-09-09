# Construction and intent

## Normalize, then search

`construction_spec` accepts an empty request, theme, commanders, partial `cards`, or saved `deck_id`. It does not search or save. With saved state, pass current `expected_version`; the source records deck/card-data/intent evidence. Unknown or ambiguous references need an explicit choice. Resolve `needs_choices`, diagnostic conflicts and `unresolved_requirements`; never silently choose a command zone or weaken a hard requirement.

```text
construction_spec {"request":{"schema_version":1,"commanders":["Marwyn, the Nurturer"],"theme":"counters","budget":{"mode":"cap","usd":150},"lands":{"min":36,"max":38,"strength":"hard"}}}
deck_construct {"deck_id":"DECK_ID","expected_version":3,"request":{"budget":{"mode":"target","usd":150}}}
```

Use the actual saved version, not the illustrative `3`. Supported command-zone kinds are `single`, `partner`, `background` and `doctor_companion`; keep alternatives explicit until selected. Remove `command_zone_alternatives` when selecting concrete commanders. A companion is separate. Saved cards are editable seeds unless protected; do not substitute `request.cards` for the saved baseline in `construction_spec`—use a hypothetical request without `deck_id` for a separate list.

Budget omission inherits saved soft spend intent as a preferred target if present, otherwise remains unspecified. Unspecified is not unlimited: `unbounded` is explicit, `cap` is hard and `target` preferred. Cap/target needs `usd`. Complete-deck budgets include commanders; companion inclusion is optional via `include_companion`. Unknown required prices prevent satisfying a hard cap. Land/role bounds carry hard or preferred strength; overlapping roles still occupy one physical slot. Prose requirements stay unproved unless the engine supports their evaluation.

`deck_construct` performs bounded local search and saves nothing:

- `found`: review `desired`, `diff`, `validation`, explanations and remaining uncertainty; apply its exact returned `plan` only within authorization.
- `proven_conflict`: a direct contradiction was established; resolve the identified constraint conflict.
- `search_exhausted`: limits or unresolved evidence prevented a valid result. No applyable plan exists; this is not impossibility proof.

Search defaults/maxima are scan 50,000/100,000, retained candidates 512/2,000, nodes 10,000/100,000, branches 4/16. Increase a relevant bound deliberately, or improve constraints/candidates; stop repeating the same exhausted request. Inspect separate discovery and inventory coverage. Deterministic selection under fixed input does not establish optimal deck quality. Quantity-based owned-only guarantees are unsupported.

Edit limits count physical copies: one replacement uses one removal plus one addition. `edit_bounds.max_changes` and saved `hard.change_limit` bound their sum; `max_additions` and `max_removals` bound each direction. Establish whether an ambiguous “four cards changed” means four replacements or four total copy edits before committing. Preserve existing tighter bounds.

## Save authored intent deliberately

`deck_get_intent` exposes current `version`, null/authored intent, defaults and effective preferences. `deck_set_intent` requires that version and `action:set|patch|clear`: set replaces all intent, patch merges objects with omission preserving, null removing and arrays replacing, clear removes authored intent. Keep `schema_version:1`. A saved soft preference is not permission to change a hard rule.

`hard` can protect minimum quantities, exclude cards, constrain command-zone choices/colors and bound changes. `soft` carries goals, strategy, favorites, role targets and spend preferences. `unsupported` preserves unevaluable wishes; `playgroup` stores structured policy declarations. Intent alone neither edits cards nor certifies satisfaction. `meta_check_policy` evaluates supported declared constraints; `validate_deck` remains the legality gate. Patch only the authored choices the user asked to change. Saved hard intent cannot be weakened inside a full-deck plan.

For an authorized intent patch, this example protects one library copy and the commander, with at most four total copy edits (two one-for-one swaps) and a preferred spend target:

```text
deck_set_intent {"deck_id":"DECK_ID","expected_version":3,"action":"patch","patch":{"hard":{"locked_cards":[{"oracle_id":"Life from the Loam","qty":1}],"commanders":{"required":["Muldrotha, the Gravetide"]},"change_limit":4},"soft":{"spend_target_usd":100}}}
```

Use the current version and merge any existing locked/required arrays before replacing them. If changing saved intent was not requested, carry these constraints in the construction request instead of persisting a new policy. A successful intent mutation advances the version; use that returned version for subsequent proposals.

Roles are separate: `deck_set_roles` replaces one card's deck-specific list; `[]` assigns no roles and `null` resets inferred defaults. It does not alter global card facts or legality. Snapshot/restore preserves both intent and role corrections; plaintext export does not.
