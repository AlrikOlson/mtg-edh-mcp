# Pricing, collections and applying savings

## Choose the right scope

```text
budget_plan {"deck_id":"DECK_ID","target_usd":150,"use_collection":true}
card_printings {"card":"Sol Ring"}
meta_budget_swaps {"deck_id":"DECK_ID","target_usd":150}
```

Use the user’s stated budget scope. If “about $100” could mean total deck value or additional spending and the distinction affects choices, resolve it before selecting cuts; a preferred target is not automatically a hard cap.

`budget_plan` changes no cards. Start with its printing savings, cost drivers and `full_deck.target_met`. `full_deck` contains library plus all commander slots. `library`, `command_zone` and outside-deck `companion` are separate; the companion is not part of the 100 or automatically included in a full-deck target. Existing top-level `min_buy_usd`, `default_total_usd`, `acquire_usd` and stats/status price totals retain library scope. Prefer `budget_plan.full_deck`, `analyze_stats.budget.full_deck` or `deck_status.price.full_deck` for total starting-deck value.

`default_total_usd` estimates default-printing value. `min_buy_usd` estimates buying every copy at the cheapest indexed nonfoil USD printing. Opting into `use_collection` adds acquisition cost under the membership model below; no sale proceeds are deducted. `card_get` supplies batch default/cheapest pricing; `card_printings` lists all printings of one card. Deck entries do not store a selected printing, so showing a cheaper printing is a purchasing suggestion, not a persisted deck edit.

All sums are computed in USD cents. Missing prices or unresolved cards make numbers known subtotals; inspect default, cheapest and acquisition `coverage`, affected identities and quantities. A required missing price makes a target comparison unknown, never a zero-price success. Extra stored copies across zones are counted and flagged rather than silently deduplicated. Pricing does not validate the deck's count or legality.

Preserve price observation time and freshness when supplied. Null timestamp/unknown freshness is not repaired by a set release date or `data_snapshot`. Observed prices use a default 24-hour age threshold; local data and live provider cache times are separate. Estimates exclude fees, shipping, tax, stock, condition and seller constraints. If the user needs an actual purchase decision, those unresolved terms remain outside this server's quote.

## Membership is not quantity inventory

`collection_get` reads paginated ownership with default page size 200 and `next_cursor`. `collection_add` extends the set, `collection_set` replaces it, and `collection_clear` empties it. All accept/return the semantics advertised by the live schema; set/add accept exact names or Oracle IDs and may return `unresolved[]` after successful entries were applied. Resolve only those remaining entries, preserving the desired replacement versus extension behavior.

Ownership tracks card identity, not number of copies or particular printings. Membership covers all copies of an Oracle card for acquisition estimates, including basic lands and commanders. Do not claim quantity-aware owned-only legality or purchasing feasibility. With an absent/empty collection, acquisition figures remain null; `card_search {owned_only:true}` is a no-op for an empty collection and can return unowned cards. Confirm that a nonempty collection is loaded before treating results as ownership-filtered.

Collections persist under the server's session/principal namespace. A different principal's collection is not evidence of this user's ownership. Do not replace or clear membership unless that operation is included in the user's request.

After a lost collection-mutation response, re-read the current membership before retrying. Repeating `collection_set` or `collection_clear` can discard cards added in the meantime; retry only the still-authorized, unapplied change. Preserve requested ordering in multi-part work, including “then clear”; a pending earlier choice is not permission to move the destructive step ahead.

## Evaluate and apply swaps

`meta_budget_swaps` returns advice, not edits. Read outgoing and replacement quantities, savings, role matches/losses/gains, mana-value changes and evidence. Role overlap is not functional equivalence: a cheaper option can lose a protected piece, interaction or win-condition dependency. Proposals replace library cards, do not deduct ownership and compare `current_full_deck`/`projected_full_deck`; legacy `current_min_buy_usd`/`projected_min_buy_usd` remain library-scoped. Check missing-price coverage before repeating `target_met`.

The tool can use unofficial EDHREC evidence. Preserve metric scales and freshness; missing metrics are unknown, not measured zero. On `UPSTREAM_UNAVAILABLE`, local `budget_plan`, card search and printing comparison remain usable. Honor requests to keep analysis local instead of sending a provider request.

For an authorized package of swaps, read current `deck_get` and intent, build the complete desired library in `deck_plan_preview` with `deck_id` and `expected_version`, then inspect desired/diff/validation. Pass its exact returned plan to `deck_plan_apply`. Version or data conflicts require a fresh preview. Exact apply retries are durable/idempotent; a replayed receipt may be historical, so read current state. Incremental add/remove is appropriate for isolated authorized edits but has partial-result and lost-response risks; snapshot before experiments and retry only unapplied work.

After saving, run `budget_plan` at the requested target, `validate_deck` and affected mana/role/strategy checks. Distinguish the achieved known estimate from unresolved acquisition costs; do not silently relax hard budget caps or protected cards to get a passing label.
