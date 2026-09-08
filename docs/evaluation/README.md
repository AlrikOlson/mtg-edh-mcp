# Protocol workflow evaluation

Run `npm run test:workflows` after `npm ci`. The same suites run in `npm test`
and the existing Linux, macOS, and Windows CI matrix. They build a temporary
SQLite index and connect a real MCP SDK client to the production server using
`InMemoryTransport`. All enrichment providers are injected, ambient `fetch`
is forbidden, and every temporary session is closed and removed.

This measures scripted protocol correctness. The prompts describe tasks but
are not submitted to a model. It does not measure model tool selection,
deck quality, stdio/HTTP latency, or successful autonomous agent behavior.
The separate `npm run test:package` gate exercises the installed stdio server.

## Retained v0.2.0 baseline

[v0.2.0-baseline.json](v0.2.0-baseline.json) contains each request, full parsed
SDK result (including text fallback), observed latency, expected-error marker,
invariants, and metric totals. It was captured on 2026-09-08 against unchanged
production source from `d1c0efc8141071b3b5c5b4df779b8584799abbe6`, with SDK
1.29.0, negotiated protocol 2025-11-25, and Node 24.14.0 on macOS arm64.
The checkout was dirty because evaluation tooling and repository separation
were being added. Production source and lockfile digests identify the actual
inputs; runtime source and dependencies were unchanged at capture.

| Workflow                    | Tool calls | Invalid calls | Tool errors | Result bytes | Observed call time |
| --------------------------- | ---------: | ------------: | ----------: | -----------: | -----------------: |
| Budget and collection build |          9 |             0 |           0 |        8,701 |            4.06 ms |
| Import and tune             |         11 |             0 |           0 |        9,184 |            2.52 ms |
| Acquisition cost reduction  |         10 |             0 |           0 |        9,327 |            1.39 ms |
| Error recovery              |         16 |             1 |           2 |       13,807 |            1.76 ms |

The recovery errors are intentional: ambiguous commander input and a cold
EDHREC outage. The latter is a valid call to an unavailable service, not an
invalid input. No RPC calls failed. Partial input-batch failures are counted
separately and also count as invalid calls; the baseline has none.

Bytes are UTF-8 `JSON.stringify` bytes of parsed SDK results, including both
structured output and its text fallback, excluding JSON-RPC framing. Latency
is the sum of measured call times, excluding connection/index setup. These
small local timings are observations, not throughput claims or CI targets.
Model, token counts, and agent task success are explicitly `null` because
they are unobserved. Bytes are never presented as tokens.

## Fixture and correctness limits

`src/server/workflowScenarios.ts` owns workflow version 1, prompts, raw card
data, synthetic prices, and provider responses. Its exported fixture digest
is checked against the captured baseline. Changing it requires a new version
and an explicitly reviewed baseline, rather than silently changing inputs.

The scenarios verify legal 100-card counts, identity and singleton rules,
owned-only search, collection-aware acquisition totals, a full price including
the commander, explicit mutations, snapshot diffs, library export, unchanged
decks on failed calls, local fallback during an outage, and upstream retry.
The synthetic $100 deck costs $92.85 including the commander. The swap reduces
acquisition cost from $89.70 to $10.70.

The lists deliberately use many basic lands to test quantity contracts with
a small fixture. They are not recommended decks. Prices are fixed examples,
not current market quotes. In v0.2.0, `budget_plan` and `deck_export` cover the
99-card library, so the full-price invariant independently includes the
commander. Collections track membership, not inventory quantities; marking
a card owned treats all copies as acquired. No durability, concurrency, live
data freshness, or recommendation-quality claim follows from these tests.

## Replay and comparison

Ordinary replay reads the baseline and writes no trace. It verifies fixture
and prompt identity, domain invariants, text fallback and snapshot agreement,
and recomputes the stored metrics from the retained calls. Deterministic
ceilings are the actual recorded baseline values: no increase in tool calls,
invalid calls, partial failures, tool/RPC errors, or result bytes. Expected
recovery errors must still occur. No arbitrary percentage or timing threshold
is applied. Later contract changes that deliberately add useful evidence must
review any changed byte ceiling and preserve the original baseline.

To retain a new observation for review, choose a new output filename:

```sh
WORKFLOW_TRACE_OUT=/tmp/mtg-workflow-current.json npm run test:workflows
```

PowerShell:

```powershell
$env:WORKFLOW_TRACE_OUT = Join-Path $env:TEMP 'mtg-workflow-current.json'
npm run test:workflows
Remove-Item Env:WORKFLOW_TRACE_OUT
```

Capture refuses to overwrite an existing file. It still runs the baseline
comparison; a newly captured file is not automatic approval to relax a gate.
The original baseline was bootstrapped once with this output mechanism before
production changes, and remains a historical observation.

## Real host evaluation remains open

The parent v0.3 reliability release still requires model-driven runs through
at least two real MCP hosts. Neither host run was performed in this baseline
chunk. A future receipt must include the host name and exact version, model
identifier, server revision, negotiated protocol, fixture/data/price versions,
exact prompt, complete tool trace, final invariant results, elapsed time, and
token counts only when actually observed (label any estimates).

Record unavailable hosts and unsuccessful tasks explicitly. Run the same
tasks before and after reliability/advice changes, retain both traces, and
separate autonomous task success from these scripted protocol checks. The
[MCP architecture](https://modelcontextprotocol.io/docs/2026-07-28/learn/architecture)
distinguishes the host's model orchestration from the protocol, and the
[tool specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
distinguishes tool execution errors from protocol failures.
