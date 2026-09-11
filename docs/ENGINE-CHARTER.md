# Canonical MTG Engine Charter

Adopted 2026-09-09; expanded by explicit user direction on 2026-09-11. Native prime-directive decision: `think:337`; prior mission history remains at `think:287`.

## Project prime directive

Deliver complete, correct full-game simulation for any Commander-legal deck through `mtg-edh-mcp`, using the existing `mtg-game-engine` as the single canonical gameplay implementation. Users must be able to submit independently authored decks for an ordinary four-player Commander pod, run actual games, inspect outcomes and decisions, cancel work, replay games and compare deck revisions using engine evidence. Continue improving the engine and MCP together until this works through the installed MCP server.

The internal Forest/Bears fixture, exact Muldrotha mirror pod and subsequent diverse-deck cohorts are required delivery and verification milestones. None completes the any-deck directive. Prioritize usable end-to-end MCP increments, then broaden supported gameplay through the same owners; do not let unrelated improvements displace the route to full simulation.

This mission and the prohibition on duplicate production behavior are standing requirements for every agent and harness. Only an explicit user change can replace the mission or waive these constraints. Implementation decisions can evolve through evidence-backed architecture decisions; do not quietly weaken release acceptance to make a chunk pass.

The native Magistr roadmap is authoritative for scope, dependencies and status. This charter defines durable ownership and release invariants; it is not a second roadmap. Superseded native plans retain their evidence and links. This is a standing project prime directive, not a `/goal` task or authorization to create an API goal, background scheduler or unbounded implementation loop. Each invocation retains its requested scope: `$next` implements one ready chunk, a requested loop retains its bound, and planning refreshes do not start implementation.

## Autonomous roadmap maintenance

The user authorizes agents to maintain the native roadmap without repeated approval whenever evidence changes the best route to the prime directive. Before planning and before closing each substantial unit, inspect the current frontier and reconcile findings from code, tests, runtime behavior, rules, catalog changes and user feedback. Add, split, merge, rewrite, reorder and correct dependencies or status as needed; link evidence and preserve acceptance obligations, completed history and existing work. Resolve contradictions immediately instead of recording a gap only in prose.

Keep all planned unfinished work and new actionable discoveries `pending`, including dependency-gated work. Use dependencies, explicit external-blocker metadata and priority to describe readiness; do not use `backlog` as a parking state. A chunk being implemented may be `in_progress`, and completion/obsolescence must remain truthful. Retain non-goal work as lower-priority pending work without letting it block the simulation path. Promotion from stakeholder signals follows native evidence/lifecycle requirements and ends in pending roadmap work.

Keep the architect role active on every unit: identify the existing production owner, public and private consumers, invariants, dependency direction, reusable seams, alternatives and the migration/removal of overlap. Prefer the smallest coherent deliverable that advances actual MCP capability. Split oversized work into independently testable units before implementation. Update the plan proactively; do not change this directive, weaken correctness gates, reset another session's active work or introduce a competing engine.

## Any-deck completion boundary

Define each release against a dated, checksummed official Commander rules/legality snapshot and the complete corresponding Commander-legal Oracle card pool. Include all legal commander configurations and companions, every face, clause, optional choice, cost, generated object and reachable interaction. Custom cards, house rules and other formats require explicit separate scope; difficult legal cards cannot be excluded to make the denominator smaller. New cards, Oracle updates and rule/legality changes create pending requalification work and an explicit freshness boundary.

Support must generalize from the canonical executable card model rather than a deck-name or fixture allowlist. Before claiming any-deck completion, the complete legal-pool census must have no unresolved behavior obligations, mixed independently authored pods must run through the installed MCP, and independent rules/interaction evidence must accompany truthful policy, operational and statistical qualification. Unsupported-card rejection is necessary during development but does not satisfy this final gate. Compilation, card ingestion, keyword recognition, a completed MCP task or a capped trial does not establish a completed game.

