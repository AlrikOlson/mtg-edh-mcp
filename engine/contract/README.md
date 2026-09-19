# Internal worker contract v6

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

Hello, capabilities, catalog_check, support_check, profile_preflight, admit,
run, decision and cancel succeed in this revision for the internal fixture
only. A decision frame is meaningful only while a run is suspended on the
request it answers (see protocol 6 below); otherwise it is `invalid`.
Unsupported does not mean admitted, completed or cancelled. There is no
fallback gameplay. `--self-check` remains an independent build probe, outside
protocol mode.

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
`face_relationship` labels the captured Scryfall layout, one value per layout
MCP maps (`single` for normal, `modal` for modal_dfc, and the layout's own
name for split, adventure, transform, meld, flip, prepare, leveler, class,
saga, case, prototype and mutate); `unknown` is a record without a layout and
`unsupported` a layout MCP does not map yet. The label classifies the face
inventory's source; it never asserts which faces are playable.

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

## Explicit profiles (protocol 4)

`Scenario` is now an adjacent tagged union. The `commander` arm contains the
unchanged four-seat `CommanderScenario`; every seat still requires commanders.
The `preview_fixture` arm contains `PreviewScenario`, which has exactly two
ordered seats (0 and 1), immutable fixture ID/version/digest, and no commander
or physical-card override fields. Missing/unknown tags and payloads belonging
to another profile reject during generated validation. This is an internal
six-card puzzle at two life after precommitted setup, not constructed deck
legality or a Commander game.

`catalog_check`, `catalog_checked` and `SupportCheck.catalog` now carry
`ProfileCatalog`: `commander` wraps the existing `CatalogEnvelope`, while
`preview_fixture` wraps `PreviewCatalogEnvelope`. Preview payloads have fixture
bindings and card quantities; they contain no authored deck, command zone,
companion or construction-format fields. Both paths reuse `VerifiedCatalog`
byte integrity, schema and record/reference validation. `catalog_check` proves
transfer integrity only; profile qualification remains a separate operation.

`profile_preflight` accepts a `Scenario`, `ProfileCatalog` and the expected
qualification implementation version/digest. Only the exact canonical preview
fixture qualifies. The worker checks captured fixture identity/version/digest,
source snapshot, index revision, every Oracle record/printing/quantity and the
core's exact-source support evidence. The scenario binds exact catalog bytes
through `snapshot_digest`, both seats through their `deck_digest` equal to
`fixture_digest`, the fixture's checked official rules digest, and engine
version. Profile mismatches, stale evidence and altered sources reject before
runtime objects are allocated. Commander preflight remains unavailable.

A `profile_preflighted` response contains fixture/catalog/scenario and core
implementation digests plus profile-scoped card reports. `qualified` refers
only to this fixed fixture's support obligations. Policy IDs, seeds and numeric
limits are retained and structurally bounded; this operation does not qualify
policies, promise trial completion, allocate game state or produce an admission
credential. All four execution capabilities remain false. A later executor
must honor the immutable setup and policy restrictions captured in the fixture;
it cannot extend this evidence to arbitrary inputs.

`PREVIEW_FIXTURE_ID`, `PREVIEW_FIXTURE_VERSION` and `PREVIEW_FIXTURE_DIGEST` are
generated for both languages from the authored contract. `sync.mjs` verifies
these values against the canonical core fixture's complete sorted-key JSON
digest; drift rejects instead of blessing changed evidence. Required
`SupportReport.profile` distinguishes `commander` from `internal_fixture_v1`.
Reports themselves are never accepted as a qualification input.

## Fixture admission and bounded runs (protocol 5)

`admit` now carries `Admission`: the `Scenario`, the `ProfileCatalog` it binds
through `snapshot_digest`, and the expected qualification implementation
version/digest. Admission reuses the exact `profile_preflight` binding, then
resolves each seat's named client and proves physical setup once through the
core's `setup::prepare_preview_game`. `admitted` returns a deterministic
`admission_id` derived from the scenario and catalog digests, both digests and
the `initial_state_hash` of that proof. Identical admissions are idempotent; a
worker retains at most eight distinct admissions (`invalid/admission_limit`).
Only `preview_fixture` scenarios are retained; a `commander` scenario goes
through the Commander admission owner described below. Unknown policy
identities, versions or observation versions answer `unsupported` per seat.
Stale rules, fixture, catalog, seat or implementation bindings answer
`invalid` with the same codes as preflight. Nothing is retained on rejection.

### Commander admission (schema unchanged)

A `commander` scenario is admitted through the canonical owners in order, and
the first refusal answers; nothing is allocated or retained on any of them.

