# Internal worker contract v2

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
at most 2,097,152 bytes, excluding LF; CR before LF is JSON whitespace and counts
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

Hello, capabilities and catalog_check succeed in this revision. Admission, run, decision
and cancel requests validate fully and then return `unsupported`, with their
original request IDs. Capabilities advertise all four as false. Unsupported
does not mean admitted, completed or cancelled. There is no fallback gameplay.
`--self-check` remains an independent build probe, outside protocol mode.

Version 2 rejects unknown fields, variants and wrong payload types. Optional
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
Physical catalog integration, runtime admission, execution, process
supervision/cancellation and replay belong to their later engine MVP chunks.
No public simulation route is changed here. The TypeScript gameplay/payment
inventory in MCP's engine-source ADR remains frozen until atomic cutover.

Primary references: [Serde strict containers](https://serde.rs/container-attrs.html),
[Serde tagged enums](https://serde.rs/enum-representations.html),
[Node child processes](https://nodejs.org/api/child_process.html).

## Immutable catalog transfer

Version 2 adds `catalog_check` and `catalog_checked`, not admission to play.
The generated `CatalogPayload` preserves MCP `CardGameplay` fields, including
ordered face/source identifiers, nullable values, raw text and supplied color
identity. Printing IDs are separate from Oracle IDs. A selected printing is
nullable; no printing or face is selected by name, price or mana cost.

`CatalogEnvelope.payload_json` contains a UTF-8 JSON document bounded to
1,048,576 bytes. `payload_digest` is SHA-256 of those exact decoded string
bytes (not the outer frame's JSON spelling). Worker verification checks the
digest before parsing, then the generated shape, expected index/deck/version,
source identities, printing ownership, face indices/paths, resolved references
and the operational 1,000-copy limit. A successful response returns that same
string unchanged. No files, URIs, card names or prices are resolved.
The private `VerifiedCatalog` shares read-only data through Arc and allocates
no game state. Its digest is integrity evidence, not authentication or a
construction/support verdict. MCP's trusted capture establishes provenance.

Required nullable fields must be present; only explicit null represents
unknown data. Rust uses a required deserializer rather than Serde's implicit
missing Option default. Catalog strings permit well-formed Unicode, with UTF-8
byte bounds; lone surrogate escapes reject. Mana value is finite and between
0 and 1,000,000, preserving fractions. JSON duplicate keys use the last value
on both sides. Integer fields retain the v1 numeric-spelling equivalence.
Source nulls are preserved; null faces/identity do not imply usable runtime
support. Future strict support admission must reject insufficient evidence.

`catalog-fixture.json` is a synthetic boundary fixture, not a playable or legal
deck. MCP acceptance additionally transfers all 77 frozen real corpus records.
Primary data references: [Scryfall card fields](https://github.com/scryfall/api-types/blob/main/src/objects/Card/CardFields.ts),
[Scryfall faces](https://github.com/scryfall/api-types/blob/main/src/objects/Card/CardFace.ts),
[Serde field attributes](https://serde.rs/field-attrs.html).


## Source support preflight (protocol 3)

`support_check` receives a verified catalog envelope, one Oracle ID from that
capture, expected implementation version `core-support-v1` and a nullable
expected implementation digest. It returns generated `support_checked` data.
A non-null digest pins the exact qualifier implementation; a stale version or
digest rejects. Query every required identity for a complete deck report.
This operation grants no admission ID and starts no trial. All four gameplay
capabilities remain false, including after a report.

The core `cards::support` registry is the sole qualification owner. It hashes
complete unlowered source using sorted JSON keys (integral u32-valued numbers
normalized), and separately hashes Oracle text and each ordered face. Exact
printing metadata is conservatively bound too: a reprint needs requalification,
even if its rules are unchanged. No name/keyword/partial-hook inference occurs.
Expected scenarios and owner chunks are obligations, never passing evidence.

The generated registry preserves the digest-pinned 77-card benchmark inventory,
all Oracle paragraph spans (UTF-16), shared requirements and seven generated
families. Runtime source dimensions and clauses receive exact paths. Three
basic-land intrinsic mana clauses have independent core evidence; every whole
card is currently unsupported because shared rules and the physical adapter
are unqualified. Missing generated definitions remain explicit. Source drift
clears clause evidence and expected-scenario applicability.

The report binds source, registry, baseline, implementation version and qualified
implementation bytes. Reproduce registry drift checking with
`node crates/mtg-engine/support/generate.mjs <MCP-corpus-v1.json> --check`.
The build-time generator rejects any changed frozen corpus. No catalog or
evidence file is loaded at runtime; imported text is never executable.
Reports are capped at 2048 requirements per card with a typed
`support_report_limit` failure rather than silent truncation.

The authoring factory remains available to existing CLI/desktop clients, but
`classify_card` can no longer claim complete support from a lowered Card.
The worker never calls the permissive factory or another construction validator.
Strict physical setup and unexpected-semantics abort remain mandatory in native
`engine-mvp-support-runtime`, blocking `engine-mvp-worker`; full corpus
qualification remains `engine-mvp-corpus`.

