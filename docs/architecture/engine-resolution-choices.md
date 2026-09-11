# Canonical announcement and resolution choices

This receipt tracks `engine-mvp-resolution-choices` under the [engine charter](../ENGINE-CHARTER.md) and [source integration procedure](engine-source.md). Native Magistr records remain the execution authority.

The [source pin](../../engine/source.json) advances to canonical commit `417a1b5ea5194bdde7933c5390aaff61c76d7ae0`, retained on the isolated `engine-mvp-resolution-choices` branch. Cargo.lock and worker protocol bytes are unchanged; the contract manifest records the new source revision.

## Architecture and reuse review

The canonical Rust core owns announced modes, targets, X, and decisions made during resolution. Its existing physical objects, zones, derived characteristics, casting/payment transactions, stack, effects and scheduler supply the shared foundations. Policies select from engine requests. MCP continues to own catalog snapshots and presentation.

Casting and ordinary activated abilities validate explicit declarations against the exact canonical state before payment. Selected modes, bound targets and X remain on the stack after payment. An explicit triggered-ability placement helper uses the same domains and retains the ability effect independently of its source's current zone. Legacy synchronous convenience entrypoints bind their inputs to the current state; clients requiring stale-response rejection use the declaration entrypoints.

The CLI's independent Oracle target interpretation is removed. CLI and desktop consume the same core action/choice contracts, including modal casts and activations. The previous ordinary-activation path that dropped its effect is replaced with effect-retaining stack placement. Legacy draw/life trigger primitives forward to the shared effect executor. No TypeScript gameplay owner, worker protocol, dependency or public MCP route is added.

## Announcement and continuation contracts

`ChoiceRequest` describes target, mode, order, optional and object selections with source identity, sequence, player, cardinality, options and canonical state hash. Membership, duplicates, printed mode order and explicit ordering permutations are validated by the engine. Cards bind to their physical `ObjectId`; leaving and returning creates a different target. Damage targets currently cover players and ordinary creatures. Planeswalker/battle damage, including mixed creature types, rejects explicitly as unsupported until the shared damage owner handles loyalty/defense consequences; it is not silently offered as an executable choice. Target legality is checked at resolution start, with illegal slots retained so surviving targets cannot shift between instructions.

Modes and X are announcement choices. Optional actions, discard/sacrifice selections and explicit effect ordering are resolution choices. Mandatory instructions perform as much as possible; an empty eligible set continues instead of waiting for an impossible answer. Optional costs must be feasible, while an optional draw from an empty library is still allowed. Failed draws cause loss only after the current resolution finishes.

A pending decision retains the stack object, execution frames and target offsets. Submissions must match the regenerated request and choosing player exactly. Invalid or stale responses preserve state and events transactionally. The scheduler pauses without granting priority, running state-based actions or draining the event log. A valid response resumes at the next instruction, preserving earlier effects exactly once.

Core snapshot schema version 4 serializes the continuation and announced choices. This qualifies exact core snapshot/resume; it does not serialize a whole live scheduler, policy or worker job. Search hashes include the new stack fields. Bounded announcement enumeration samples at most 256 declarations and X values 0–16; the declaration API accepts other legal X values. These are policy search bounds. Pending mandatory choices use a direct legal selection before search budgets are applied.

## Independent evidence and boundaries

Independent scenarios in canonical `tests/resolution_choices_review.rs` distinguish targeting from later decisions using branches grounded in the frozen [corpus](../evaluation/engine-mvp/corpus-v1.json):

- Reclamation Sage (`032ec6e2-6cc3-4a97-9cc7-3233f5e11904`): targets are announced before an optional action; a vanished target cannot be replaced during resolution.
- Fleshbag Marauder (`4b1bf05e-753e-4350-a913-894cf3cecc0c`): sacrifice selects current controlled objects without targeting; an empty pool continues. The fixture exercises one player's primitive, not simultaneous multiplayer sacrifice.
- Transplant Theorist (`4a60db66-0347-4efc-8507-ab7ed8d984fe`): choosing an optional draw leads to mandatory discard from the resulting hand, including after a core checkpoint.

Additional cases cover partial target invalidation, leave-and-return identity, stale/forged/wrong-player answers, incomplete mandatory and optional actions, printed modes versus order permutations, activation with X and source sacrifice, source-independent triggers, and attempted activation during a pending choice. These are independent primitive branch fixtures, not full card bindings or card-admission certificates.

Full effects and corpus admission remain with `engine-mvp-effects` and coverage qualification. Automatic modal/targeted trigger announcement collection and APNAP ordering remain with the existing `engine-mvp-zones` scheduler work: the current scheduler preserves its queue and returns an explicit diagnostic when such an announcement is required. Whole live checkpoints and deterministic replay remain downstream; pre-existing unseeded stack identity allocation is linked to the replay owner. These discoveries are recorded in `think:325` and linked to the existing roadmap records.

## Recorded qualification

- All 1,541 canonical workspace tests passed, with three pre-existing ignored tests; all workspace doctests passed. This includes 24 focused choice regressions, 46 CLI tests and the existing search timing gate.
- Workspace all-target compilation, strict Clippy with pedantic warnings denied, Rust formatting and the staged source diff check passed.
- A separate clean clone at the pin passed identity and lock checks before and after its locked offline macOS arm64 release build. The worker self-check succeeded from an empty directory without a catalog; the inspected dependency graph contains neither desktop nor downloader dependencies.
- All 36 independent MCP-owned mana source scenarios and all eight real native worker protocol tests passed. Canonical contract import and parity passed.
- MCP's final typecheck, tests and lint are recorded on `task:engine-mvp-resolution-choices-verify`.

Review fixes included target incarnation, exact-once continuation, deferred draw loss, sparse mandatory selection enumeration and payment/hash reuse during announcement enumeration. The final workspace test run took 18.7 seconds; earlier search timing failures remain in the native history. Tests were not weakened or given larger budgets. Three pre-existing desktop lint findings received equivalent style repairs. Temporary generated desktop build inputs were removed before the canonical commit.

The original engine checkout and six existing MCP workflow edits are preserved. No push, publication, installed release, full card admission or GUI rendering is claimed.

Rules basis: the [official Comprehensive Rules](https://media.wizards.com/2026/downloads/MagicCompRules%2020260819.txt), especially 601.2b–c, 608.2b–e, 609.3, 117.2e, 118.11–12, 121.3 and 700.2. The retrieved document is effective August 7, 2026: 977,822 bytes, SHA-256 `4381ad1b39ab2c05f7d03633a20f711ed37277074d3266dcba5f38cbb527423f`. Source identity was verified by the recorded `Official resolution rules source identity` check.
