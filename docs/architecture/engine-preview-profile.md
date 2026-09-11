# Internal fixture qualification

This receipt follows the [engine charter](../ENGINE-CHARTER.md). Native chunk `engine-mvp-preview-profile` and think:334 record scope. The [source pin](../../engine/source.json) identifies the complete canonical implementation.

## Exact scope

The immutable [fixture](../../engine/contract/preview-fixture.json), `forest-bears-internal-v1`, has two seats. Each owns three Forests and three Grizzly Bears, starts at two life with two Forests and one Bears in hand, and has the top-first library Forest, Bears, Bears. Seat zero starts the first precombat main after a precommitted keep. There are no shuffle, mulligan, commander, companion, sideboard or user-selected deck inputs.

This is an internal scenario, not a legal Constructed or Commander deck. Six owned objects per seat make hand overflow unreachable. Combat uses the existing deterministic legal damage assignment policy stated in the fixture; this does not qualify every possible damage distribution or arbitrary policy. The exact four-seat, 400-object Muldrotha release benchmark is unchanged.

Fixture digest: `7692ad4aa8565a65754eedad937af1908afcbd20b5a940a62f9b8e43051042e4`. The generated contract pins ID/version/digest and its canonical generator checks these against the whole sorted-key fixture, including setup and provenance. Oracle text and face digests are separately exposed by core support reports.

Forest is the unchanged frozen baseline source. Grizzly Bears was captured through the existing MCP `mapScryfallCard` authority, from [the pinned Scryfall printing](https://api.scryfall.com/cards/409f9b88-f03e-40b6-9883-68c14c37c0de). Raw Scryfall SHA-256 is `06f082a11ab0496c860bfd984e96a3533d72197a392952394933884a57eddaf1`. The [official rules snapshot](https://media.wizards.com/2026/downloads/MagicCompRules%2020260819.txt), effective August 7, 2026, has SHA-256 `4381ad1b39ab2c05f7d03633a20f711ed37277074d3266dcba5f38cbb527423f`. Both raw sources are retained in the canonical commit under `crates/mtg-engine/src/cards/support/preview_sources/`.

## Ownership and admission boundary

Core `cards::support` owns requirement applicability. Its existing Commander assessment retains every frozen obligation. The internal profile qualifies only independently anchored exact Forest/Bears source. Changed clauses, faces, characteristics or borrowed identities lose support. The qualified card builder recomputes this assessment and uses the existing definition/factory; it accepts no caller report.

MCP `capturePreviewFixture()` takes no inputs, reads a fixed checked artifact, validates its complete digest against generated constants, and returns frozen generated transfer data. Authored capture continues through `CardIndex`, `DeckStore`, the paired snapshot provider and the existing `validateDeck` composition. A fixture ID or hash cannot bypass that construction gate.

Protocol 4 uses explicit adjacent-tagged `Scenario` and `ProfileCatalog` variants. Commander retains four seats and required commanders; preview has two seats and no authored deck or commander fields. Both reuse `VerifiedCatalog` byte/identity/face/reference checks. Missing and unknown tags reject.

`profile_preflight` verifies the exact quantity/source/printing inventory, fixture/index/snapshot binding, official rules digest, ordered seats, engine version and core qualification. Its report grants no admission credential and allocates no runtime state. Policies and numeric limits are structurally validated, not qualified for execution. All four gameplay capabilities remain false. Future setup/execution must honor this whole boundary; card-level evidence alone cannot authorize arbitrary scenarios.

The selected-file implementation digest identifies qualification code and named behavioral owners/tests. Complete engine revision, lock digest, generated protocol digest and immutable fixture remain necessary provenance; that digest alone is not a transitive source-tree fingerprint.

The shared `GameState::TurnsMut::advance_step` now empties every player's mana at a real step boundary, as required by CR 106.4. The redundant cleanup-only expiry was removed. Pausing within a step preserves mana. Existing test setups that injected mana before advancing steps now use legal sources or inject after the transition. No second rules implementation was introduced.

Legacy TypeScript gameplay/payment/sequencing remains frozen until `engine-mvp-cutover` switches routes and deletes overlapping production code atomically. Preview adds no public MCP route or fallback. Deterministic physical setup, execution, supervision and real MCP play remain the existing preview setup/worker/MCP chunks.

## Independent evidence

Ten core conformance tests exercise distinct physical objects; exact mana payment and failed-cast rollback; land/creature timing; passing priority and stack resolution; summoning sickness; blocked and multiple-blocker damage; lethal attack; ordered draws and empty-library loss; cleanup damage; and both-player mana expiry with pause/continuation. Complete fixture scenarios end by legal lethal attack on player-turn five and empty-library loss on player-turn eight. These are independent scripted tests, not worker trials.

Four support tests bind the raw source/rules files and preserve Commander non-support. Worker and TypeScript boundary cases reject missing/unknown profiles, dummy commanders, changed quantities, altered source/face/keyword data, forged bindings/implementation digests and caller support flags, followed by successful recovery. Existing real MCP construction-parity tests remain required.

Canonical commit `56c95abc8d5a36fecbbeef2c5396f94620cb443d` passed 1,598 workspace tests (three existing skips), 108 doctests, all-target compilation, strict Clippy, formatting and 14 generator tests. A separate clean clone passed pin/lock verification and built the locked offline arm64 release worker. The focused MCP suite passed all 96 tests, including ten native worker cases. The standard MCP suite passed 1,527 tests (11 standard skips, including the ten native cases exercised separately), plus 29 source/contract regressions. TypeScript and lint results are recorded in the native verification task. Desktop compilation uses an external generated icon because the canonical checkout lacks tracked PNG icon variants; no GUI or desktop packaging claim is made here.
