---
name: mtg-edh-cards
description: Search and compare Magic cards, discover Commander or theme candidates, inspect canonical card faces and mechanic evidence, and answer rules or ruling questions through mtg-edh-mcp.
license: MIT
---

# Card research

Use the connected mtg-edh-mcp tools through their host-exposed names. Names here are symbolic; live `tools/list` schemas are authoritative. Check `data_status` if index readiness is unknown. This skill requires no other skill folder.

For exact criteria, use `card_search`, then batch `card_get` only for promising candidates. For themes and supported mechanic patterns, use `card_discover`; for a contribution ranking tied to an existing deck, use `meta_recommend` with its local contextual default. Unknown themes need an explicit supported mechanic or `oracle_query`, not an invented theme mapping.

Read [retrieval and face evidence](references/retrieval.md) for query recipes, canonical faces, mechanics coverage and provider observations. Read [rules and rulings](references/rules.md) for an interaction question or a requested citation.

Explain why each proposed card fits using returned facts and the actual deck's constraints. Distinguish commander color identity from face colors, and output alternatives from simultaneously available mana. Unsupported extraction is unknown evidence. A source-layout label does not certify how a face can be played.

This workflow researches cards without changing saved decks or role labels. If the user also authorized an edit, carry the latest deck version, inspect all per-card verdicts and validate the changed deck. A research request alone does not authorize `deck_add`, `deck_set_roles`, corpus refreshes unrelated to the task, or new server configuration.

Distributed under the [MIT license](LICENSE.md).
