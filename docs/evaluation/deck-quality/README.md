# Commander deck quality baseline v1

This freezes a broad deterministic benchmark before Commander construction work changes the engine. It adds 22 authored complete decks, 998 pinned card facts/printings, independent graders, and a future host-evaluation contract. All earlier [v0.3 evaluation receipts](../README.md) remain unchanged.

The baseline contains **185 observed MCP tool calls** against production revision `7d29507c7073acd9bd52627dc5d281b16fdf4109` (server 0.3.0, Node 24.14.0, macOS arm64). Production source and lockfile were unchanged during capture. Raw results, inputs, measured call durations/response bytes, and source hashes are retained in [baseline-v1.json](baseline-v1.json).

## Observed results

| Check                                    | Passed | Failed | What the result means                                                                    |
| ---------------------------------------- | -----: | -----: | ---------------------------------------------------------------------------------------- |
| Resolve supplied full reference lists    |     22 |      0 | Every named reference card resolved                                                      |
| Preserve reference zones and quantities  |     21 |      1 | The maybeboard case loses its outside-deck zone                                          |
| Independent deck constraints             |     20 |      2 | Missing maybeboard plus Atraxa's intentionally uncertifiable budget                      |
| Normal legality verdict                  |     22 |      0 | Production agrees with independently authored legality facts                             |
| Complete deck price                      |      0 |     22 | Current budget tool excludes commanders and treats an unpriced card as zero              |
| Quantity-aware acquisition               |      0 |     22 | Commander omission and membership-only inventory cannot satisfy complete-copy accounting |
| Count-preserving finite-copy corruptions |      0 |      2 | Production accepts eight Seven Dwarves and ten Nazgûl                                    |

Failures in this table are **observations**, not failures of the benchmark test suite. The suite verifies that the observations were captured and graded correctly. The normal legality result does not excuse the two failed corruption probes.

All 22 requested build/tune/acquisition journeys remain **unexecuted/unsupported in this scripted baseline**. The runner imports authored answers to measure existing analysis; it does not generate those answers. Fifteen empty/partial construction requests, all persistent-intent and exact mana/package questions, one unsupported interaction request, and one simulated unavailable-profile discovery request are recorded separately. No model success, tokens, competitive strength, or win probability is inferred.

## Corpus and independent truth

[corpus-v1.json](corpus-v1.json) freezes each prompt, starting state, complete reference list, calibration/holdout split, protected cards, owned quantities, theme constraints, source facts, and prices. The reference deck is an example satisfying the constraints, not a required exact answer for future construction. Source permission, card/printing provenance, sampling coverage, and the distinction between authored and observed facts are documented in [sources.md](sources.md).

The corpus spans zero through five colors, popular/obscure sampling labels, casual/competitive/theme goals, ordinary partner, partner-with and Background configurations, and unlimited/seven/nine-copy exceptions. The new Rhys commander uses a **simulated unavailable EDHREC profile**; no live profile absence was established. There are 30–40 lands per reference and at least 20 themed main-deck copies. Shared staples cross the case-level split; this is not a card-disjoint or secret holdout.

The legal Atraxa reference retains an unpriced, protected Reyhan. Its prompt explicitly requires cost uncertainty under the stated cap. The expected budget-certification result is failure with unknown cost; a truthful disclosure can satisfy the user task. Moving or repricing that card to make the benchmark green would remove the intended question.

[graders.ts](../../../src/evaluation/graders.ts) imports no production validator, role classifier, budget, mana, or optimizer logic. It uses authored card legality/color/pair/copy facts, integer-cent and quantity arithmetic, and separately checks actual artifacts and claimed answers. Costs include main plus commanders; optional companion cost is separate, and maybeboard is excluded. Missing quotes remain unknown; ownership consumes only the copies actually owned.

[references.ts](../../../src/evaluation/references.ts) freezes eight named mana-payment puzzles and two package-selection optima. It exhaustively enumerates tiny finite choices instead of trusting production simulation or optimization. One dual cannot pay two colored pips, colorless cannot pay a blue pip, unavailable sources cannot pay, and cheap packages that violate a role/protected constraint are rejected. These references do not model arbitrary activation costs, spend restrictions, replacement effects, combat, companion deckbuilding predicates, or general Commander strategy.

Rule provenance includes the [official rules entrypoint](https://magic.wizards.com/en/rules) and its [Comprehensive Rules revision dated August 19, 2026](https://media.wizards.com/2026/downloads/MagicCompRules%2020260819.txt), alongside card-specific release notes in the source record. Frozen facts are historical benchmark inputs, not a replacement for future rules refreshes.

## Final evaluation registration

[registration-v1.json](registration-v1.json) is marked `preregistered-not-executed`. It requires every case across Codex CLI/stdio and Claude CLI/HTTP, three fixed seeds, and one repetition per seed: **132 future host runs**. Exact host/model/runtime/data/provider/settings versions and limits must be pinned before the first comparable run and reused. Those version values are not fabricated in this baseline.

The contract freezes every hard invariant, exact reference fixture ID/digest, task coverage, and explicit exceptions. Atraxa expects unknown-budget failure plus uncertainty disclosure. Rhys expects the unsupported gameplay guarantee to remain unsupported with disclosure, while ordinary deck invariants still hold. Unsupported cannot be counted as success or introduced after seeing poor results. There is no aggregate score that can conceal a missing hard case.

The candidate-report validator checks matrix completeness and expected statuses. It cannot authenticate a transcript merely from a claimed path or hash. The terminal release-gate runner must read actual artifacts/transcripts, apply the independent graders, prove per-host reference results, enforce frozen limits, and supply measured usage. No final host executions occurred in this chunk.

Corpus and registration bytes are hashed in the retained baseline. Future additions must use new versions and preserve v1, its difficult cases, original outcomes, and partitions. Do not tune implementation or prompts on holdout results.

## Reproduce and inspect

Run all deterministic evaluation checks:

```sh
npm test -- src/evaluation
```

The normal suite never overwrites the baseline. Capture a separate observation only to a new path:

```sh
DECK_QUALITY_BASELINE_OUT=/tmp/deck-quality-new.json npm test -- src/evaluation/baseline.test.ts
```

Capture uses exclusive file creation, requires clean production source relative to the recorded Git revision, blocks external network calls, and builds an isolated index from the bundled subset. Each case gets a fresh server, deck store, collection, and session. These calls use the real SDK client and production server handlers through in-memory transport; stdio/HTTP framing and real model-host behavior belong to the terminal gate.

[receipt.ts](../../../src/evaluation/receipt.ts) regrades stored raw responses, checks the exact probe sequence and deck identity, ties artifacts to observed state, recomputes metrics, and verifies cap-corruption deltas. Mutation tests reject missing cases/probes, spoofed zones/verdicts, falsely green costs, and unsupported-as-success substitutions.

The benchmark has no live network, shipping/tax estimates, marketplace fulfillment, expert tournament validation, or newly implemented deckbuilding capability. Prices are historical selected English paper/nonfoil observations. Production defects are preserved for subsequent chunks; this change only establishes the evidence and its evaluation contract.
