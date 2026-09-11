# ADR: exact basic mana payment plans

Accepted for `engine-mvp-mana-plans`, the first prerequisite split from `engine-mvp-decisions`. The native roadmap retains the original parent's full acceptance and downstream release dependencies. Follow the [engine charter](../ENGINE-CHARTER.md) and [source delivery procedure](engine-source.md).

## Ownership and reuse

The canonical Rust core owns payment decisions and execution. `mana/payment.rs` now supplies one opaque `ManaPaymentPlan`, planner and executor to spell casting and activated-ability costs. Affordability calls that planner. Ability enumeration uses the same composite-cost preparation as activation. The pool payment algorithm remains the existing `can_pay`/`pay_mana_cost` implementation; no TypeScript solver or Oracle parser was copied.

The source accumulator and separate hand-written auto-tap accounting were removed. Planning previews the existing `activate_mana_ability` primitive on private state, including its immediate triggered mana and events. The executor uses that primitive again on the committed candidate, so preview events never leak. `GameState::clone`, the existing exact core hash, physical CardIds, mana pools and zone operations remain their canonical owners.

CLI, desktop and worker consume the same engine crate. MCP receives an immutable source pin and generated contract provenance; this changes no worker protocol or public simulation capability. Existing TypeScript payment/sequencing routes remain frozen until `engine-mvp-cutover` replaces their consumers and deletes overlapping production behavior together. No fallback is introduced.

## Payment contract

A plan binds to the complete versioned [core-state hash](engine-state.md), names the player and ordered physical sources, and records the exact colored/colorless allocation to spend. Its fields are private; there is no deserialization or caller-authored witness constructor. Even an unrelated core-state change requires replanning. This is an internal resource witness, not a serialized scheduler decision.

Current sources are the engine's existing fixed tap-for-one abilities plus their existing immediate mana triggers. Selection orders colorless before colors and preserves canonical battlefield sequence for ties. Sorting entropy-created CardIds would change choices across fresh same-seed setups; the existing seeded transcript regression caught this and remains required. It previews a sufficient prefix, then removes redundant sources through canonical activation. The result is inclusion-minimal, not a claim of globally optimal play or minimum-cardinality payment. No scoring budget prunes affordability. Pool payment reserves colored and strict colorless demand before generic allocation, preserving unspent mana exactly.

Execution checks the originating hash, replays each selected source once on a clone, spends the exact allocation, then commits. Stale, missing-resource and unsupported-symbol errors preserve all caller state, including RNG/zone allocation, stack, events and pending triggers. Reusing a consumed resource plan fails because state changed. A zero-cost no-op may leave state identical; request identity and duplicate-request rejection belong to the future decision scheduler.

Source selection has quadratic worst-case activation work and clones core state; hashing also covers the whole core. This is correctness infrastructure, not a measured performance claim. Operational budgets and optimization remain release gates.

## Casting and ability transactions

Casting moves the spell onto a private stack state before mana activation/payment, then commits only on success. Failed payment restores the original zone, object identities, mana, events and stack automatically.

Activated abilities combine all mana components before payment, sum life costs with checked arithmetic, and reject repeated tap or sacrifice of the same source. A source reserved for the ability's tap cost cannot also pay its mana cost. Without a reserved tap, activating a mana ability before sacrificing that source is permitted. Supported mana, tap, life and sacrifice-self costs commit together with the stack object.

The old casting sacrifice check only tested whether a creature existed and never paid it. The old ability discard path picked the first cards. Both now return `UnsupportedCostChoice` until an explicit selection API exists. This deliberately removes false success. The original parent still requires those costs to work before MVP release; this prerequisite does not certify corpus support.

## Remaining parent obligations

`engine-mvp-mana-sources` owns alternative and simultaneous outputs, activation fees and dependencies, restrictions, proper control and summoning eligibility, and corpus source integration. The existing activation primitive's owner/control and summoning limitations are not repaired or newly certified here.

`engine-mvp-cost-choices` owns explicit targets, modes, ordering, hybrid/X/life/discard/exile decisions, optional and mandatory resolution choices, ward and actual spell-spend/expend accounting. Full scheduler transaction handling, runtime support guards, complete corpus clauses and release qualification remain required native work. New error variants and fail-closed choice behavior are internal compatibility changes; the core snapshot shape and worker wire contract stay unchanged.

## Evidence

Independent regressions in canonical `tests/mana_plans.rs` cover shared ability funding, exact generic allocation and excess, repeated resources/life, unresolved choices, strict colorless, unknown players, stale/reused plans, serialized continuation, triggered output, failed casting identity/event rollback and combined cost success. Seven initial behavioral failures were observed before implementation; review added a separately observed triggered-output failure. Existing incorrect sacrifice tests now require an explicit unsupported result and unchanged state.

The MCP fixture expectations in `src/analyze/manaModel.test.ts` supply physical-source exclusivity and strict-color examples. Dual alternatives, Signet funding and multi-mana output remain explicit richer-source conformance obligations. Recorded delivery checks cover Rust tests/doctests, strict Clippy, formatting, CLI compilation, a clean pinned worker build, native protocol acceptance and the configured MCP gates. Actual results and commits are retained in Magistr.

Primary rules evidence: [official Comprehensive Rules, effective August 7, 2026](https://media.wizards.com/2026/downloads/MagicCompRules%2020260807.pdf), rules 118.3a, 601.2f-h and 602.2b. These establish exact spending and complete cost payment; they do not make the bounded engine implementation complete.
