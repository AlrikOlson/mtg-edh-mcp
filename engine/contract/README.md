# Internal worker contract v1

This package is the sole owner of the authored wire contract:
`crates/mtg-worker/protocol/contract.json`. It uses a finite typed-source DSL,
not general JSON Schema. `generate.mjs` rejects unknown vocabulary and generates
Rust Serde DTOs plus recursive validators and TypeScript Zod schemas/inferred
types. Generated artifacts are never authored independently.

From the canonical repository root:

```sh
node crates/mtg-worker/protocol/sync.mjs --write
node --test crates/mtg-worker/protocol/generate.test.mjs
node crates/mtg-worker/protocol/sync.mjs --check
cargo test --locked -p mtg-worker
cargo clippy --locked -p mtg-worker --all-targets -- -D warnings -D clippy::pedantic
```

CI checks drift and exercises the real worker. Rustfmt skips only the exact
generated module; generator output remains covered by compilation and strict
Clippy. Runtime dependencies reuse workspace Serde and the canonical core.

## Wire and compatibility

Run `mtg-worker --protocol` with explicit arguments. stdin/stdout carry UTF-8
JSON objects followed by LF. stderr is for process/I/O diagnostics. Each body is
at most 65,536 bytes, excluding LF; CR before LF is JSON whitespace and counts
toward the body limit. No BOM is accepted. An empty stream closes cleanly;
nonempty EOF before LF is `invalid/truncated_frame`. An oversized body emits
`invalid/oversized_frame` and terminates immediately, without interpreting any
suffix. Bounded reads retain at most the limit plus one byte.

Request shape: `{request_id, message: {type, data}}`. Response shape:
`{request_id?, message: {type, data}}`. The first valid request must be
`hello`, containing exact `protocol_version`, `engine_version` and
`schema_sha256` constants generated from the source bytes. A mismatch emits
`invalid/incompatible_version` with the request ID and closes the channel.
A second hello emits `invalid/duplicate_hello` and closes it. A non-hello first
request emits `invalid/handshake_required` and closes it. Malformed frames emit
`invalid/malformed_frame` without a guessed request ID and permit the next
delimited frame. The TypeScript response decoder treats malformed worker output
as terminal; a worker producing invalid output is not compatible.

Only hello and capabilities succeed in this revision. Admission, run, decision
and cancel requests validate fully and then return `unsupported`, with their
original request IDs. Capabilities advertise all four as false. Unsupported
does not mean admitted, completed or cancelled. There is no fallback gameplay.
`--self-check` remains an independent build probe, outside protocol mode.

Version 1 rejects unknown fields, variants and wrong payload types. Optional
fields accept omission or null; Rust reserialization omits absent/null fields.
Round trips preserve meaning under that equivalence. IDs use 1–128 ASCII bytes
from letters, digits, underscore, period, colon and hyphen. Diagnostic text is
1–1024 printable ASCII bytes (human localization belongs to presentation).
Seeds are 16 lowercase hexadecimal characters and digests are 64. Counters
are u32-bounded JSON integers; integral spellings such as `1.0` and `1e0` and
signed zero normalize to integers in both languages. Duplicate JSON object keys
use the last value, consistently with JSON.parse/serde_json::Value. Generated
Rust aliases alone are not validation: all incoming messages must use
`parse_request`/`parse_response`; outgoing responses use `encode_response`.

Breaking shape or meaning changes require a protocol bump and regenerated
bindings/fixtures. Even additive changes require coordinating both consumers:
exact schema digest negotiation intentionally rejects mixed artifacts. The
engine package version is not source provenance; the MCP source commit/lock pin
and eventual binary checksum independently identify the build.

## Ownership and scope

The protocol is private between MCP and its pinned worker. Existing public MCP
tool schemas retain their separate compatibility contract. Rust alone owns
game state, legal actions, payments, decisions and events. Wire objects carry
opaque IDs, hashes, finite choices, progress and outcomes, never a second
TypeScript state model. Scenario fields capture deck/snapshot/rules digests,
physical identities, seats, policy/observation versions, seeds and limits.
MCP remains the deck/catalog/construction authority. Structural acceptance does
not certify a legal deck, unique physical IDs, valid decision or supported
Oracle text. Those checks belong to existing owners in downstream admission.

The current observation digest and option IDs reference future retained engine
evidence; they do not yet deliver policy observations or enable interactive play.
Catalog payload transfer, admission ownership, runtime execution, process
supervision/cancellation and replay belong to their later engine MVP chunks.
No public simulation route is changed here. The TypeScript gameplay/payment
inventory in MCP's engine-source ADR remains frozen until atomic cutover.

Primary references: [Serde strict containers](https://serde.rs/container-attrs.html),
[Serde tagged enums](https://serde.rs/enum-representations.html),
[Node child processes](https://nodejs.org/api/child_process.html).