A full simulation executes all starting procedures, ordinary turns, legal choices, stack/priority, multiplayer combat and terminal conditions through Rust. Mandatory rules draws, voluntary choices, cancellation, operational caps and engine failures remain distinct. Policies must respect hidden information and demonstrate useful play across strategies; their measured strength and limits remain explicit. Maintain and expand this evidence after release instead of treating a frozen snapshot as permanent universal coverage.

## Ownership

| Concern                                                                                                                                    | Canonical owner                        | Boundary                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Executable card behavior, legal actions, payments, physical objects, zones, stack, priority, combat, Commander runtime rules, random state | Existing Rust `mtg-engine` core        | Worker and policies call the core; they do not reimplement rules.                                                                                              |
| Oracle identity, faces, printings, text and immutable catalog snapshots                                                                    | Existing MCP data/index services       | Rust consumes the supplied snapshot and identity mapping; no competing lookup or refresh during a run.                                                         |
| Authored decks, intent, proposals, versions, collection and prices                                                                         | Existing MCP domain/storage services   | Jobs capture immutable inputs and never mutate authored state.                                                                                                 |
| Deck-construction legality and policy                                                                                                      | Existing MCP validation services       | Admission reuses this authority. Runtime action legality belongs to Rust. Retire or adapt overlapping construction verdicts; do not create a second validator. |
| Worker protocol                                                                                                                            | One versioned schema or typed source   | Generate both sides and check drift; adapters only translate and orchestrate.                                                                                  |
| Gameplay policies                                                                                                                          | Versioned engine decision clients      | Choose among legal decisions using explicit permitted observations; no direct state mutation or hidden-information shortcuts.                                  |
| Reports and presentation                                                                                                                   | MCP services consuming engine evidence | Statistical calculations and static catalog analysis may remain here; they cannot simulate rules independently.                                                |

