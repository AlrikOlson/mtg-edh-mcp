# ADR: source-bound support qualification

Accepted 2026-09-09 for `engine-mvp-coverage`, under the
[engine charter](../ENGINE-CHARTER.md). The source revision and lock digest live
in [the immutable pin](../../engine/source.json).

## Delivered boundary

Core `cards::support::assess` inventories exact, unlowered gameplay source:
top-level characteristics, every ordered face, UTF-16 Oracle clause offsets,
intrinsic requirements, shared rules and generated-object dependencies. A
build-time projection preserves all 77 frozen Oracle identities, their owners,
expected scenarios, source fingerprints and all seven generated-object families.
The projection generator refuses a changed frozen corpus digest; it is not
another runtime catalog or Oracle interpreter.

Qualification binds the entire gameplay record, separate text/face digests,
registry/corpus digests, implementation version and qualifier/implementation/test
bytes. Full-source hashing intentionally includes printing provenance and
metadata: a new printing can conservatively require requalification even when
its rules text is identical. It does not lowercase or strip optional branches,
alternate costs, keywords, layouts or dynamic characteristics. Unknown or changed
source loses every prior qualification and expected scenario attachment.
The implementation digest covers the files used by the current qualifier;
the immutable source pin binds the complete engine dependency graph.

Expected scenarios are obligations, never passing evidence. Only the three
frozen basic-land intrinsic mana clauses have executable evidence: existing
factory and mana-activation behavior produces one appropriate mana and rejects
a second activation of the tapped land. Every full-card report is currently
unsupported, including those basics, because physical adaptation and shared
gameplay rules remain unqualified. Reports expose source paths and reasons;
over 2,048 requirements returns a typed limit error instead of truncating proof.

The old `classify_card(&Card)` optimistic heuristic now returns unverified:
a lowered runtime Card cannot establish original source completeness. Existing
CLI/desktop enum consumers retain compatibility. Protocol 3 adds internal
`support_check` / `support_checked` generated messages. The worker verifies the
existing immutable catalog, calls core qualification and projects the report
through generated validation. It does not construct cards or games. Expected
version/digest mismatches, missing identities and report limits are typed invalid
queries; unexpected registry/adapter failures are typed engine errors.

## Architecture and reuse review

| Decision                           | Single production owner and disposition                                                                                          |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Canonical source and authored deck | Existing MCP CardIndex/DeckStore capture; no worker lookup or ingestion.                                                         |
| Construction verdict               | Existing MCP validateDeck composition; support preflight never revalidates construction in Rust.                                 |
| Requirement qualification          | Canonical Rust core support module; generated worker messages only project its result.                                           |
| Wire shape                         | Existing canonical contract generator; MCP files remain checked derivatives.                                                     |
| Executable behavior                | Existing core factory, mana abilities, GameState and ZoneManager; no new gameplay parser or simulator.                           |
| Frozen requirements                | Existing evaluation corpus; core registry is a digest-checked generated projection.                                              |
| Legacy TypeScript simulator        | Frozen until engine-mvp-cutover replaces routes and deletes overlapping code atomically.                                         |
| Permissive authoring factory       | Remains for existing engine consumers. Runtime integration must make fallback paths unreachable from worker admission/execution. |

Before implementation, native `think:302` split runtime acceptance into
`engine-mvp-support-runtime`, dependent on coverage, state and catalog-objects.
It preserves all-before-trial support admission and typed abort on unexpected
semantics, with no loss/pass/no-op substitution. That chunk is a mandatory
dependency of worker execution. Whole-corpus playable conformance remains in
`engine-mvp-corpus`. No report is an admission credential, and all four gameplay
capabilities remain false.

## Evidence and reproduction

Independent Rust regressions expose partial activation/spell false positives,
unknown branches/keywords and source drift. Core tests exercise the existing
mana implementation; worker tests cover typed failures and recovery. MCP native
tests check all 77 source/face/text fingerprints, every frozen face span, owners,
expected scenarios, generated families, exactly three clause qualifications and
zero playable cards. Negative native cases cover changed top/face text, Unicode,
dynamic power, keywords, layout, stale implementation identity, report limits,
forged permissive options and forged run IDs, followed by successful recovery.

From a clean checkout at the pin (see [source acquisition](engine-source.md)):

```sh
node scripts/engine-contract.mjs --check build/engine-mvp-coverage-clean
node build/engine-mvp-coverage-clean/crates/mtg-engine/support/generate.mjs docs/evaluation/engine-mvp/corpus-v1.json --check
CARGO_TARGET_DIR="$PWD/build/engine-mvp-native-target" cargo build --manifest-path build/engine-mvp-coverage-clean/Cargo.toml --locked --offline -p mtg-worker --release --target aarch64-apple-darwin
MTG_WORKER_BINARY="$PWD/build/engine-mvp-native-target/aarch64-apple-darwin/release/mtg-worker" npx vitest run src/engine/catalog.test.ts src/engine/workerProtocol.test.ts
```

Offline builds require cached locked crates. Eight native tests require the
explicit binary; ordinary MCP test runs skip them. Source/lock verification
must pass before and after the native build, with build output outside the
source checkout. Standard TypeScript gates and canonical core/worker tests,
strict Clippy, formatting and generated drift checks accompany acceptance.
No gameplay throughput, trial completion or public simulation is qualified.

Canonical source commit: `f82e1bf23f3705657a8ba8ad234ae512d71c18c3`.
Existing CLI and desktop Rust consumers also compile. The clean checkout lacks
production desktop icons, so that supplemental check used a generated 1×1 RGBA
fixture outside source with Tauri's `TAURI_CONFIG` icon-path override. It does
not qualify desktop packaging or modify its assets.
