# Fixed Commander engine baseline

This preregistration freezes the recorded Muldrotha deck before engine integration. It is an input and acceptance contract, not a claim that the engine implements these cards or can finish a Commander game. The native Magistr roadmap remains authoritative; this directory is evaluation data, not a roadmap export. See [the engine charter](../../ENGINE-CHARTER.md).

## Inputs and ownership

[corpus-v1.json](corpus-v1.json) owns the exact deck, its authored intent, 77 unchanged canonical CardGameplay records from snapshot 2026-09-09, card requirements and numeric qualification targets. Four exact mirror seats each start with 99 library cards and Muldrotha in the command zone: 400 distinct physical instances. Repeated basics retain their original quantities. Do not replace a hard card with an easier one.

Source names, JSON pointers and raw SHA-256 hashes identify the existing live-session artifacts. The original final deck artifact is `22-final-deck.json`, SHA-256 `78f4902da75187845104d41f5a972d55be22515f1f44e42450b34637e05713c0`. The frozen records are data copied from that session, not another card parser or catalog.

Every record has one normal face. Requirement spans address every nonempty Oracle paragraph by face index and JavaScript UTF-16 offsets, start inclusive and end exclusive. They include reminder and construction text so nothing vanishes silently. Scenarios give independently expected outcomes; owners identify native implementation chunks. Shared requirements cover rules that cross card boundaries. Empty basic-land Oracle text does not erase intrinsic basic-land mana abilities.

Seven generated token families have explicit requirements. Their related-card references are not complete canonical token definitions. Catalog integration must capture those definitions and pin the applicable rules and keyword evidence before coverage can pass. Sivriss's Background clause is construction-relevant but inactive for this library placement. A Spacecraft predicate or an unrelated combo-piece link does not add absent cards to this fixed pod.

The Rust engine owns all executable rules, state, choices, payment, RNG and card behavior. This fixture and its TypeScript audit contain no gameplay execution. The audit reuses the existing evaluation digest helper and checks only frozen input integrity. Passing it proves neither semantic correctness nor supported-card coverage.

## Measured source baseline

[baseline-v1.json](baseline-v1.json) records revisions, toolchains, isolation, exact command arguments and observed results. The engine was checked from clean commit `b2d90180ab3f30a95eae5e8b5a99948686131fa8` in a detached worktree, excluding all original dirty and untracked work.

- Core check, CLI check and scoped formatting passed.
- Unit/integration tests: 1,275 passed, two existing performance tests ignored.
- Documentation tests: 102 passed, five failed.
- Strict Clippy failed at `search_agent.rs:132`; compilation stopped, so more lints may remain.

The engine source integration chunk must resolve the failing gates before pinning a release source. Test totals are not corpus coverage. Timings include compilation on a warmed dependency cache; no gameplay throughput was measured. Temporary log paths are provenance references, not distributable runtime dependencies.

To reproduce, create a clean detached checkout of the recorded engine revision, use the recorded Rust toolchain and an isolated Cargo target directory with four build jobs, then run the six recorded argument arrays in that checkout. Offline mode requires a previously populated dependency cache. Preserve the original checkout. Run the MCP audit with:

```sh
npm test -- src/evaluation/engineBaseline.test.ts
```

## Qualification contract

The exact values live once in `corpus-v1.json.registration`. They are preregistered targets, not observed capabilities. Qualification targets macOS arm64 on the recorded Apple M5 Max / 48 GiB reference host, macOS 26.5.2 and Node 24.14.0; this does not certify every supported Node version or Mac.

The fixed release cohort is seeds 0 through 255, once each, with starting seat `seed % 4`. Independent per-seat shuffle and policy streams must be stable across scheduling. Pin the exact engine, executable policy, protocol, rules and catalog digests before running. The initial policy sees only legal player information and uses no rollout search.

Acceptance requires at least 244 rules-terminal trials, at most 12 explicitly reported deterministic turn/work truncations, and at least one valid winner. All 256 trials stay in the denominators. Unsupported behavior, illegal actions, engine errors, replay mismatches and unexpected wall/memory/output limit failures must all be zero. Mirror-seat outcomes do not establish matchup strength or a deck's competitive win rate; no favorable seat-win percentage is required.

Replay every trial. Compare deterministic outcomes and transcript hashes at worker concurrency one and two. Exercise the registered checkpoint seeds and scripted pending-trigger/stack states. Run 20 cancellation probes in each queued, executing and unresponsive state; test each declared resource boundary and its immediate overflow separately from the standard cohort.

Policy candidate caps must never shrink executor legality or discard mandatory rules work. Player-turn limits count individual turns, not rounds. Resource exhaustion, cancellation and incomplete replay output remain explicit terminal statuses. Sampled RSS watchdog thresholds can overshoot and are not OS-enforced hard memory guarantees. Refuse new artifact allocations when the retained quota is exhausted; preserve referenced evidence.

## Changing the baseline

Component digests use the existing `digestEvaluation` convention: recursively key-sorted compact JSON hashed with SHA-256. They are not RFC 8785. A literal digest outside the fixture pins the complete corpus, and the tests independently pin the captured records and final source artifact. The loader rejects any input fields discarded by its audit projection. A changed card, quantity, clause span, owner, scenario, generated object, seed or budget must fail the audit until the change is explicitly versioned and reviewed.

Do not repair a disappointing benchmark by silently changing seeds, dropping failures, weakening expectations or relabeling unsupported cards. Record evidence, update the native decision and create a new baseline version before a changed qualification run. Preserve v1 for comparison.
