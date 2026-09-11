# Canonical transactional and bounded execution

This receipt follows the [engine charter](../ENGINE-CHARTER.md) and [canonical source procedure](engine-source.md). Native Magistr chunk `engine-mvp-execution-control` owns scope and execution evidence.

## Architecture and reuse

The canonical Rust `mtg-engine` remains the sole gameplay executor. Execution control measures work and checks cooperative stop requests; it does not decide legality, resolve effects, evaluate state-based actions or select policy decisions. `GameLoop` owns scheduler phases and priority. The existing resolution continuation owns resolving stack frames and requests. Existing casting, ability, mana, zone and state-clone owners execute transactions.

The implementation replaces implicit passes after rejected actions and discarded resolution errors. It preserves the current scheduler phase, priority passes, pending requests and spent counters across calls on the same live loop. Operational interruptions do not grant priority or emit a completed step/game. Source errors remain typed through policies, rollouts, CLI and desktop. Reporting distinguishes operational caps, interruptions and engine errors from completed Magic outcomes.

The legacy TypeScript gameplay/payment/sequencing paths remain frozen until `engine-mvp-cutover` switches public routes and deletes overlapping implementations atomically. No TypeScript behavior, payment solver, source parser or fallback is added here. The worker continues to depend directly on the same headless core, with no desktop or downloader prerequisite.

## Evidence and boundaries

Independent regressions first demonstrated that rejected land timing and unaffordable casting caused ten policy decisions rather than stopping at the first rejection. Further red tests showed successful resolution of absent/unsupported ability effects, a corrupted counter target consuming stack objects, an advanced scheduler after rejection, and operational caps counted as draws.

Acceptance checks exercise rejection rollback, work and action exhaustion within a turn, repeated live continuation, pending mandatory choices, cooperative stop, transactional resolution errors and honest result classification. Exact canonical state and event/log comparisons detect duplicated effects and fabricated priority or step completion.

The deterministic counters bound charged execution operations. They are distinct from elapsed-time and process-memory enforcement, which remain the parent supervisor's responsibility. Checks surround admitted engine units; they do not preempt arbitrary policy callbacks, whole-state cloning/scanning or one state-based-action pass. A policy or foreign call that never returns still requires parent termination. The human action channel must be closed by its owner to interrupt a blocking receive; existing combat callbacks still use their empty-declaration behavior on channel closure. Search rollouts receive finite per-rollout limits, while the outer stop token is checked when the policy callback returns. Whole live scheduler/policy serialization, worker job checkpointing and replay remain their existing downstream chunks; this unit's live continuation must not be described as a complete persisted game checkpoint.

The existing `engine-mvp-preview-worker` and `engine-mvp-supervision` records are linked to think:332 for whole-input admission and parent enforcement. Active-effect preflight does not inspect effect trees on unrelated library cards, lower stack objects or registered triggers before the candidate state clone. Wide remaining-frame clones can also be quadratic. Those owners must qualify admitted depth/breadth, memory and cancellation latency; the counters alone do not certify these costs.

The unrelated generic `search/mcts.rs` abstraction has no production MTG adapter. Its unbounded generic simulation loop was captured as `engine-evolution-generic-search-budget` in backlog before future adoption.

## Primary references

The [official Comprehensive Rules effective August 7, 2026](https://media.wizards.com/2026/downloads/MagicCompRules%2020260807.pdf), rules 117.2e, 117.4–5 and 704.3, constrain priority and stabilization. Rules 733.1–2 describe reversal of illegal actions and retention of priority. These support the explicit rejection and continuation boundaries; they do not certify the entire fixed corpus.

[Wasmtime's fuel and interruption documentation](https://docs.rs/wasmtime/latest/wasmtime/struct.Store.html) provides prior art for separating deterministic work limits from cooperative and elapsed-time interruption. No Wasmtime dependency is introduced.

## Delivery and verification

Canonical source commit: `0a9cf00790b40e9a00467e62a81eb0fb8a2b248f`, retained on the isolated `engine-mvp-execution-control` branch. The original canonical checkout and six pre-existing MCP workflow edits are preserved. Cargo.lock, dependencies and generated worker contract bytes are unchanged; MCP advances only source provenance and this receipt.

Recorded canonical gates passed: 1,577 workspace tests (three existing skips), 108 doctests, workspace all-target compilation, strict Clippy with pedantic warnings denied and Rust formatting. Seventeen independent scheduler/resolver/corrupted-cursor tests prove rollback, live continuation, within-turn exhaustion and typed rejection. The final malformed target-offset test first reproduced an overflow panic, then passed with checked arithmetic and exact unchanged canonical bytes.

Desktop frontend production build, native compilation and application bundling passed. CUA inspected the actual Tauri renderer and accessibility tree after importing an explicit replay presentation fixture through the real decoder: `Run status`, `No winner`, and `Execution interrupted: work limit reached`. This is presentation evidence. Live preset play was unavailable because the local Scryfall catalog was not loaded; no download or played-match claim was made. Existing frontend bundle-size and ambiguous-duration-class warnings remain.

A separate clean clone at the pin built the arm64 release worker with `--locked --offline` and external Cargo outputs. Source/lock identity and generated contract parity passed before and after qualification. The selected dependency graph contains the canonical core and excludes Tauri, HTTP/download dependencies and the download feature. An empty-directory, catalog-free self-check passed under a parent timeout; all eight actual native worker protocol tests passed.

Final Magistr `all` passed with `recorded=true` and every check `verified=true`: TypeScript compilation, 26 source/contract pretests, 1,517 MCP tests, and lint/Prettier. Nine default tests were skipped, including the eight native cases run separately above. Existing real stdio/HTTP MCP and persistence tests remain part of this gate. No push, package publication or roadmap file export was performed.
