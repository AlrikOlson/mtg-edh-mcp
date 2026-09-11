# ADR: exact canonical core state

Accepted for `engine-mvp-state`; follows the [engine charter](../ENGINE-CHARTER.md) and [source delivery decision](engine-source.md). The native roadmap owns execution status.

## Ownership and reuse

The existing Rust core owns the state format, random streams, zone identities, pending triggers and hashes. CLI, desktop and headless worker consume the same crate. MCP advances its immutable source pin without adding a state machine, random implementation or rule parser. Public TypeScript simulation stays frozen until `engine-mvp-cutover` removes overlapping behavior and switches consumers atomically.

The implementation reuses `GameRng`, `ZoneManager`, `EventBus`, derived serde state and the existing SHA-256 dependency. It replaces seed-only RNG restoration and removes skipped pending-trigger/event fields. Zobrist remains a partial search hash, never exact snapshot evidence.

## Representation and compatibility

`snapshot::canonical_core_bytes` emits a version-1 envelope containing every serialized `GameState` field. Compact UTF-8 JSON has recursively sorted object keys. Only the two unordered CardId sets (loyalty-used and tapped) are sorted as arrays. Every other array retains its order, including library, stack, targets, players, combat ordering and trigger queues. This is an engine-owned encoding, not RFC 8785. Schema or canonicalization changes require a version bump and an explicit migration.

`core_state_hash` computes lowercase SHA-256 over those versioned bytes. `restore_core_state` requires a separately retained matching digest, rejects unsupported versions before decoding current state, then requires identical canonical re-encoding. This rejects ignored nested fields, defaults, duplicate entries and encodings that would silently lose information. The digest detects corruption; it is not authentication or a gameplay-validity verdict. Callers must bound inputs before this internal API.

`GameRng` version 1 stores algorithm `chacha8`, the actual 32-byte key, stream, decimal word cursor and optional original seed as provenance. Seeded and entropy-created generators continue exactly. The decimal cursor retains all 68 bits through JSON values; invalid, out-of-range and noncanonical cursors are rejected rather than truncated. Old scalar/null seed snapshots are incompatible: a missing cursor cannot be reconstructed faithfully.

Zone managers derive a reserved `objectid` stream from the game RNG key and serialize its current cursor. Additions, moves, removal/re-addition and forks allocate matching UUID-shaped identities without consuming gameplay randomness. Physical CardIds and owners are retained. Pending triggers preserve cause, last-known information and order; the event window survives until the existing drain consumes it.

## Scope and migration limits

Core snapshots do not resume the synchronous `GameLoop`. Live priority/pass state, pending decisions, policy state, counters and transcript continuation remain `engine-mvp-runtime-checkpoint`. Transactional failures and execution budgets remain `engine-mvp-execution-control`.

Future stack objects and runtime-created card/player IDs still use their existing allocators. Their deterministic continuation is explicitly recorded in the runtime checkpoint backlog, coordinated with `engine-mvp-catalog-objects`. This unit preserves existing stack objects/targets and deterministic future zone identities. It does not claim arbitrary uninterrupted-versus-resumed games.

No worker protocol or public MCP simulation capability changes. Complete Commander support, packaged replay/resume and release qualification remain downstream.

## Verification

Independent regressions cover mixed RNG reads/shuffles across buffer boundaries, seeded/entropy state, nonzero streams and 68-bit limits, corrupt payloads, independent streams, zone moves/removals/forks, pending triggers with LKI and APNAP ordering, event draining, populated counters/combat/effects, hashes, sequence ordering, threaded serialization and strict restoration.

Source-first delivery requires Rust formatting, strict Clippy, core/worker tests and doctests, consumer compilation, a canonical commit, clean-clone provenance checks/build, native worker protocol acceptance and recorded MCP gates. Native records retain actual outcomes. The original engine checkout and pre-existing MCP instruction edits are preserved. Desktop GUI verification and installed runtime acceptance are outside this core change.

Primary references: [rand 0.9 ChaCha state](https://raw.githubusercontent.com/rust-random/rand/0.9.0/rand_chacha/src/chacha.rs), [serde JSON sorting](https://docs.rs/serde_json/1.0.149/serde_json/enum.Value.html#method.sort_all_objects), [Serde attributes](https://serde.rs/attributes.html), [UUID from random bytes](https://docs.rs/uuid/1.22.0/uuid/struct.Builder.html#method.from_random_bytes).