The default source owner remains `~/Code/mtg-game-engine`. Integrate the crate through a pinned dependency and a headless worker, not copied Rust modules, a TypeScript port or a fork that competes with the original. The source-integration decision must fix the worker home, clean revision and cross-repository delivery procedure. Development path overrides are temporary; distributables rebuild from immutable committed source without an absolute developer path. If source ownership later moves, migrate it once and update all consumers rather than retain two maintained copies. Cargo documents the relevant [dependency mechanisms](https://doc.rust-lang.org/cargo/reference/specifying-dependencies.html).

Reuse core setup and evaluation across the worker and existing engine consumers. Extract needed routines from desktop-specific code into their existing canonical package. A GUI, CLI starter deck or downloader must not be a runtime prerequisite for the MCP worker.

## Architecture review on every unit

Before any substantial planning, implementation or review unit, record the existing owner, consumers and dependencies; identify what can be reused, what must change, and which overlapping path will be removed. Check the unit against the prime directive and update the native roadmap when the architecture or evidence changes. Keep gameplay regressions with the canonical engine and boundary tests with the adapter. Generate shared contracts instead of hand-maintaining parallel definitions.

Before completion, verify that the final change preserves one owner per decision, cite independent behavioral evidence, run the applicable real gates and record an atomic scoped commit. Inventory newly discovered work in the native roadmap. Preserve unrelated user changes in both repositories and never turn a dirty checkout into undocumented release provenance.

Independent reference fixtures and expected-result tests are encouraged. The prohibition concerns duplicate production truth, including shadow validators, behavior parsers, payment solvers, RNG/state machines and hidden fallback execution.

## Required finite MVP milestone

The fixed benchmark is the exact final recorded Muldrotha deck at `~/Movies/MTG-MCP-Demo-2026-09-09/session/22-final-deck.json`: 100 physical cards, 99 library cards plus Muldrotha in the command zone, and 77 distinct Oracle identities. The baseline chunk must preserve it as a digest-verified fixture with quantities, faces, Oracle text and source snapshot. Difficult cards cannot be silently substituted or excluded.

The initial pod has four independent seats using this identical deck: 400 distinct physical card instances sharing immutable definitions. Ownership, command-zone history, counters, targets, graveyards and per-object permissions must remain independent. This is real multiplayer with a bounded corpus. Diverse opponent decks are a separate required expansion milestone that can advance as shared runtime and MCP capabilities become ready; mirror-pod results do not establish matchup strength.

Support must cover every required Oracle clause, face, optional choice, alternate cost and runtime-generated object, including tokens. A finite support matrix links each requirement to its canonical implementation and independent expected-result scenarios. Pin text hashes and implementation versions; changed Oracle text invalidates prior support. The baseline inventory refines mechanic chunks before implementation so no generic remaining-abilities task hides unbounded work.

Release requires strict admission of all 100 cards at every seat with zero vanilla/no-op fallback. A recognized keyword, a populated catalog record or one implemented ability does not establish full support. Unknown or partially supported arbitrary decks receive exact unsupported-card/behavior diagnostics before trials start; unexpected unsupported runtime behavior terminates explicitly.

Implement actual four-player Commander setup, mulligans, turn/priority order, command casting and tax, command-zone choices, commander damage, multiplayer targets, ownership and elimination. Use a dated, checksummed [official Comprehensive Rules](https://magic.wizards.com/en/rules) snapshot for conformance evidence. Construction legality alone does not prove runtime support.

The fixed corpus also requires proper choices and payments, modes and spell effects, triggers and replacements, simultaneous zone changes, continuous characteristics, lands and mana sources, Muldrotha graveyard permissions, alternate costs, attachments, tokens and planeswalkers. Resolve these through existing shared primitives. Scripted scenarios must exercise clause branches and cross-family interactions; random games cannot replace rules tests.

Policies must play ordinary spells, advance the graveyard strategy, interact and participate in combat using legal information. Record their versions and bounded search settings. Optimal play, support for every Magic card and universal deck-strength or bracket estimates are outside the MVP claim.

## Execution and evidence

Every job captures engine/protocol/rules versions, immutable card and deck digests, seat order, policy/observation versions, seeds and numeric limits. Replays validate all decisions and canonical state hashes. Checkpoint continuation preserves the current RNG cursor, policy state, object identity, pending choices and stack; a seed-only restore is insufficient.

Sequential, parallel and resumed runs must agree on each advertised platform. Derive trial seeds independently of scheduling. Corrupt or incompatible traces fail explicitly. Keep hidden information scoped appropriately even when a report retains the complete underlying trace.

Before benchmark execution, declare hardware, seeds, sample/seat schedule, completion criteria and numeric budgets for payloads, jobs, concurrency, turns, actions, policy search, output, memory and elapsed time. Bound work inside one turn as well as across turns. Measure latency, throughput and cancellation against those budgets; do not select successful seeds afterward.

Use asynchronous child-process execution with explicit arguments, bounded framing, drained output, structured diagnostics and parent-enforced termination. The Node [child-process documentation](https://nodejs.org/api/child_process.html) is the implementation reference. Never interpret imported card text as executable code or permit protocol fields to select arbitrary shell commands, files or network destinations.

Cancellation must honor the selected protocol revision and host capabilities. Pin the installed SDK and real client compatibility matrix; use the [current MCP cancellation contract](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/cancellation) and preserve supported legacy behavior separately. Optional Tasks extension revisions and terminal tool errors require explicit adapters; a task status alone is not a game outcome. Test races, cooperative stop, hard kill, worker crash/hang, parent disconnect, output flooding and recovery. Hosts without task support still need a usable bounded workflow.

Preserve deck intent and prior reports across failures. Use existing principal/version/storage boundaries for immutable jobs and atomic persistence; test concurrent submissions, idempotency, disk/write failure and crash recovery. Retain referenced snapshots for replay and release rollback.

Report wins, draws, capped/truncated trials, cancellations, unsupported inputs and engine errors separately. State every denominator, policy, seat, limits, sample size and uncertainty calculation; account for dependence between paired seeds or seat rotations. Capped games are not losses. For mirror pods, report seat/policy outcomes and completion rather than matchup strength. Available combo pieces do not prove executable combos.

## Migration without competing engines

1. Freeze new production features in the legacy TypeScript gameplay/payment/sequencing paths; inventory their owners and consumers.
2. Develop and qualify the canonical Rust path through independent conformance fixtures and internal runs. Existing public routes retain their current single owner until cutover.
3. Switch the public routes and delete their overlapping TypeScript execution and behavioral parsers in the same delivery. Compatibility wrappers may translate schemas, never execute alternative rules.
4. Reject worker failures and unsupported behavior explicitly. Never fall back to TypeScript execution.
5. Gate release on an executable entrypoint/dependency check plus ownership review proving the superseded production paths are gone. Preserve static analysis, presentation and independent reference tests in their proper roles.

Keeping the previous packaged release for rollback does not justify two active gameplay implementations in the new release.

## Required local milestone release acceptance

The initial local binary target is macOS arm64. The baseline records exact Node/OS/native-addon versions; any additional advertised platform must pass native installed acceptance, not merely cross-compile. A clean installed package must run the fixed snapshot without Cargo/Rust, a GUI or a runtime catalog download. Document normal catalog onboarding separately.

Gate the release on all configured TypeScript checks and applicable Rust tests/checks/lints/format/build, complete corpus conformance, deterministic replay/resume, both supported MCP transports and client compatibility, operational limits, and real clean installation/update/rollback. Run the packaged four-seat benchmark with strict support, predetermined scripted legal victories and deliberate draw/cap/error cases; retain the unfiltered rollout outcomes.

Through real MCP calls, exercise support preflight, simulation submission, progress/cancellation, terminal reporting, replay and one reviewed evidence-backed deck revision with version guards and undo. Reuse existing deckbuilding, eligibility, zone and pricing authorities when addressing the demo's illegal-object, export-placement or partial-price reporting gaps.

Update the existing portable skills and safe installer rather than duplicate workflow instructions. Validate installed workflows through available real harnesses/clients and record what actually works. Produce an annotated deck/simulation/replay demonstration from the packaged server, retaining raw traces and visibly labeling timelapses.

Record immutable source revisions, artifact checksums, compatibility, required notices, known unsupported mechanics, policy limits and measured performance in release materials. Failed updates preserve the previous executable and user data. The standing prohibition on npm publication remains in force (`think:209`); local release preparation does not authorize publishing.

## Grounding and evolution

The 2026-09-09 audit found a usable headless Rust core at engine HEAD `b2d9018` with existing uncommitted work: 1,136 library tests passed (one ignored), 29 targeted integration tests passed, and the no-default-features check passed. These measurements describe the audited worktree, not a reproducible release baseline or proof of complete Magic rules.

Load-bearing seams are `crates/mtg-engine/src/game_state.rs` (state/RNG), `game_loop.rs` (priority/error handling), `cards/card_factory.rs` and `cards/coverage.rs` (partial behavior/heuristic coverage), `casting/mod.rs` (casting zones), and the desktop's `commands/play.rs` (two-player/commander-in-hand setup). MCP migration starts from `src/analyze/manaSequence.ts`, `manaModel.ts`, `sim.ts` and `src/server/analyzeTools.ts`, while retaining canonical card/deck services.

After MVP acceptance, continue toward any-deck completion through complete legal-pool census and qualification, measured diverse decks, broader mechanics and interactions, current rules evidence, general policies and installed MCP acceptance. Inventory, acquisition, other formats and unrelated host features stay behind this prime directive. Each expansion follows the same ownership and conformance rules. New evidence may refine the native dependency graph; it cannot silently erase the mission, difficult benchmark requirements or no-duplication constraint.
