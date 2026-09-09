---
name: mtg-edh
description: Use mtg-edh-mcp to resume a Commander deckbuilding session, choose the right card/deck/analysis tools, or recover a data or state error. Applies to Magic Commander work through this MCP server.
license: MIT
---

# Commander workspace

Resolve symbolic names such as `deck_status` to the tools exposed by the connected mtg-edh-mcp server; a host may add a namespace or prefix. Read live `tools/list` descriptions and schemas for exact inputs. This folder works independently of other skills and does not install or configure the server.

Start with `data_status` and, for saved deck work, `deck_list`. Reuse the selected `deck_id`; use `deck_get` for its cards and current version, `deck_status` for its standing, and `deck_get_intent` for authored goals. A liveness `ping` does not establish card-data readiness. If the server is unavailable, report the missing connection and continue only work that does not require its state.

Choose the smallest useful surface:

- Exact criteria or known cards: `card_search`, then `card_get`.
- Theme candidates: `card_discover`; contribution to an existing build: `meta_recommend`.
- New or partial build: `construction_spec`, then `deck_construct`.
- Selected complete revision: `deck_plan_preview`, then authorized `deck_plan_apply`.
- Health or explanation: `deck_status`, then the specific analysis or validation tool.
- Spending: `budget_plan` before replacements; check full-deck scope and price coverage.

Use the [complete tool router](references/tools.md) when a task crosses domains or a less common operation is needed. Read [session and recovery](references/session.md) for readiness, partial results, version conflicts, or interrupted mutations.

Follow the user's authorized scope: advice and previews do not themselves authorize saving a proposal. Existing authorization to make a concrete edit does not need a new approval ceremony. Never silently weaken hard intent or use forced illegal additions to make a proposal pass. Return the actual deck/version or unchanged proposal, supporting evidence, and material unresolved findings.

Distributed under the [MIT license](LICENSE.md).
