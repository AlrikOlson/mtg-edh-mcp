# Canonical mana source conformance

Accepted for `engine-mvp-mana-sources`; follows the [charter](../ENGINE-CHARTER.md), [source delivery](engine-source.md), [output primitives](engine-mana-outputs.md) and [eligibility/context](engine-mana-eligibility.md). Native Magistr holds execution status.

## Architecture and reuse review

The three prerequisite chunks delivered the requested production behavior. This parent adds executable independent conformance evidence and a corpus binding inventory. Rust `mana/payment.rs` remains the exact planner/executor; `mana_ability.rs` executes sources; `source.rs` owns represented resources/restrictions; `context.rs`, `costs.rs`, layers and control history supply their existing decisions. Casting, ordinary activation and action enumeration keep those same owners.

The canonical source change is confined to `crates/mtg-engine/tests/mana_source_fixtures.rs`. It translates test input into existing typed core objects and calls the production payment APIs. It contains no Oracle parser, search algorithm, alternative payment executor or worker endpoint. MCP adds independent expected-result data and a static integrity test, without changing its frozen legacy gameplay paths or admitting any additional cards. No production module, shared interface, snapshot schema, dependency or worker protocol changes.

## Independent evidence

[MCP fixtures](../evaluation/engine-mvp/mana-source-fixtures-v1.json) contain 36 manually authored expectations grounded in the frozen corpus, existing MCP dual/Signet reference cases and the rules. They are not generated from engine output. They cover alternative dual/three-color/any-color outputs, simultaneous Sol Ring output and surplus, strict colorless, external activation fees and a forced colored-fee dependency chain, restricted floating mana and activation funding, creature readiness/haste/controller, tap/sacrifice/life conservation and grounded contextual land colors.

The Rust test verifies planning leaves canonical bytes unchanged; unavailable represented payments specifically return `InsufficientMana`; successful payments have exact pool restrictions, life, per-source tap/zone state and production-event count. Forced dependencies also assert activation order. Every successful case is repeated through restored core state with identical plans/results, and stale witnesses reject without mutation. Existing engine-owned `mana_plans`, `mana_outputs`, `mana_eligibility` and `mana_context` scenarios retain deeper event/control/cost coverage.

The test rejects missing expectations, unknown fields, empty case sets and duplicate IDs. A deliberately incorrect expected life total in a temporary fixture was observed to fail at the resource assertion. That sensitivity run is an expected failure, not a failed product check. The first dependency-chain fixture overconstrained two valid generic-fee orders; its input was corrected to require a blue activation fee and a final GGG payment, making the recorded order a rules requirement.

The test is ignored by ordinary standalone Cargo runs because its data belongs to MCP. Source qualification must explicitly run the integration-test target with `--ignored`, using the immutable source checkout at the MCP pin:

```sh
MTG_MANA_FIXTURES="$PWD/docs/evaluation/engine-mvp/mana-source-fixtures-v1.json" \
CARGO_TARGET_DIR="$PWD/build/engine-target" CARGO_BUILD_JOBS=4 \
cargo test --manifest-path "$MTG_ENGINE_CHECKOUT/Cargo.toml" \
  --locked --offline -p mtg-engine --no-default-features \
  --test mana_source_fixtures -- --ignored --nocapture
```

The recorded required check must report all 36 scenarios and a passed test, not a zero-test filtered run. The normal MCP suite runs `engineManaSources.test.ts` to detect omitted identities, Oracle/span drift, duplicate IDs and dangling scenario references. That static test does not execute payments or certify card support.

## Corpus binding contract

The [binding inventory](../evaluation/engine-mvp/mana-source-coverage-v1.json) accounts for all 22 source-bearing Oracle identities, including Kheru Goldkeeper's generated Treasure text. It retains exact Oracle text and all original clause spans. Scenario references establish reusable primitive behavior; every row separately names outstanding card bindings. Full card support remains unassessed.

| Family                                           | Verified primitive                                                                                  | Required downstream binding                                                                                                                                     |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Basics, Bojuka Bog, Myriad Landscape, Mind Stone | One exact colored/colorless unit and a physical tap                                                 | Intrinsic subtype abilities, land timing/entry, targeted Bog trigger, library searches and Mind Stone draw                                                      |
| Woodland Cemetery, Opulent Palace                | Exclusive colored choices                                                                           | Exact colors and conditional/unconditional entry state                                                                                                          |
| Command Tower, Arcane Signet                     | Supplied BGU alternatives                                                                           | Established runtime Commander identity, empty identity, casting and zone-independent identity                                                                   |
| Exotic Orchard, Fellwar Stone                    | Grounded opponent-land colors; tapped/fee-restricted potential; no invented colorless/cyclic output | Four-player opponents, elimination, applicable production replacements and exact card binding                                                                   |
| Three green Elf dorks, Trailtracker Scout        | Creature control eligibility, haste and single-color choices                                        | Exact card/casting definitions; Scout expend accounting and optional targeted trigger                                                                           |
| Sol Ring                                         | Two simultaneous colorless units and exact surplus                                                  | Exact card/casting definition and step/phase pool clearing                                                                                                      |
| Three painlands                                  | Alternative colored/colorless output representation                                                 | Mandatory damage after colored production through damage/prevention/replacement events, including activation at one life; **never substitute PayLife**          |
| Molt Tender                                      | Any-color output and creature eligibility                                                           | Selected graveyard-card exile cost and graveyard-leaving event; separate tap-to-mill ability; the output fixture does not execute Tender's full mana activation |
| Treasure                                         | Tap and self-sacrifice once for one color                                                           | Canonical token definition, creation and state-based cleanup; the fixture uses an artifact object for activation-resource conformance                           |

`engine-mvp-cost-choices` owns selected exile and actual casting expenditure. `engine-mvp-commander` owns established Commander identity. `engine-mvp-lands` binds exact source clauses through those owners and the zones/effects pipeline. Existing dependency direction already puts these bindings downstream; no reverse cycle is introduced. Life/sacrifice and generic Signet cases are additional independent reference scenarios, not claims that a painland pays life or Arcane Signet has a mana activation fee.

Current CR 605.1a excludes an ability whose own costs/effects move cards to or from a library from mana-ability classification. Route fetch/draw/mill clauses through the ordinary stack/choice owner. Molt Tender's separate mill ability does not disqualify its distinct exile-for-mana ability. Relevant primary evidence: [official Comprehensive Rules](https://media.wizards.com/2026/downloads/MagicCompRules%2020260819.txt), [Hobbit update bulletin](https://magic.wizards.com/en/news/announcements/the-hobbit-update-bulletin), and [Reflecting Pool rulings in Edge of Eternities release notes](https://magic.wizards.com/en/news/feature/edge-of-eternities-release-notes).

## Qualification and retained limits

Delivery uses a source-first canonical test commit, a separate clean clone at the pin, source/lock checks before and after the native worker build, dependency-graph inspection, catalog-free self-check, generated-contract provenance and real native protocol checks. Recorded core/worker tests, strict Clippy, formatting and MCP gates qualify this change. The worker remains an internal support-preflight artifact; it does not expose payment execution through MCP.

No simulation-performance claim follows from these small fixtures. Search remains exact and potentially exponential; the execution-control and performance chunks retain their budgets/gates. Four-player gameplay, all-clause corpus admission, policies, replay/job supervision, installed packaging and public cutover remain downstream. `engine-mvp-cutover` must switch public routes and delete the overlapping legacy TypeScript execution/parsers together; no fallback was added here.
