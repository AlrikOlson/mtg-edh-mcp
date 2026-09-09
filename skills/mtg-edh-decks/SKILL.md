---
name: mtg-edh-decks
description: Build, import, revise or restore Commander decks with mtg-edh-mcp, preserving authored intent and using reviewed atomic plans for complete builds and multi-card revisions.
license: MIT
---

# Deck construction and editing

Resolve symbolic tool names against the connected server and consult live `tools/list` schemas. Check `data_status` when readiness is unknown. This skill is self-contained; it requires no companion skill installation.

Resume an existing build with `deck_list`, `deck_get` and `deck_get_intent`. Preserve its current cards, hard constraints, chosen command zone and user preferences. Do not create another deck merely because the conversation resumed. One designated commander leaves 99 library slots, a legal pair 98; a companion is outside the 100.

Read [construction and intent](references/construction.md) for a new build, partial list, generated proposal or constraint change. Read [safe state changes](references/edits.md) for exact revisions, incremental edits, imports, snapshots, version conflicts or retries.

For a selected multi-card transition, prefer a complete `deck_plan_preview` and atomic `deck_plan_apply`. For generated builds, `deck_construct` already returns a reviewed plan when it finds a valid candidate. Inspect the complete desired deck, diff and validation before applying. A request to propose or compare stays read-only; a request to carry out the specific build/edit can authorize its application without a redundant confirmation. Ask only when a material choice or destructive step falls outside that authorization.

Keep hard intent intact. Search exhaustion does not authorize relaxing a constraint. Finish an authorized change by checking its result and running `validate_deck` plus relevant `deck_status`/analysis checks. Report the saved ID, version, actual edits and any remaining limitations; count alone does not establish a legal or effective deck.

Distributed under the [MIT license](LICENSE.md).
