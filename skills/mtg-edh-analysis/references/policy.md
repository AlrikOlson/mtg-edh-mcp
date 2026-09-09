# Policy, combos and brackets

## Separate three questions

`validate_deck` checks implemented rules legality. `meta_check_policy` checks supported authored playgroup/construction constraints. `meta_classify_bracket` estimates an advisory bracket. None substitutes for the other two, and a compatible list does not certify its social suitability or play strength.

Read `deck_get_intent` before policy work. Structured `intent.playgroup` may declare a profile (`casual`, `thematic`, `competitive`, `custom`), bracket and numeric limits. Saving a declaration is a separate authorized `deck_set_intent` mutation requiring current version. Free prose preferences are not hidden bans; changing policy is not a way to make a failing deck appear compliant.

`meta_check_policy {deck_id,expected_version}` returns compatible/incompatible/unknown findings with source versions, detected cards/packages and coverage. Limits can cover game changers, tutors, fast mana, extra turns, mass land denial and infinite combos. Published policies are pinned data, not a guarantee of today's policy: read returned provenance. Custom maxima are identified as user declarations. Tutors have no universal official numeric cap in the pinned policy; do not invent one from a bracket estimate.

Partial role/text classification, missing Game Changer evidence and unknown data age can prevent proving absence. For bracket 1–3 or custom combo restrictions, policy checks may send card names to Spellbook; other checks use local data. Honor local-only preferences and report the resulting evidence limit.

## Read combo applicability before recommending it

```text
meta_combos {"deck_id":"DECK_ID","include_almost":true,"limit":20}
```

This sends card names to Commander Spellbook. Read each result's `applicability`, `uses`, `requires`, `outputs`, quantities, starting-zone instructions, `mana_needed`, prerequisites, steps and URL. Provider inventory category is not an execution verdict:

- `listed_pieces_present` checks canonical quantities.
- `deck_configuration` considers designated commanders and supplied face indices; a commander-required piece in the library does not satisfy that setup.
- `setup_prerequisites` and `executable_now` remain unknown because a deck list lacks current game state.

Provider `used_face` is one-based; resolved canonical faces are zero-based. Do not silently equate missing face/quantity evidence with a favorable default. `include_almost` includes missing-copy/color-change variants; categories can also require commander changes. Those changes still need independent identity and final-deck validation.

Inspect freshness, unresolved IDs, coverage and truncation. Counts describe received buckets before local result limiting, not exhaustive known combos. Stale cache data after a failed refresh remains stale; cold failure reports `UPSTREAM_UNAVAILABLE`. Empty results never prove no combos. A complete provider response is still a non-exhaustive catalog.

Bracket estimates expose `combo_evidence` and `provisional`. Supported two-card candidates require two physical copies and explicit infinite/win outcomes; unmet prerequisites remain unknown and mana value is only an earliness proxy. Policy package counts deduplicate variants by canonical ingredients/quantities before presentation limits. Report the observed evidence and any unresolved timing/setup question rather than claiming an established early win.