1. Binding (`invalid`). `support_version_mismatch`, `catalog_invalid` and
   `profile_mismatch` as for the fixture. `commander_scenario_binding_mismatch`
   when `engine_version`, `rules_digest` (the engine's official rules snapshot),
   `snapshot_digest` (the catalog envelope's `payload_digest`), seat order or
   any seat's `deck_digest` (the same capture, so every seat plays the captured
   deck) does not bind. `commander_scenario_deck_mismatch` when a seat's
   `cards` are not exactly the captured deck's Oracle multiset (commanders and
   main deck; a companion is outside the game), when a `physical_id` repeats
   anywhere in the pod, or when a seat's `commanders` are not physical ids of
   its own cards with the captured commanders' Oracle identities.
2. Variants (`unsupported`, one diagnostic). `commander_variant_unsupported`
   for a `command_zone_kind` other than `single`, more than one commander or a
   meld commander (CR 903.3b); `companion_unsupported` for a captured
   companion. Construction legality is MCP's verdict and never implies these
   are executable.
3. Policies (`unsupported`, one diagnostic per seat), as for the fixture.
4. Qualification (`unsupported`). Every distinct Oracle identity of the deck
   is qualified through the core `cards::support` owner under the `commander`
   profile, exactly as `support_check` reports it; each refused identity is one
   `card_unsupported` diagnostic carrying `oracle_id`, in deck order, at most 256. A stale `expected_implementation_digest` is
   `invalid/support_version_mismatch`. Today the qualifier refuses every card,
   so a real capture stops here with its exact per-card diagnostics.
5. Setup blueprints. Each seat becomes the core's Commander seat blueprint:
   the commander apart in the command zone at 40 life (CR 903.6, 903.7), every
   other physical card in the library in declared order, no opening hand. Each
   blueprint carries the scenario's `physical_id`, and the core's setup owner
   keeps it in its physical inventory next to the allocated engine identity,
   so that inventory is the one correspondence between scenario cards and
   engine objects for diagnostics and replay; the core refuses a `physical_id`
   used twice before allocating anything, after the binding stage already did.
   Shuffling, opening hands and mulligans (CR 103.3, 103.5, 903.7) have no
   owner yet, so a fully qualified pod answers
   `unsupported/starting_procedure_unavailable` at exactly that point instead
   of being dealt by this adapter. `profile_preflight` still answers
   `invalid/commander_preflight_unavailable`: its report shape is bound to the
   fixture, and per-card `support_check` is the Commander preflight.

Named clients: `fixture-baseline@1` plays a land, casts the first legal spell,
otherwise passes, attacks with every legal attacker and never blocks;
`fixture-pass@1` passes every priority. Both declare `observation_version` `1`:
they read only the engine's enumerated legal options and never mutate state or
inspect hidden zones. `search_nodes` is retained as a declared ceiling; neither
client searches.

`Limits` gains `max_work`, the canonical work-unit budget. A `run` must name a
retained `admission_id`, its `scenario_digest`, a `trial_index` below
`limits.trials` and the derived trial seed: the first sixteen hex characters of
SHA-256 over `mtg-worker-trial-seed-v1`, the scenario seed and the big-endian
trial index. Any other seed is `invalid/trial_seed_mismatch`, so seeds are
independent of scheduling. The run executes on its own thread against a fresh
canonical setup for that seed; one `event/progress` per completed turn precedes
exactly one terminal `outcome`, all with the run's request ID.

Budgets map onto canonical execution control: `max_turns` pauses the live
scheduler at the turn boundary; `max_actions` and `max_work` are cumulative
counters; `max_actions_per_turn` is applied as a per-turn ceiling on the same
counter; `max_elapsed_ms` arms a watchdog that raises the cooperative stop
token; `max_output_bytes` refuses a progress event that would not leave room
for the outcome and raises the same token. `max_memory_bytes` and
`concurrency` are declared for the parent supervisor and not enforced here.
Outcomes are distinct: `completed` carries `winner_seats` (empty for a draw),
the rules `reason`, initial/final core hashes, `turns` and `actions`;
`truncated` names `turn_limit`, `action_limit`, `actions_per_turn_limit`,
`work_limit`, `elapsed_limit` or `output_limit`; `cancelled` follows a parent
cancel; `unsupported` reports semantics the run cannot continue through;
`engine_error` reports a canonical failure. A cap or failure is never a loss
or an implicit pass.

Runtime support is enforced by the core, not inferred by the worker. When the
canonical executor meets semantics it cannot carry out (an unrepresented
spell or ability effect, a trigger it cannot announce, a choice shape or cost
it cannot represent), the scheduler stops transactionally and the run answers
`unsupported` with one `runtime_semantics_unsupported` diagnostic: `physical_id`
and `oracle_id` are the setup inventory's identities of the object that
carries the behavior (both absent for a generated object such as a token, or
for an object outside the inventory; nothing is invented), `behavior_id` names
the behavior, and the message says which seat's card or which token it is. An
engine request none of the run's engine-side clients can answer is relayed to
the parent (protocol 6 below); when no parent can answer it, the run answers
`unsupported/resolution_choice_unsupported` with the same identities for the
resolving object and `behavior_id` `choice:<kind>` (`target`, `mode`, `order`,
`optional`, `objects`). Neither carries a winner, a completed reason or an
engine error; `engine_error/execution_error` is kept for rejected decisions
and internal failures. The worker never constructs a
card, a state or an identity itself: every object it runs is allocated by the
core's setup owner after exact-source qualification, and `--self-check`
initializes an empty two-seat core through that same owner.

