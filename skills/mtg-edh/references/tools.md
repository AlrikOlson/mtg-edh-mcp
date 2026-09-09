# Complete tool router

This catalog covers the 56 tools in the source release that ships these skills. Actual availability, input bounds and schemas come from the connected server's `tools/list`; names below are symbolic and have no required host prefix. The catalog is routing guidance, not a replacement schema. Refresh discovery after data installation or an upgrade.

## Session and data — 3

| Tool          | Use when                                | Consequence or boundary                                      |
| ------------- | --------------------------------------- | ------------------------------------------------------------ |
| `ping`        | Check connection liveness               | Does not check the card index.                               |
| `data_status` | Check readiness, age or ingest progress | Read `has_index`, `stale`, and ingest phase.                 |
| `data_ingest` | Install or refresh bulk card data       | Network download and atomic index replacement; asynchronous. |

## Card discovery and rules — 10

| Tool                | Use when                                        | Consequence or boundary                                           |
| ------------------- | ----------------------------------------------- | ----------------------------------------------------------------- |
| `card_search`       | Filter the local pool by precise criteria       | Lean results; use cursor with unchanged query/order.              |
| `card_get`          | Inspect known cards and canonical faces         | Batch names/IDs; review `missing[]`.                              |
| `card_resolve_name` | Disambiguate one reference                      | Explicitly choose candidates; exact mode avoids fuzzy fallback.   |
| `card_printings`    | Compare one card's printings                    | No selected printing is saved to deck entries.                    |
| `card_mechanics`    | Inspect supported mechanic evidence             | Empty annotations do not mean no abilities.                       |
| `card_discover`     | Find theme/mechanic candidates or command zones | Local bounded retrieval; inspect exclusions and truncation.       |
| `rules_search`      | Locate rules by words and optional section      | Bounded excerpts; every query word must match.                    |
| `rules_lookup`      | Read full numbered rules or glossary text       | Cite corpus date; unknown numbering is explicit.                  |
| `rules_refresh`     | Install/update rules and rulings corpus         | Network refresh; failed download retains prior corpus.            |
| `card_rulings`      | Read a card's published rulings                 | Distinguish Wizards rulings, provider notes and unavailable data. |

## Decks, intent and proposals — 22

| Tool                 | Use when                                         | Consequence or boundary                                               |
| -------------------- | ------------------------------------------------ | --------------------------------------------------------------------- |
| `construction_spec`  | Normalize build constraints before search        | Read-only; unresolved choices stay unresolved.                        |
| `deck_construct`     | Generate a complete constrained proposal         | Read-only; found/conflict/exhausted are distinct.                     |
| `deck_plan_preview`  | Review a selected complete final library         | Read-only; existing deck requires current version.                    |
| `deck_plan_apply`    | Save an authorized reviewed proposal             | Atomic; pass the exact plan; exact retries return receipt.            |
| `deck_create`        | Start a saved incremental draft                  | Creates state; commander shortcut still needs validation.             |
| `deck_get`           | Read cards, metadata and version                 | Use `expand:true` only when full cards are needed.                    |
| `deck_list`          | Find or resume a saved deck                      | Lean entries; avoid creating duplicate builds on resume.              |
| `deck_rename`        | Change a saved title                             | Mutation with optional version guard.                                 |
| `deck_set_roles`     | Correct one card's deck-specific roles           | List replaces, `[]` clears, `null` resets classifier defaults.        |
| `deck_delete`        | Discard a saved deck                             | Permanent deletion; no version argument.                              |
| `deck_snapshot`      | Checkpoint before an experiment                  | Saves an immutable checkpoint; retain its ID.                         |
| `deck_diff`          | Compare a checkpoint with current/other snapshot | Read-only; includes metadata changes.                                 |
| `deck_restore`       | Undo to a checkpoint                             | Writes state and increments current version.                          |
| `deck_import`        | Load decklist text                               | Creates a deck or merges into `deck_id`; partial resolution possible. |
| `deck_export`        | Obtain quantity/name decklist text               | Read-only; does not preserve all deck metadata.                       |
| `deck_add`           | Add selected cards or quantities                 | Partial batch verdicts; additions pre-check legality.                 |
| `deck_remove`        | Cut selected quantities                          | Decrements copies; inspect unresolved entries and current version.    |
| `deck_set_commander` | Change designated command-zone cards             | Validates pairing and changes color identity.                         |
| `deck_set_companion` | Set or clear an outside-deck companion           | Full companion condition still needs deck validation.                 |
| `deck_get_intent`    | Read authored constraints and defaults           | Null intent is not inferred user preference.                          |
| `deck_set_intent`    | Set/patch/clear authored intent                  | Requires current version; does not change cards.                      |
| `deck_status`        | Get one-call standing after edits                | Overview of counts, legality, gaps, mana and scoped prices.           |

## Analysis and legality — 14

| Tool                     | Use when                                        | Consequence or boundary                                        |
| ------------------------ | ----------------------------------------------- | -------------------------------------------------------------- |
| `validate_deck`          | Check the complete saved deck's legality        | Inspect exact error/warning counts; echoes are capped.         |
| `validate_card`          | Pre-check one prospective addition              | Does not apply it or validate a whole replacement plan.        |
| `validate_commander`     | Test a command zone without changing it         | Supports a saved deck or transient commanders.                 |
| `analyze_curve`          | Inspect quantity-weighted mana values           | Supports land exclusion and role/color filters.                |
| `analyze_composition`    | Inspect type and role counts                    | Overlapping roles are not disjoint card slots.                 |
| `analyze_stats`          | Compute quantities, pips and scoped prices      | Library counts; use budget full-deck fields for total value.   |
| `analyze_mana_base`      | Inspect supported costs and source alternatives | Coverage and per-face assumptions precede conclusions.         |
| `analyze_role_coverage`  | Compare roles with effective bands              | Advisory defaults, saved targets or explicit bands.            |
| `analyze_strategy`       | Explain supported engines in the actual list    | Dependencies and evidence are conditional; no execution proof. |
| `simulate_deck`          | Inspect a mana trace or aggregate seeded hands  | Bounded policy; unknown/truncated trials are explicit.         |
| `meta_commander_profile` | Inspect community commander observations        | Live EDHREC source; popularity is not performance.             |
| `meta_recommend`         | Rank additions against actual deck and intent   | Local contextual default; optional provider evidence.          |
| `meta_combos`            | Inspect Spellbook variants and prerequisites    | Sends card names; a list does not prove executable setup.      |
| `meta_classify_bracket`  | Obtain an advisory power-bracket estimate       | May query combos; inspect provisional and coverage limits.     |

## Budget, inventory and policy — 7

| Tool                | Use when                                                 | Consequence or boundary                                               |
| ------------------- | -------------------------------------------------------- | --------------------------------------------------------------------- |
| `budget_plan`       | Find printing savings or acquisition estimate            | No card edits; inspect full-deck scope and missing prices.            |
| `meta_budget_swaps` | Suggest cheaper library replacements                     | Advice only; inspect quantity, lost roles and full-deck target.       |
| `collection_set`    | Replace owned-card membership from a list                | Replacement mutation; unresolved entries are explicit.                |
| `collection_add`    | Extend owned membership                                  | Membership only, not copy counts or printings.                        |
| `collection_get`    | Review current owned membership                          | Paginated; read `next_cursor`.                                        |
| `collection_clear`  | Empty owned membership                                   | Destructive replacement with an empty set.                            |
| `meta_check_policy` | Evaluate declared playgroup and construction constraints | Separate from legality and bracket estimation; unknown is meaningful. |
