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
ceilings for tool calls, invalid calls, partial failures, and tool/RPC errors
remain the actual v0.2.0 observations. Expected recovery errors must still
occur. Result-byte ceilings use the reviewed recommendation observation below; no
arbitrary multiplier or timing threshold is applied. All retained traces have
the same fixture, prompts, and domain invariants, and their metrics are
recomputed during replay.

### Contextual recommendation observation

[contextual-recommendations-v1.json](contextual-recommendations-v1.json) retains the
2026-09-09 scripted observation for the contextual recommendation implementation,
with SDK 2.0.0, Node 24.14.0, and source/lockfile digests from the dirty checkout.
All earlier captures remain unchanged. Fixture version, fixture hash, prompts,
domain invariants, call counts and error counts match the earlier observations.

| Workflow                    | Whole-deck result bytes | Recommendation result bytes | Change |
| --------------------------- | ----------------------: | --------------------------: | -----: |
| Budget and collection build |                  20,635 |                      20,635 |      0 |
| Import and tune             |                  17,133 |                      17,133 |      0 |
| Acquisition cost reduction  |                  32,651 |                      32,651 |      0 |
| Error recovery              |                  16,587 |                      18,379 | +1,792 |

Review of every parsed call result found exactly one changed response: the
successful `meta_recommend` retry grows from 3,497 to 5,289 bytes. It retains the
same suggestion and prior fields, and adds deck version, prospective constraint
findings, typed provider metrics with their scales and source freshness, exclusions,
and the one-card-addition scope. The increase includes required JSON text fallback.
These exact observed totals are the new byte ceilings, with no added margin;
original behavior ceilings remain in force.

The two recovery requests now explicitly select `rank: "synergy"` to retain their
original EDHREC outage/retry behavior. Omitted rank now selects local contextual
recommendations, which is exercised by the separate recommendation tool tests.
This retained recovery trace measures the compatible provider path and its richer
metadata; it does not measure the contextual default's quality, model behavior,
token use, or live provider reliability.

### Whole-deck budget observation

[whole-deck-budget-v2.json](whole-deck-budget-v2.json) records the complete-deck
pricing correction with SDK 2.0.0 and Node 24.14.0 on macOS arm64. It preserves
the version-1 workflow fixture, prompts and all original behavior limits.
Original v0.2.0, advice and host captures are unchanged. The new trace carries
source/lockfile digests and dirty-checkout provenance; it is a scripted SDK
observation, not a model-host rerun.

| Workflow                    | Advice result bytes | Whole-deck result bytes |
| --------------------------- | ------------------: | ----------------------: |
| Budget and collection build |               8,701 |                  20,635 |
| Import and tune             |               9,184 |                  17,133 |
| Acquisition cost reduction  |               9,327 |                  32,651 |
| Error recovery              |              16,587 |                  16,587 |

The added bytes are explicit library/command-zone/whole-deck/companion totals,
per-field price coverage, unresolved quantities, timestamp and freshness evidence,
integer cents, and membership acquisition assumptions, plus required JSON text
fallback. Zone summaries omit recommendation lists; general statistics omit them
entirely. This observation supplied the whole-deck byte ceilings, subsequently
extended only for the recommendation response documented above; call counts,
invalid calls and errors still use the original limits.

The budget fixture now directly reports full value $92.85 and membership-based
new spending $12.35, including its $2.50 commander. Acquisition reduction reports
full spending $92.20 to $13.20; the old top-level library figures remain unchanged.
The new `src/evaluation/wholeDeckBudget.test.ts` also checks all 22 frozen
Commander corpus cases against independent authored price arithmetic, including
the intentionally unpriced case. The frozen baseline adapter and historical
failure receipts retain their original library-field comparison; they are not
rewritten as successful whole-deck observations. Quantity-aware acquisition
remains a separate capability: membership still covers every copy.

### Advice observation

[v0.3.0-advice.json](v0.3.0-advice.json) was captured on 2026-09-08 with SDK
2.0.0, protocol 2025-11-25, and Node 24.14.0 on macOS arm64. The package still
reports 0.2.0 because release versioning belongs to final release acceptance.
Its dirty-checkout flag and production source digest identify the implementation
before this iteration's commit. The original v0.2.0 baseline is unchanged.

