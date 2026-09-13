# ADR: Rules, Oracle and legality evidence maintenance

Accepted 2026-09-12 for `engine-evolution-rules-evidence`, under the
[engine charter](../ENGINE-CHARTER.md). Native reasoning: `think:348`.

## Delivered boundary

Evidence maintenance is now a dated, tested workflow rather than a standing
obligation. `scripts/legal-pool-census.mjs` reads the committed census and
ledger as the previous evidence, regenerates the census over the served
snapshot, diffs the two through `src/evaluation/evidenceFreshness.ts`, and
writes `docs/evaluation/engine-any/requalification-v1.json` together with the
new census and ledger. `--check` regenerates and requires byte equality of the
census and ledger plus equality of the committed `current` evidence state with
the data root. The first real update rebinds the census from snapshot
`2026-09-11` (version `2026-09-11T23-06-58-054Z-…`) to `2026-09-12` (version
`2026-09-12T21-06-22-327Z-…`, index revision `6707adee…`): all 31,830 legal
identities are unchanged by exact-source digest, the 83 banned identities, the
keyword labels, the Comprehensive Rules release (`20260819`, effective
2026-08-07, SHA-256 `4381ad1b…`), the rulings export, the frozen vocabulary and
the engine pin (`bcb9a029`) are unchanged, so the record's status is `current`
with zero invalidations and zero units.

The record freezes what the diff compares beyond the census: the construction
authority's card dependencies by `oracle_id` and exact-source digest (the ten
modeled companions with their coverage label, the six unlimited allowlist
names, and every legal card carrying a bounded copy grant: Seven Dwarves at
seven, Nazgûl at nine), the Game Changers membership carried by the snapshot
(53 names, digest `e49c00a3…`), and the rules-audit excerpt binding (excerpt
`f462cd09…`, cut from corpus `4381ad1b…`).

Bounded copy limits moved into the canonical validate authority.
`copyLimit(card)` in `src/validate/coreRules.ts` reads basic lands, "any
number of cards named" and "up to N cards named" from the card record; the
singleton rule rejects cap+1 (eight Seven Dwarves, ten Nazgûl) with an explicit
detail and accepts the cap; an ununderstood bounded numeral is reported and
treated as one copy, never as unlimited. The rules audit gains two cases citing
903.5b and 101.1 from the frozen excerpt. Deck construction, the deck plan and
the build library all consume the validator; the private parser and the
Seven Dwarves/Nazgûl name fallbacks in `src/deck/construction.ts` are gone.

The read-only `doctor` command reports the rules corpus: version, effective
date, published release, both digests, rulings `updated_at`, age against the
same 30-day window the rules tools use, and recovery from a previous version;
an absent corpus is reported as informational, an unreadable one as an error.
It performs no network access and no writes.

## Ownership, consumers, reuse and overlap

| Concern                                      | Owner                                                            | Consumers                                                                                    | Reused                                                                                               |
| -------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Evidence bindings, diff, invalidation, units | `src/evaluation/evidenceFreshness.ts`                            | `scripts/legal-pool-census.mjs`, `evidenceFreshness.test.ts`                                 | `censusLegalPool`/`censusCard` rows and owners, `digestEvaluation`, `loadRulesExcerpt`, `RulesStore` |
| Legal-pool census                            | `src/evaluation/legalPool.ts` (`ownersOfFamilies` extracted)     | freshness owner, committed census                                                            | unchanged conventions joined to the Rust support ids                                                 |
| Copy limits                                  | `src/validate/coreRules.ts` `copyLimit`                          | `checkSingleton`, `anyNumberExemptions`, `deck/construction.ts`, `deck/deckPlan.ts`, `build` | Oracle text as evidence; CR 903.5b + 101.1 audit                                                     |
| Companion conditions                         | `src/validate/companionRules.ts` (`modeledCompanionNames` added) | freshness dependencies, construction                                                         | existing `COMPANION_RULES` and coverage labels                                                       |
| Rules corpus provenance                      | `src/rules` store/service                                        | rules tools, census, doctor                                                                  | `openCurrentRules`, `RULES_STALE_AFTER_MS`                                                           |
| Policy membership                            | `CardIndex.gameChangerNames()`                                   | freshness policy digest, playgroup policy                                                    | existing column                                                                                      |

Overlap removed: the second copy-limit parser in deck construction. Overlap
retained deliberately: the unlimited allowlist stays as a safety net for six
names whose text already matches the generic phrase; its members are frozen by
digest so drift is visible. No engine source, contract, protocol or MCP play
route changed; the Rust support module remains the only qualification
authority, and the census/requalification rows remain planning obligations.

## Findings and routing

| Finding                                                                                  | Routing                                                                                                                        |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Production accepted eight Seven Dwarves / ten Nazgûl (deck-quality baseline observation) | Fixed in the validator; the frozen benchmark receipt is retained unchanged as history                                          |
| Snapshot drift on 2026-09-12 with no Oracle change                                       | Handled by the update; status `current`                                                                                        |
| Interaction explanations do not cite rules/rulings                                       | `mcp-interaction-rule-citations` (pending, deps this chunk)                                                                    |
| Mechanics extractor coverage is measured on authored texts only                          | `mcp-mechanics-live-coverage-measure` (pending, deps this chunk)                                                               |
| Filing units into the native roadmap is a maintainer step                                | Documented in the census README; the report is evidence, the roadmap stays authoritative                                       |
| Kaheera/Zirda companion conditions remain heuristic                                      | Coverage labels frozen in the dependency record; face-aware conditions remain owed to the validator when exact evidence exists |

## Evidence

- `src/evaluation/evidenceFreshness.test.ts`: two fixture snapshots (added,
  removed and changed identities, a new ban, a new keyword, a changed copy
  grant, a changed Game Changers list, a moved engine pin, a moved rules
  release with a stale excerpt), the no-change case, file round trip,
  committed consistency and equality with the served data root.
- `src/validate/coreRules.test.ts` and `src/evaluation/rulesAudit.ts`: caps
  accepted, cap+1 rejected through the real validator, bounded exemption with
  its cap, ununderstood grant reported.
- `src/server/setup.test.ts`: absent, fresh, stale and digest-mismatched rules
  corpora through the real doctor without network or filesystem writes.
- `node scripts/legal-pool-census.mjs --check` exit 0 against the served
  2026-09-12 snapshot; recorded in the verification task.

## Limits

- The identity-level diff needs the previous ledger; after an update the prior
  ledger lives in repository history (its digest is recorded).
- Commander eligibility and companion conditions have no separate ledger; they
  change only through card records (digest) or the rules release (binding).
- Game Changers provenance dates are not published by the source; membership
  is compared by digest only.
- Rules and rulings refresh remain explicit (`rules_refresh`); no scheduler was
  added, matching the no-network-at-boot policy.
- Nothing here executes rules or qualifies a card; only the canonical Rust
  support report can move a row to `qualified`.
