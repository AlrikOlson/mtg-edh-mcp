---
name: mtg-edh-budget
description: Estimate Commander deck value or new spending, find cheaper printings and replacement candidates, and manage owned-card membership using mtg-edh-mcp pricing and collection tools.
license: MIT
---

# Budget and collection work

Use the connected mtg-edh-mcp tools through their exposed names; names here are symbolic and live `tools/list` schemas control exact inputs. Check `data_status` if needed and read the selected `deck_id`/version. This skill requires no other folder.

Start with `budget_plan` for printing savings and cost drivers before considering card replacements. Use the complete-deck fields, inspect price coverage/freshness, and distinguish deck value from new acquisition spending. Use `meta_budget_swaps` for replacements only when needed; review lost roles and strategic dependencies before applying quantities.

Read [pricing, collections and applying savings](references/budget.md) for exact scope, ownership semantics, missing prices, provider limits and safe changes.

Budget advice and swap suggestions do not mutate the deck. If the user authorized a revision, preserve saved hard intent and review a complete `deck_plan_preview` before atomic `deck_plan_apply`; confirm the actual saved prices and legality afterward. An ownership list authorizes recording that list when requested, not silently clearing or replacing a different saved collection. Existing authorization does not require repeated permission checks.

Report known complete-deck estimate, acquisition estimate when available, target comparison, missing-price quantities and material exclusions. Never present snapshot prices as a seller checkout quote or treat an unknown required price as zero.

Distributed under the [MIT license](LICENSE.md).
