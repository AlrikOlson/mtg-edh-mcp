---
name: mtg-edh-analysis
description: Analyze a Commander deck with mtg-edh-mcp for legality, mana payments and early-turn sequencing, curve and role gaps, supported strategy, combos, bracket estimates or declared playgroup constraints.
license: MIT
---

# Deck analysis

Use symbolic names through the connected mtg-edh-mcp server's exposed tools; live `tools/list` is the schema authority. Check `data_status` if readiness is unknown, then read the chosen deck/version with `deck_get`. This folder is independently usable.

Start with `deck_status` for a broad review; fetch only the deeper reports needed for the user's question. Use returned quantities and counts rather than manually recounting a deck. Keep legality, mana feasibility, strategic evidence and playgroup suitability separate conclusions.

- For counts, role gaps, game plans or recommendations, read [structural analysis](references/structure.md).
- For mana bases, source conditions or “can I cast this by turn N?”, read [mana and sequencing](references/mana.md).
- For combos, declared restrictions or power brackets, read [policy and combo evidence](references/policy.md).

Read `coverage`, missing data, truncation, assumptions and source/deck versions before asserting a result. An empty supported catalog or exhausted search is not proof of absence or impossibility. Return conclusions tied to the actual evidence and list only limitations material to the user's question.

Analysis does not authorize deck edits, changing saved roles/intent, or sending private contents to external providers contrary to user preferences. When a requested fix includes authorized edits, carry current versions, use a reviewed complete plan for coupled card changes, and rerun the affected analysis and `validate_deck` afterward.

Distributed under the [MIT license](LICENSE.md).
