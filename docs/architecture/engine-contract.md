# ADR: generated internal worker contract

Accepted 2026-09-09 for `engine-mvp-contract`; follows the [engine charter](../ENGINE-CHARTER.md)
and [canonical source decision](engine-source.md).

## Ownership and compatibility

The authored contract is `crates/mtg-worker/protocol/contract.json` in the canonical
mtg-game-engine repository. A finite, rejecting generator emits Rust Serde types
with recursive validators and TypeScript Zod schemas with inferred types.
The [protocol reference](../../engine/contract/README.md) is an exact imported copy
of its canonical documentation. It defines framing, handshake, diagnostics,
optional/null semantics, scalar limits and version changes.

Existing public MCP tools and their schemas remain the stable user-facing
interface. This internal channel is separately versioned and requires an exact
protocol version, engine version and schema SHA-256 handshake. Its new adapter
is not exported by the public MCP entrypoints. No existing tool changes shape
or behavior in this delivery.

The current worker supports handshake, capabilities and internal catalog integrity checks
(see [catalog transfer](engine-catalog.md)). Admission, run,
decision and cancellation messages decode and return typed `unsupported`;
all four capability flags are false. Events and terminal outcomes have validated
wire representations, but declaring a representation does not implement a game,
cancel a trial, provide observations or prove card support.

MCP retains Oracle snapshots, authored decks, collection, pricing and construction
legality. Rust retains gameplay state, object ownership, legal choices, payments
and execution. The wire references engine decisions/options and state/observation
hashes rather than recreating game state in TypeScript. Physical-card and seat
fields express immutable inputs; admission must verify identity/ownership through
the designated owners, not infer legality from successful decoding.

## Reproduction and drift

The original contract revision was `3893b490299f4bdfdda3c5df8a8a6b2a4d5abf7e`.
The [source pin](../../engine/source.json) now includes the catalog transfer
revision documented in [engine-catalog](engine-catalog.md).
The canonical worktree was isolated from the original engine checkout. This
revision also repairs an existing strict-Clippy warning in the CLI test
temporary-directory helper without changing its behavior.

After obtaining a clean checkout at that pin using the source ADR procedure:

```sh
node scripts/engine-contract.mjs --sync build/engine-clean
node scripts/engine-contract.mjs --check build/engine-clean
npm test
```

Sync verifies the source revision, clean Git state and lock digest first. It
imports only fixed contract paths. The manifest records their exact hashes and
source revision. Ordinary `npm test` checks those hashes, regenerates both
bindings in memory and rejects drift, and runs generator rejection tests.
Canonical CI independently checks the Rust/TypeScript generated files and real
worker tests. No Cargo or canonical checkout is required for MCP's ordinary
contract drift check. The imported source and generated files are derivatives:
edit the canonical owner, commit it, advance the pin, then sync.

For local cross-language acceptance, build the pinned worker outside its checkout
and pass its absolute executable path through `MTG_WORKER_BINARY`:

```sh
MTG_WORKER_BINARY=/absolute/path/to/mtg-worker npm test -- src/engine
```

The original three native acceptance tests are explicitly skipped when the variable is
absent. They were run against the real macOS arm64 worker in this iteration.
Shared fixtures exercise 59 independently specified valid/invalid messages in
both languages; raw fixtures cover alternate JSON integer spellings. Separate
tests cover exact/oversized frames, truncated EOF, fragmented/coalesced input,
unknown fields/variants, version rejection, correlation, nulls and protocol-only
stdout. Rust serialization normalizes optional nulls to omitted fields.

## Reuse review and remaining scope

No legacy gameplay implementation was extended or replaced. The production
overlap inventory and removal milestones in the source ADR still apply:
`manaModel.ts`, `manaSequence.ts`, `sim.ts` and indirect public consumers remain
frozen until `engine-mvp-cutover`, when routes switch and overlapping execution
is deleted atomically. No unsupported/error path falls back to TypeScript.

Physical catalog setup/admission, executable decisions and observations, multiplayer,
supervision, cancellation races, durable jobs, replay, packaging and performance
qualification remain downstream acceptance. This contract neither claims
Commander simulation support nor changes the local-release gates. The installed
package does not yet contain a worker executable. No publication or remote push
is part of this delivery.