| Workflow                    | Original result bytes | Advice result bytes | Change |
| --------------------------- | --------------------: | ------------------: | -----: |
| Budget and collection build |                 8,701 |               8,701 |      0 |
| Import and tune             |                 9,184 |               9,184 |      0 |
| Acquisition cost reduction  |                 9,327 |               9,327 |      0 |
| Error recovery              |                13,807 |              16,587 | +2,780 |

The added bytes carry recommendation rationale, role/synergy evidence,
tradeoffs, uncertainty, price scope, and source freshness, including JSON text
fallback. All tool-call and error counts remain unchanged. Default role
provenance is omitted when there are no corrections, preserving the other
workflow payloads. These are scripted response sizes, not token measurements
or evidence of improved model-driven deck choices.

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

## Real host comparison

Actual model-driven runs were captured on 2026-09-08 through **Claude Code
2.1.263**, selecting `claude-fable-5`, and **Codex CLI 0.153.4**, selecting
`gpt-6-astra`. Claude reports its model in the init event. Codex's requested
model is recorded separately from `observed_model: null` because its JSONL
stream does not report a resolved model revision. MCP request metadata also
records the selected model. Claude negotiated 2025-11-25; Codex negotiated
2025-06-18. Neither observation is a claim that those hosts used 2026-07-28;
dedicated SDK tests exercise that revision.

Each host completed all four tasks on the baseline and initial current source.
The model chose its own calls over real stdio. The original workflow prompts
are retained verbatim and supplemented with identical explicit fixture inputs:
the initial imported list, collection, requested evidence, and deliberate
recovery triggers. These supplemental instructions are in each `prompt.txt`.
They make the synthetic task self-contained; they are not an unseen sequence
of scripted tool calls.

Baseline runs use checkout `18dff7a`, whose production implementation is the
unchanged v0.2.0 source from `d1c0efc`, with SDK 1.29.0. The evaluation-only
adapter is compiled against that source and its installed lockfile. Initial
current runs use `47aeb63` plus the recorded dirty checkout and SDK 2.0.0.
They were captured before the package version changed from 0.2.0 to the 0.3.0
candidate. Every receipt retains exact bundled input, adapter, runner, bundle
and lockfile hashes; the current checkout's Git commit alone is insufficient
to identify a capture.

| Host   | Workflow              | Baseline calls / invalid | Initial current calls / invalid | Baseline → current result bytes |
| ------ | --------------------- | -----------------------: | ------------------------------: | ------------------------------: |
| Claude | Budget build          |                   12 / 1 |                           9 / 0 |                  16,401 → 8,174 |
| Claude | Import and tune       |                   12 / 1 |                          13 / 1 |                   8,746 → 9,026 |
| Claude | Acquisition reduction |                   11 / 0 |                          12 / 1 |                 10,420 → 11,132 |
| Claude | Error recovery        |                   12 / 2 |                          12 / 3 |                  9,683 → 13,489 |
| Codex  | Budget build          |                    9 / 0 |                           8 / 0 |                 12,177 → 10,980 |
| Codex  | Import and tune       |                   11 / 1 |                          11 / 1 |                   8,404 → 8,404 |
| Codex  | Acquisition reduction |                   15 / 1 |                          15 / 1 |                 13,560 → 14,294 |
| Codex  | Error recovery        |                    9 / 1 |                           9 / 1 |                  7,341 → 10,121 |

Task completion means independent checks passed against actual deck/collection
stores and the observed calls. It does not mean every call succeeded. The
recovery ambiguity and cold upstream outage are deliberate. Initial Claude
recovery also had one partial input-batch failure, which is counted as invalid.
No official comparison run had an unanswered tool call or JSON-RPC error.
The initial traces exposed a repeatable product mismatch: both hosts use
`ci<=r`, as the server's own examples suggest, but the parser rejects it.
The parser now accepts `ci` as the same color-identity field as `id` and
`identity`; nine regression cases failed before the fix and passed afterward.
The final 0.3.0 candidate observation uses the same prompts, models and grading.
All eight tasks passed again. The five unexpected query errors in the initial
current runs fell to zero; the final runs had no partial failures, unanswered
calls or RPC errors. Only the two deliberate recovery errors per host remain,
including one invalid ambiguous-name call.

