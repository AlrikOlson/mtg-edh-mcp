# ADR: Commander-legal pool census

Accepted 2026-09-11 for `engine-any-corpus-inventory`, under the
[engine charter](../ENGINE-CHARTER.md). Native reasoning: `think:346`.

## Delivered boundary

The any-deck denominator is now a committed, reproducible census of the served
Oracle snapshot (`2026-09-11`, version `2026-09-11T23-06-58-054Z-…`): 38,740
identities, of which 31,830 are Commander-legal, 83 banned and 6,827 not legal.
[docs/evaluation/engine-any](../evaluation/engine-any/README.md) holds the
summary, a per-identity ledger of exact-source digests, and the frozen Scryfall
keyword vocabulary. The census binds the official Comprehensive Rules release
`MagicCompRules 20260819.txt` (effective 2026-08-07, SHA-256 `4381ad1b…`)
through the existing rules store manifest, the bulk file provenance of the
snapshot, and the exact index image revision.

Every legal identity yields the same requirement rows the canonical Rust
`cards::support::assess` inventories, so a future `support_check` report joins
row for row. Each counted row carries exactly one status: `qualified` for the
three registered basic-land intrinsic mana clauses (Swamp, Island, Forest under
`core-support-v1` at engine revision `bcb9a029`), `owned` when pending roadmap
chunks own all of its families, or `unresolved`. The committed census has
649,207 counted rows, 3 qualified, 649,204 owned and 0 unresolved, over 60,408
Oracle paragraphs and 32,350 explicit faces.

The 77-identity Muldrotha baseline is untouched and all 77 frozen digests match
the served pool. The same digest convention reproduces the Rust registry's
`source_digest` for Reclamation Sage (`067d5222…`).

## Findings routed to owners

| Finding                                                                              | Count                                                                                                                                                   | Owner                                                     |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Legal records with no face inventory (class, saga, case, leveler, mutate, prototype) | 305 cards                                                                                                                                               | `mcp-catalog-face-inventory` (new, MCP ingestion)         |
| Legal records with face relationship `unsupported` (the above plus prepare, flip)    | 370 cards                                                                                                                                               | same, plus `engine-any-layouts-special-actions`           |
| Keyword labels outside Scryfall's three catalogs (named abilities)                   | 486 labels on 401 cards                                                                                                                                 | `engine-any-kw-named-abilities` (new)                     |
| Keyword abilities, actions and ability words                                         | 327 labels; 371 vocabulary entries                                                                                                                      | eight new `engine-any-kw-*` batches                       |
| Vocabulary entries never used as a card label in this pool                           | 44                                                                                                                                                      | reported (`keywords.vocabulary_unused`), no owner owed    |
| Cards creating tokens with no related token record                                   | 92                                                                                                                                                      | `engine-mvp-catalog-objects`, copy/composite objects      |
| Emblem-creating text                                                                 | 88                                                                                                                                                      | planeswalkers, auxiliary state                            |
| Commander configurations                                                             | 3,386 eligible; 58/52/19 partner kinds; 32 choose-a-background; 30 backgrounds; 27 Doctor's companion; 17 Time Lord Doctors; 21 "can be your commander" | `engine-mvp-commander`, `engine-evolution-rules-evidence` |
| Companions                                                                           | 8 modeled, 2 heuristic                                                                                                                                  | `engine-evolution-rules-evidence`                         |
| Characteristic-defining power/toughness                                              | 236 cards                                                                                                                                               | layers rule effects, expressions/selectors                |

Clause shapes (triggered 13,735; static 13,549; keyword line 19,109; activated
8,928; mode line 1,741; loyalty 858; replacement 850; chapter 581; reminder 560;
modal 497) route paragraphs to the trigger/replacement, layers, cost/permission,
choice-form, planeswalker and card-type lifecycle owners. They are planning
classes over paragraph openings and are labelled as such in the census.

## Architecture and reuse review

| Decision                      | Single production owner and disposition                                                                                                                     |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Legal pool enumeration        | Existing `CardIndex`; one new read-snapshot iteration seam (`forEachCommanderLegality`). No second index or catalog.                                        |
| Exact-source identity         | Existing `digestEvaluation` convention, proven equal to the Rust registry digest; no new hashing scheme.                                                    |
| Requirement ids               | The Rust support module's path/offset scheme, reproduced in TypeScript so reports join; the Rust module stays the only qualification authority.             |
| Commander/companion facts     | Existing `validate/commanderRules` (`commanderShape`, `isCommanderEligible`) and `companionRules`; no parallel reading of command-zone text.                |
| Rules and legality provenance | Existing `RulesStore`/`RulesService` refresh path and Scryfall legalities in the snapshot; the census only records manifests and digests.                   |
| Keyword vocabulary            | Frozen Scryfall catalogs with digests; membership is a label class, never behavior evidence.                                                                |
| Clause shapes                 | Evaluation-only classifier in `src/evaluation`, outside every production route; the charter's prohibition on shadow behavior parsers is respected.          |
| Ownership table               | `src/evaluation/legalPoolOwnership.ts`; a vocabulary entry without a batch fails `npm test`, which is how a future snapshot forces new pending work.        |
| Generated outputs             | `scripts/legal-pool-census.mjs` bundles the owner with esbuild; outputs are regenerated, never hand-edited; the ledger uses compact JSONL outside Prettier. |

No engine source, contract or protocol changed; the pin stays at `bcb9a029`.
No public MCP tool changed. Nothing here admits a card for play.

## Evidence and reproduction

```sh
npx vitest run src/evaluation/legalPool.test.ts
MCP_DATA_DIR="$HOME/.mtg-edh-mcp/cards" node scripts/legal-pool-census.mjs --check
```

The test always verifies vocabulary coverage of the batches, the qualified
evidence pin, the digest literal, fixture classification (normal, transform,
saga without faces, planeswalker, partner-with, background, choose-a-background,
companion, token maker, basic lands, unlisted label, banned and not-legal
records) and baseline drift reporting. With a served data root it regenerates
the census and requires equality with the committed summary and ledger.

## Limits

The census does not prove any card executes. Shapes can misroute a clause to
a different pending owner without changing the fact that it is owned. Scryfall's
card-level keyword labels omit some rules verbs and some legal keywords
(44 vocabulary entries are unused as labels), so keyword-line recognition in
clause text is the complementary count. The ledger freezes identity and digest;
exact text lives in the immutable snapshot. New snapshots, Oracle changes and
rules releases create pending requalification through
`engine-evolution-rules-evidence`, which now depends on this census.
