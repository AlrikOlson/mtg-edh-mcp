# Retrieval and face evidence

## Search, discover, inspect

`card_search` is local and returns lean references. Its language is a Scryfall-like subset: `o:`, `t:`, `kw:`, `mv<=3`, `usd<5`, `id<=wu`/`ci<=wu`, printing predicates, Boolean grouping/negation, `is:commander` and `is:gamechanger`. Pass sorting separately as `order` (`name`, `mv`, `price`, `released`). Pages permit up to 175 results. Continue `next_cursor` with unchanged query/order; do not confuse a page with the whole pool.

```text
card_search {"query":"id<=wu t:instant mv<=2 o:draw","order":"mv","limit":20}
card_get {"cards":["Sol Ring","Arcane Signet"],"compact":true}
card_discover {"mode":"commanders","theme":"scry","include_pairs":true}
card_discover {"deck_id":"DECK_ID","theme":"sacrifice","limit":20}
```

`card_get` accepts names or Oracle IDs, singly or in batches, and returns `missing[]`. Routine known references need no separate resolution call. Use `card_resolve_name` for an ambiguous/unknown entry and explicitly choose a canonical candidate. `exact:true` disables fuzzy fallback. `card_printings {card:...}` supplies all printings for one card; request printing detail only when it matters.

`card_discover` can filter by deck/commanders, explicit color identity, exclusions and mana value. `color_identity:[]` means colorless. Card mode excludes existing library, command zone, companion and saved hard exclusions. Commander mode validates supported single/pair choices; one matching partner does not prove both support the theme. Mechanics and `oracle_query`, when both supplied, both must match. Token search needs explicit inflections such as `(o:explore or o:explores)`.

Inspect `interpretation`, `supported_themes`, exclusions and truncation. An unknown theme returns `needs_query` unless a usable fallback is supplied. Discovery scans and pair checks default to 50,000 each and cap at 100,000; result limit is 50. A bounded empty result is not proof that no suitable card exists.

## Canonical facts and mechanic spans

Both compact and full card results retain `gameplay`: source layout, whole-card identity, ordered `faces`, `characteristics`, related cards and source pointers. Read the selected face's zero-based `face_index` and `source_path`. Missing values remain null; an explicitly empty cost is different from a missing cost. Flat joined costs/types are search projections. An MDFC is one physical card, not two available resources; `produced_mana` gives possible types without quantity, payment cost or availability.

Use `card_mechanics {cards:[...],deck_id:...}` when an exact supported trigger, activation cost, effect or permission matters. Read `pattern_id`, subject, condition, optionality, provenance and the exact Oracle evidence span. `cost.sacrifice_permanent` is not `trigger.sacrifice`. Evidence offsets are half-open UTF-16 positions in an unmodified source field. Coverage and `unmodeled`/`uncertain` findings delimit what the extractor understood; an empty annotation list does not establish absence of abilities. Supplying a deck overlays its role corrections without changing them.

## Deck-relative recommendations

`meta_recommend {deck_id:...,expected_version:...}` defaults to local contextual scoring using all commanders, actual library support, roles, curve and intent. Read evidence, unmet requirements and tradeoffs, and inspect scan coverage. A complete deck needs a compatible cut; an individually legal addition is not a validated final replacement.

`provider:"edhrec"` adds independently sourced community observations without changing local scores. Legacy `rank:"synergy"` or `"inclusion"` instead requires EDHREC and uses a primary-commander profile. `meta_commander_profile` inspects that upstream evidence directly. Preserve metric field, scale, source, fetch age and stale status: counts, synergy differences and unknown-scale lift are distinct. Missing observations are unknown; separate commander profiles are not a measured partner combination. On upstream failure, retain usable local research and explain the missing enrichment.