| Host   | Workflow              | Final calls / invalid | Final result bytes |
| ------ | --------------------- | --------------------: | -----------------: |
| Claude | Budget build          |                10 / 0 |              8,417 |
| Claude | Import and tune       |                10 / 0 |              7,453 |
| Claude | Acquisition reduction |                13 / 0 |             11,087 |
| Claude | Error recovery        |                11 / 1 |             10,923 |
| Codex  | Budget build          |                 8 / 0 |             10,980 |
| Codex  | Import and tune       |                10 / 0 |              7,623 |
| Codex  | Acquisition reduction |                14 / 0 |             12,779 |
| Codex  | Error recovery        |                 9 / 1 |             10,121 |

Offline receipt tests independently replay all 24 completed tasks across the
three observations, recompute grades and metrics, and check prompt/fixture
identity and provenance. Accepted receipts must remain successful; the separate
failed environment attempts remain failures. After capture, review tightened
the grader to bind evidence to the requested final deck (including import's
create-new response). All 24 retained traces regrade identically. Original
adapter/grader hashes remain unchanged in the historical receipts.

Retained receipts link to complete per-task prompts, MCP JSONL, host JSONL,
stderr, final state and independent grading:

- Baseline: [Claude](hosts/baseline-claude-node24/receipt.json),
  [Codex](hosts/baseline-codex-node24/receipt.json).
- Initial current: [Claude](hosts/current-claude/receipt.json),
  [Codex](hosts/current-codex/receipt.json).
- Final candidate: [Claude](hosts/final-claude/receipt.json),
  [Codex](hosts/final-codex/receipt.json).
- Scripted integration observation:
  [v0.3.0-integration.json](v0.3.0-integration.json). Its deterministic call/error
  counts and result sizes match the reviewed advice observation.

Four Claude captures used the authenticated account email as a generated deck
name, although the fixture supplied no email. Before commit, that identifier
was replaced consistently by an ASCII placeholder of the same UTF-8 length
in the host/MCP/state files for baseline acquisition/recovery, initial import,
and final budget build (12 files). These are redacted traces. The replacement
preserves response-byte counts; replay confirms all grades, call/error metrics
and observed token counters are unchanged. Prompts and source/provenance hashes
are untouched.

Each receipt reports wall time and summed tool time separately. Token usage is
the actual host report, preserving each provider's input/cache/output fields.
Claude's cache-read and cache-creation counters must not be omitted when
interpreting its small plain-input counter; Codex's cached-input counter is
part of its reported total input. These totals include repeated context, not
unique prompt tokens. This is one observation per host/task/revision, with
shared caches and concurrent runs: timing, tokens and call-count differences
are observations, not statistically established improvements or CI targets.

### Reproduce a real-host observation

Install and authenticate the chosen host separately. The runner uses that
existing account; it never logs in or changes host settings. On a POSIX host:

```sh
node scripts/evaluate-hosts.mjs --host claude --model claude-fable-5 --out /tmp/mtg-claude-new
node scripts/evaluate-hosts.mjs --host codex --model gpt-6-astra --out /tmp/mtg-codex-new
```

The output directory must not exist. `--scenario budget-build` runs one task.
`--source-root /path/to/comparison-checkout` selects another implementation
with its own installed dependencies. Use the **same absolute Node executable**
to install/rebuild its native SQLite addon and run the evaluator. The runner
checks that exact runtime before making a model request.

The adapter forbids ambient network access, supplies only synthetic providers,
and keeps user state separate from real `MCP_DATA_DIR`. Only the `mtg` server
is configured; shell/browser/plugins/delegation are disabled for host tasks.
The host capture runner currently supports POSIX process-group cleanup.
Windows **server** acceptance remains in CI; Windows model-host capture is
explicitly unsupported. Models and their accounts are never invoked by
`npm test` or CI. CI replays retained evidence and the independent deterministic
protocol suite without model access.

### Failed environment attempts

[Initial Claude](hosts/baseline-claude/receipt.json) and
[initial Codex](hosts/baseline-codex/receipt.json) baseline attempts all failed
before tool execution. The comparison checkout installed SQLite under Node
26 while the evaluator used Node 24. A pinned-Node-24 rebuild fixed the ABI
mismatch; the `-node24` directories are separate successful retries. The
runner gained only a native-runtime preflight between current and corrected
baseline captures, so their runner hashes differ; prompts, grading and model
configuration did not change. These failed attempts remain failures.

The synthetic many-basic-land fixture proves workflow contracts, not deck
strategy. HTTP/stdio initialization, durability, crashes, backups and recovery
have separate production tests and installed-package/Rust gates. Current-revision
Linux/macOS/Windows CI is a separate final release gate. Publication is not part
of this evaluation.
