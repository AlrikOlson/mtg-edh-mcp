# Rules evidence and the Commander validation audit

The server retrieves two versioned corpora and answers from them verbatim:
the Magic Comprehensive Rules (the plain-text release published by Wizards
of the Coast) and card rulings (Scryfall's bulk `rulings` export, which holds
official Wizards rulings and Scryfall's own notes). `src/rules/` parses,
stores and serves them; `src/server/rulesTools.ts` exposes `rules_lookup`,
`rules_search`, `rules_refresh` and `card_rulings`. None of it interprets
rules or judges an interaction.

## Corpus provenance

Every rules response carries `corpus`: the release URL and how it was chosen
(`rules_page`, `pinned_default` or `explicit`), the SHA-256 and byte size of
the stored bytes, the effective date read from the document, the release
label from the filename, the rulings export's upstream `updated_at`, both
retrieval times, an age, and a `status` of `current`, `stale` (older than 30
days or the last refresh failed) or `unavailable`. Rule numbers change between
releases, so a cited number is only meaningful next to its effective date.

The corpus is refreshed only by `rules_refresh`. A failed, malformed or
truncated download removes its staged version and leaves the published
pointer untouched; the previous corpus keeps serving with `stale` status and
`refresh_failed: true`. `src/rules/store.test.ts` covers the cold store, page
discovery, the pinned fallback, explicit URLs, idempotent skips, malformed
and truncated rejections, network failure and recovery of the previous
version when the current one is unreadable. `src/server/rulesTools.test.ts`
exercises the tools through the real MCP SDK over streamable HTTP on both
supported protocol revisions and in memory on a cold corpus.

## The frozen excerpt

[commander-rules-excerpt-20260807.json](commander-rules-excerpt-20260807.json)
freezes the verbatim text of the rules the Commander validators depend on,
cut from the release below. The audit test pins both digests.

| Field            | Value                                                                    |
| ---------------- | ------------------------------------------------------------------------ |
| Source           | `https://media.wizards.com/2026/downloads/MagicCompRules%2020260819.txt` |
| Effective date   | 2026-08-07 (from the document's own "effective as of" sentence)          |
| Release label    | 20260819 (from the filename; the page also lists 20260807 PDF/DOCX)      |
| Retrieved        | 2026-09-09                                                               |
| Release SHA-256  | `4381ad1b39ab2c05f7d03633a20f711ed37277074d3266dcba5f38cbb527423f`       |
| Rules in excerpt | 76 (100.2\*, 101.1, 201.3, 205.3m, 702.124\*, 702.139\*, 903.\*)         |
| Glossary terms   | Commander, Color Identity, Companion, Background, Legendary              |

The full release parsed to 9 chapters, 146 sections, 3162 numbered rules and
739 glossary terms with no duplicate identifiers.

## Method

`src/evaluation/rulesAudit.ts` holds a case table. Each case cites the rule
identifiers it exercises, quotes the load-bearing phrase from those rules,
and runs a deck fixture through the real `validateCore`, `validateCommander`
and `validateCompanion` functions. `src/evaluation/rulesAudit.test.ts` fails
when a validator's verdict drifts, when a cited rule is missing from the
excerpt, when a quoted phrase no longer appears in the frozen text, or when
either digest changes. A new rules release therefore forces a deliberate
re-read of the excerpt rather than a silent update.

| Area                     | Rules cited                           | Cases | Verdict                                       |
| ------------------------ | ------------------------------------- | ----: | --------------------------------------------- |
| Deck size                | 903.5a, 702.124b                      |     3 | Verified unchanged                            |
| Singleton and exemptions | 903.5b, 101.1                         |     3 | Verified unchanged                            |
| Color identity           | 903.4, 903.5c, 702.124c               |     3 | Verified unchanged                            |
| Banned list              | 100.2c (list itself is Scryfall data) |     1 | Verified unchanged                            |
| Format legality          | 100.2c, 903.5 (pool is Scryfall data) |     2 | **Consolidated** (2026-09-19)                 |
| Command-zone overlap     | 903.5a, 903.5b                        |     1 | **Consolidated** (2026-09-19)                 |
| Eligible commander types | 903.3, 903.3a, 101.1                  |     6 | Creature-card-off-battlefield case added      |
| Partner, partner with    | 702.124f/g/h/j                        |     4 | Verified unchanged                            |
| Partner—[text]           | 702.124i, 702.124f                    |     3 | **Discrepancy fixed**                         |
| Choose a Background      | 702.124k                              |     2 | Tightened to legendary Background enchantment |
| Doctor's companion       | 702.124m                              |     3 | **Discrepancy fixed**                         |
| Companion                | 702.139a, 702.139b, 903.5a            |     2 | Verified unchanged                            |
| Companion overlap        | 702.139a                              |     1 | **Consolidated** (2026-09-19)                 |
| Companion resolvability  | 702.139a                              |     3 | Unresolved conditions reported, never passed  |

## Construction authority consolidation (2026-09-19)

The deck plan, deck construction and build construction used to carry their
own legality guards beside the public validator, and the two disagreed. The
validator now owns every deck-construction verdict, and those paths read it
(`docs/architecture/mcp-construction-authority-consolidation.md`):

- **Format legality (100.2c, 903.5).** A card whose Commander legality is
  `not_legal` (or `restricted`) is `FORMAT_ILLEGAL`; a record carrying no
  Commander legality is `FORMAT_LEGALITY_UNKNOWN`. Banned cards stay
  `BANLIST`, which now also covers the declared companion.
- **Command-zone overlap (903.5a, 903.5b).** The commander counts among the
  100, so a commander also in the library beyond its copy limit is
  `COMMANDER_LIBRARY_OVERLAP`, read through the same `copyLimit` as the
  singleton rule.
- **Companion overlap (702.139a).** The companion is one card from outside
  the game; a declared companion that is also a commander or a library card
  is `COMPANION_DECK_OVERLAP`.
- **Companion resolvability (702.139a).** `resolveCompanionCondition` is the
  one decision of whether a condition is exactly evaluable: an unmodeled
  companion, a heuristic restriction (Kaheera, Zirda) or a starting card with
  incomplete characteristics is `COMPANION_CONDITION_UNRESOLVED`. A supported
  restriction is still judged over the exactly readable cards; a heuristic one
  is never evaluated as a certified break.
- **Eligibility (903.3, 101.1).** A legendary card whose own text makes it a
  creature card in every zone but the battlefield (Grist, the Hunger Tide) is
  a creature card for 903.3, which reads the card outside the battlefield.
  The validator and the ingest heuristic share the reading.

The excerpt and both pinned digests are unchanged; every new case quotes
wording already frozen in it.

## Discrepancies found and fixed

- **Partner—[text] (702.124i, 702.124f).** The validator read every card with
  the word "partner" as plain partner, so `Partner—Survivors` paired with
  plain `Partner` and with `Partner—Father & son`. Scryfall's `keywords`
  lists all of these as `Partner`, so the label is now read from the Oracle
  text and two cards pair only when their labels match. Printed
  `Friends forever` maps to the `partner—Friends forever` label.
- **Doctor's companion (702.124m).** Any creature with the Time Lord type was
  accepted as the Doctor. Twelve non-Doctor Time Lords exist (for example
  `Missy`, a Time Lord Rogue). The Doctor must now be a legendary Time Lord
  Doctor creature with no other creature types.
- **Choose a Background (702.124k).** The Background half was accepted on the
  word "Background" anywhere in the type line. It must now be a legendary
  Background enchantment, both for the pairing and for the command-zone
  eligibility exemption. No printed card was affected; this aligns the check
  with the rule text.

Regression tests for each live in `src/validate/commanderRules.test.ts`.
Commander eligibility (legendary creature, legendary Vehicle or Spacecraft
with a printed power/toughness box, "can be your commander" text) matched
903.3 and 903.3a and was left unchanged.

## Not modeled

The excerpt also freezes rules the validators deliberately do not implement,
listed in `NOT_MODELED` and checked to stay uncited: 903.5d (basic land type
colors are already folded into Scryfall's `color_identity`), 201.3
(interchangeable names), 903.5e (no sideboard zone exists), 903.11 (cards from
outside the game are a play-time rule), and the Brawl (903.12) and Commander
Draft (903.13) options.

## Refreshing the excerpt

Download the current release, verify its effective-date sentence, regenerate
the excerpt with the same rule selection, re-read every quoted phrase against
the new text, then update both pinned digests in the audit test together
with any validator change the new wording requires.
