# Explicit mana outputs and restricted allocations

Date: 2026-09-10. Native chunk: `engine-mvp-mana-outputs`, split from
`engine-mvp-mana-sources`. The parent's original acceptance is unchanged.

## Architecture and reuse review

The canonical `mtg-game-engine` Rust core remains the production owner of source
activation, exact allocation, payment and affordability. MCP pins the source and
generated contract; no TypeScript gameplay algorithm or new support admission is
introduced. The existing TypeScript mana model and frozen fixtures supplied
independent examples of exclusive dual outputs and Signet activation fees, not
runtime logic for the Rust engine.

This extends the opaque payment witness from `engine-mvp-mana-plans`. One shared
pool allocator serves final payment and activation fees; one activation executor
serves explicit choices, search previews and plan replay. A shared
`FixedAbilityCost` aggregates mana, life, tap and self-sacrifice costs for both mana
and ordinary activated abilities. Casting, action enumeration and heuristic
affordability call the same context-aware payment planner.

Each physical source exposes separate abilities (`ManaMode`). Each ability offers
exclusive output bundles (`ManaOutput`); all colored or true-colorless units in
the chosen bundle are produced together. Fixed mana fees are paid before output.
Every supported mode consumes its tap or self-sacrifice resource. A permanent can
tap for one ability and later sacrifice for another, but cannot reuse either
resource. Outer activated costs reserve their tap, sacrifice and life resources
before choosing a mana plan.

Restrictions remain attached to floating units. Supported restrictions are
unrestricted, spells of a specified card type, and activated abilities.
Context-free legacy APIs may spend only unrestricted mana. Intermediate generic
fees enumerate every color allocation; eligible restricted units of the same
color are spent first. This is sound for these restrictions because only the
activated-ability restriction can fund an intermediate fee. Final allocation has
no remaining demand and uses a deterministic choice.

General search explores source order, ability, output and fee choices without
a scoring cutoff. It is finite because supported effects cannot restore a tap or
sacrificed source, but may be exponential; this is not a simulation performance
qualification. Legacy fixed tap-only sources retain the polynomial
prefix/minimization path, with exact-search fallback when an activation rejects.
Affordability and execution use the same choices. Replay checks the original
state hash and exact fee pools, executes on a private clone, then commits all
resources and events together.

One production event is emitted per activation, including simultaneous output.
The legacy `ManaProduced.color` is only a uniform-color hint; mixed/colorless
output is `None`. Color-sensitive production triggers are not claimed. Supported
immediate mana triggers are `AddMana` and credit their trigger controller;
unsupported immediate effects explicitly reject and roll back.

## Compatibility and retained work

Core snapshot schema is now version 2 because source definitions and restricted
pool units change serialized state. Version 1 checkpoints are explicitly rejected;
no silent migration is attempted. Existing fixed mana source constructors and
ordinary unrestricted payments remain available. Generated worker contract
payloads and support-preflight qualification remain unchanged.

The parent still owns continuous-control history, derived types/haste/ability
availability, contextual Commander/opponent-land colors, variable production,
source/casting cost changes, and complete corpus binding. These requirements are
recorded in prerequisite `engine-mvp-mana-eligibility`; land-entry and Commander
owners must be coordinated rather than duplicated. Repeatable modes without a
tap or self-sacrifice cost and unknown activation components reject explicitly.

Current CR 118.3 requires sufficient resources for activation costs; CR 106.6
preserves spending restrictions. Eligibility needs current rules as well:
the August 2026 change excludes abilities whose own costs or effects move cards
to or from libraries from mana-ability status. This child does not expand the
catalog's eligibility parser. See the
[current official rules](https://media.wizards.com/2026/downloads/MagicCompRules%2020260819.txt)
and [official update bulletin](https://magic.wizards.com/en/news/announcements/the-hobbit-update-bulletin).

## Verification and delivery

Nineteen independent Rust scenarios cover dual exclusivity, Sol Ring simultaneous
output/excess, Signet fee order and self-funding rejection, generic-fee
backtracking, life/sacrifice rollback, outer-cost reservations, retained
restrictions, explicit choices, tap-then-sacrifice, snapshot/stale-plan behavior,
true colorless, trigger ownership/rollback and restricted-mana action enumeration.
A review regression proves that an unusable legacy source does not hide a valid
payment from another source. Fourteen earlier payment-plan regressions remain.

Observed red tests exposed two composite-cost bugs (spending life reserved for
the outer cost and sacrificing its source to fund its own sacrifice cost), plus
the legacy-source review failure. The canonical shared resource handling and
fallback repaired them. Full core/worker tests, strict Clippy, formatting and CLI
consumer compilation are recorded in Magistr.

Delivery follows [canonical source qualification](engine-source.md): commit
Rust first, qualify a separate clean checkout at the pinned revision, build with
an external target directory, run the native worker in an empty working
directory, verify source cleanliness again, sync/check generated contracts, run
the real native MCP protocol tests and all configured MCP gates. Native protocol
tests validate integration/preflight compatibility; they do not claim that the
worker exposes this internal payment API or that the parent is complete.