A run thread that panics still reaches an outcome: the run answers
`engine_error/worker_panic` carrying the panic message, after the standard
panic hook has written the panic to stderr, and the session goes on to answer
what waited behind the run. The parent therefore never waits for its own
deadline on a crashed run. stderr carries nothing else in normal operation;
a transport failure (for example the parent closing the worker's stdout)
ends the process with exit code 1 and one `mtg-worker: protocol I/O failed:`
line on stderr, while framing failures (`malformed_frame`, `truncated_frame`,
`oversized_frame`) are answered on stdout without a request ID and the
process exits 0. The worker's selected dependency graph contains no GUI
toolkit, HTTP client, async runtime, TLS stack or sibling front end; the
engine is taken without its default features, and a test over
`cargo tree -p mtg-worker` enforces both.

Input is read on a dedicated thread. While a run is live, `cancel` naming the
run's request ID raises the stop token at once and is answered after the run's
outcome: `cancelled` when the stop was honored, `invalid/cancel_late` when the
run had already reached its outcome. Other requests wait behind the run in
arrival order (at most 64, then `invalid/backlog_limit`) and are answered
after it; a clean end of input still answers them, a framing failure discards
them. Progress events are acknowledged before the run continues, and queued
frames are handled before that acknowledgement, so output accounting and a
cancel delivered before an acknowledgement are deterministic. Hard timeouts,
memory limits and process termination remain the parent's responsibility.

## Relayed decisions (protocol 6)

The named client `parent-relay@1` (observation version `1`) makes no choice:
every decision of its seat is presented to the parent. An engine-side client
(`fixture-baseline@1`, `fixture-pass@1`) still answers its own priority
decisions, and a pending request it cannot answer (a resolution or ward
request, a command-zone offer, a waiting commander move) is presented the same
way. Combat declarations are not on the decision surface yet: a relay seat
attacks with every legal attacker and never blocks, exactly as the engine's
default declarations.

A presented decision suspends the run. The worker writes one
`event/decision` under the run's request ID, numbered in the run's event
sequence and charged against `max_output_bytes` like a progress event (a
request that would not leave room for the outcome stops the run as
`truncated/output_limit`). `DecisionRequest` carries an opaque `decision_id`,
the `seat`, the `kind` (`priority`, `resolution`, `commander_return`,
`commander_replacement`), the exact core `state_hash` the options were
enumerated in, an `observation_digest` (SHA-256 of the encoded `options`
array, exactly as sent), the resolving object's `physical_id` and `oracle_id`
with `behavior_id` `choice:<kind>` for a pending request, and one to 1,024
`options`. Each option is one legal action the canonical enumerator spelled:
an opaque `option_id`, its `kind` (`pass_priority`, `concede`, `play_land`,
`cast_spell`, `activate_ability`, `activate_mana_ability`, `special_action`,
`resolution_answer`), the setup inventory's identities of the card it names
(a land play names none: the engine chooses the land), and the engine's own
one-line `summary`. The parent never sees or supplies a declaration, a target
or a payment: it names an option, and the loop executes the action behind it
through the canonical decision surface, or rejects it as it would any client's.
A request with more legal options than the wire carries ends the run as
`unsupported/decision_options_limit`.

The parent answers with a `decision` frame naming the `decision_id`, `seat`
and `state_hash` it was asked with and an `answer`: `option` with the
`option_id`, or `decline`. The worker checks the frame against exactly the
suspended request and answers `decided` (echoing `option_id`, null for a
decline) once the answer is handed to the run. A frame that names no
suspended request, or a request already answered, is
`invalid/decision_unknown`; another seat is `invalid/decision_seat_mismatch`;
another `state_hash` is `invalid/decision_stale`; an `option_id` that was not
presented is `invalid/decision_option_unknown`. A rejection leaves the run
suspended and the answer still owed. A `decline` ends the run as
`unsupported/decision_declined` with the request's identities and
`behavior_id` (`decision:priority` when nothing was pending), never as a loss,
a pass or a cancellation. A `cancel` delivered while the run is suspended
wakes it at once and is answered `cancelled` after the run's outcome, as for
any checkpoint; the elapsed budget interrupts a suspended wait the same way.
Decision frames are handled as they arrive, like `cancel`; every other
request still waits behind the run.
