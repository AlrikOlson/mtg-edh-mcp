# Canonical selected physical costs

Accepted for `engine-mvp-selected-costs`. Follows the [engine charter](../ENGINE-CHARTER.md), [source integration](engine-source.md), and [mana declaration owner](engine-mana-cost-choices.md). The native roadmap remains authoritative.

The [source pin](../../engine/source.json) advances to canonical `mtg-game-engine` commit `556c6b823066d4b63e9fd112b6234c87b8487ab0`. Cargo.lock and worker protocol bytes are unchanged. The contract manifest records the new source revision.

## Architecture and reuse review

Rust remains the sole new gameplay owner. Casting, ordinary activated abilities, and immediate mana abilities all use `mana::selected::PhysicalPayment` inside the existing transactional mana planner/executor. It owns physical identity validation, tap and zone changes, discard events, and legal physical payment order. The shared `pay_life` function owns both final life costs and mana-ability life fees. Previous separate ordinary and mana-source non-mana mutations were removed.

The implementation reuses `CardId`, zone-specific `ObjectId`, canonical zones and derived characteristics, the existing event bus, spend contexts, mana allocation, and state-hashed payment plans. No TypeScript gameplay logic, worker protocol, card registry admission, public MCP route, or dependency was added. Existing CLI and desktop consume the same core crate. Their original checkouts and the MCP worktree's pre-existing workflow edits were preserved.

## Requests and payment

The public `PhysicalCostRequest` describes a selected sacrifice of one controlled creature, a specified number of cards discarded from the payer's hand, or cards exiled from the payer's graveyard. Each candidate is a `CostObject { card_id, object_id }`. Tokens can pay a creature sacrifice but are excluded from costs requiring cards in hand or graveyard.

Callers obtain requests through `CastingOptions::physical_cost_requests`, `ActivatedAbility::physical_cost_requests`, or `mana_physical_cost_requests`. They submit explicit `PhysicalChoices` through casting options, `activate_ability_with_cost_choices`, or `activate_mana_choice_with_costs`. Existing entrypoints provide no implicit selected objects and therefore reject a missing required selection. Casting candidates exclude the spell, which is moved onto a private stack before payment preparation.

Choice groups associate exact objects with cost components; they do not prescribe payment order. Initial requests check current zone, incarnation, ownership/control and type. Exact cardinality and distinct destructive use are enforced across groups and a fixed source sacrifice. A controlled creature owned by another player can be sacrificed and moves to its owner's graveyard. A leave-and-return card is a different object and cannot reuse an obsolete choice.

The final physical witness is carried through the canonical mana window. A selected creature may tap for mana before being sacrificed, but a reserved final tap blocks only tap modes, allowing a tapless mana mode on the same permanent. Search can temporarily lose and regain control while paying mana. At final payment, identities and zones must still match; each separate sacrifice rechecks current eligibility. A deterministic search finds a legal component order, including a fixed sacrifice that restores control of a later selected creature, or rejects if no order is possible.

Source activations retain their selected objects and incarnation in the payment plan. Simulation and execution share the same cost executor. Failed transactions preserve canonical state bytes, resources, stack and events. Successful costs emit tap, life, zone and discard events once; mana abilities remain immediate and use the existing activation/production events.

## Independent evidence and boundaries

Canonical `tests/selected_costs.rs` contains 19 independently expected scenarios. These cover exact resources and event lists, own versus foreign zones, controlled versus owned creatures, token admission, stale incarnations/plans, missing and duplicate choices, group cardinality, tap reservations, resource alternatives, transient control, legal/impossible sacrifice order, and rollback. Review findings were reproduced by failing tests before repair.

The Molt Tender fixture independently exercises all five outputs of its tap-plus-own-graveyard-exile ability, verifies the selected card is exiled, and verifies no stack object is created. It is grounded in the frozen [corpus](../evaluation/engine-mvp/corpus-v1.json), Oracle ID `9a39ca64-e1a9-42ef-8efd-6aa3edde3d93`. This is cost/production evidence only: the separate mill ability and complete card admission are not implemented or claimed.

Contextual mana abilities with selected physical costs or a source sacrifice explicitly reject in the shared source admission. Moving a grounding land can invalidate a previously computed output menu; producing its stale color would be incorrect. The native backlog item `engine-contextual-cost-output` retains post-cost output choice work. Fixed output modes, including Molt Tender, do not have that dependency.

Resumable scheduler decisions, player-selected ordering, full card effects, arbitrary filtered costs, replacement effects, and whole-corpus qualification remain downstream work. Search returns a deterministic legal payment witness; it is not a strategy or preference scorer.

## Recorded qualification

- Canonical core and worker unit/integration suites and all 107 doctests passed; strict Clippy with pedantic warnings denied and Rust formatting passed.
- Existing CLI and desktop all-target compilation passed. Desktop compilation used a temporary generated icon, removed before the canonical commit; no GUI rendering claim is made.
- The independent MCP-owned mana source fixture harness passed all 36 scenarios against the clean pinned source.
- A separate clean clone passed source identity/lock checks before and after the locked offline macOS arm64 release build. The worker ran its self-check from an empty directory without a catalog.
- All eight real native worker protocol tests passed. Contract import/parity passed; the dependency graph has no desktop or downloader dependency.
- MCP standard typecheck, test and lint results are recorded on `task:engine-mvp-selected-costs-verify`.

Rules basis: current [Comprehensive Rules](https://media.wizards.com/2026/downloads/MagicCompRules%2020260819.txt), especially 118.3, 601.2f–h, 602.2b, 605, 611.3, 701.9, 701.13 and 701.21. The official [Streets of New Capenna release notes](https://magic.wizards.com/en/news/feature/streets-new-capenna-release-notes-2022-04-20), Falco Spara ruling, independently illustrate an earlier cost changing eligibility for a later sacrifice. The [Hobbit update bulletin](https://magic.wizards.com/en/news/announcements/the-hobbit-update-bulletin) clarifies the mana-ability boundary for library movement.
