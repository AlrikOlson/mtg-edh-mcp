# Canonical mana eligibility and contextual production

Accepted for `engine-mvp-mana-eligibility`, following the [engine charter](../ENGINE-CHARTER.md), [source delivery](engine-source.md) and [richer source modes](engine-mana-outputs.md). Native Magistr records hold execution status.

## Ownership and reuse review

The canonical Rust `mtg-game-engine` remains the only new gameplay implementation. Layer-derived characteristics own current controller, type, haste and ability removal. `GameState` now retains continuous-control history per battlefield `ObjectId`; its zone, effect and turn mutation facades reconcile each operation, including multiple operations through a retained facade. Only an actual start of that controller's turn grants readiness. Losing and regaining control resets it; changing type alone does not. Ownership and entry-turn metadata retain their separate meanings.

Mana activation, ordinary tap-cost activation, untapping and attack eligibility use these shared owners. Specific continuous effects bind target incarnations, source durations bind source incarnations, and expiry settles before history reconciliation. Expired source effects are removed before conditional characteristics are evaluated. The old zone-entry-based sickness predicate is removed; CLI/desktop consumers compile against the replacement API. Snapshots advance from version 2 to version 3 and validate control-ledger consistency on restore; older snapshots are explicitly incompatible.

The existing exact payment planner/executor remains the sole payment owner. It refreshes source candidates after each activation, so sacrificing a control-effect source can regain a land needed later. It preserves control of resources reserved for an outer sacrifice cost and backtracks when one payment would lose them. No heuristic budget prunes legal search. Existing fixed-source optimization remains available when no active activation-cost change applies.

## Context and costs

`mana/context.rs` represents controlled lands' producible mana types (including colorless) and opponents' lands' producible colors (excluding colorless). It solves grounded potential output sets to a fixed point. Potential production ignores tap status, activation affordability and spending restrictions; actual activation still validates and pays its costs. A cycle with no independent source supplies no colors. Zero-output contextual activation pays its represented cost without inventing mana or a mana-production event.

`mana/costs.rs` owns represented generic increases and reductions for a player's spells or one permanent incarnation's activated abilities, lasting while the registered source incarnation remains on the battlefield. Increases precede reductions; colored requirements remain intact; arithmetic overflow rejects. Casting, ordinary activation, mana-source activation and affordability consumers share this computation. Exact-state plan hashes include these records and all context/control changes, rejecting stale witnesses transactionally.

These are typed core primitives, not card admission. Commander identity, production replacement effects, conditional static-cost bindings, richer cost choices and exact Oracle clause bindings must be implemented by their canonical owners before affected cards are admitted. Contextual sacrifice costs reject explicitly until post-cost output choices can be represented. The typed immediate-source API cannot represent library-moving costs/effects, targets or arbitrary draw effects.

## Independent evidence

Canonical `tests/mana_eligibility.rs` covers fresh and opponent-turn creatures, stolen lands, lose/regain without an intervening query, current haste/type/ability removal, old-land animation, blinking, source recovery during payment, loss of control of an outer sacrifice, activation legality fixed before the mana window, snapshot round trips, cascading expiry and expiry ordering, and attack enumeration/current vigilance. `tests/mana_context.rs` covers ungrounded Pool cycles, colorless versus colors, tapped/unaffordable potential sources, removal and stale plans, source activation fees, and casting tax/reduction shared with enumeration.

The recorded Rust gates cover the full core/worker tests, 107 doctests, strict Clippy, formatting, and CLI/desktop compilation. Desktop compilation required regenerating its missing ignored PNG icon from the tracked ICO using `sips`; that temporary build input was removed afterward. This does not qualify desktop packaging or rendering.

Source is committed before MCP advances its pin, then the worker is built from a separate clean clone with external Cargo output. Source identity is checked before and after; the probe runs without a catalog, and the existing native protocol and MCP gates qualify the integration. The protocol schema is unchanged; its generated manifest advances only source provenance.

## Retained obligations and migration

- `engine-mvp-mana-sources` retains its complete source/corpus conformance obligations. This prerequisite does not complete that parent.
- `engine-mvp-commander` must supply runtime Commander identity and commander-tax integration; Command Tower must not infer identity from colors, mana or ownership.
- `engine-mvp-lands` must bind exact Oracle clauses, integrate applicable production replacements, and route library-moving abilities through the ordinary stack/choice owner under current CR 605.1a. No reverse dependency cycle is added.
- Discovered `engine-mvp-controller-consumers` is backlog and a prerequisite of the existing combat-objects and planeswalkers chunks. It covers pre-existing ownership proxies in blockers, lifelink, combat triggers, loyalty and applicable desktop snapshots. This unit does not claim complete control-change gameplay.
- Existing legacy TS mana/runtime paths remain frozen during internal qualification. `engine-mvp-cutover` must switch public routes and retire overlapping parsers/solvers together, as listed in the source ADR. No TS gameplay implementation, fallback or public simulation route is added here.
- Full four-player/corpus admission, replacement semantics, performance qualification, replay and installed-worker packaging retain their roadmap gates. Attachment-condition behavior remains the pre-existing layers limitation.

Rules evidence: the [official Comprehensive Rules effective August 7, 2026](https://media.wizards.com/2026/downloads/MagicCompRules%2020260819.txt), specifically 106.7, 302.6, 601.2f, 602.2b, 605.1–605.2 and 702.10c; and the [official Hobbit rules update](https://magic.wizards.com/en/news/announcements/the-hobbit-update-bulletin) for library movement and mana-ability classification.
