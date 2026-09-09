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
| Eligible commander types | 903.3, 903.3a                         |     5 | Verified unchanged                            |
| Partner, partner with    | 702.124f/g/h/j                        |     4 | Verified unchanged                            |
| Partner—[text]           | 702.124i, 702.124f                    |     3 | **Discrepancy fixed**                         |
| Choose a Background      | 702.124k                              |     2 | Tightened to legendary Background enchantment |
| Doctor's companion       | 702.124m                              |     3 | **Discrepancy fixed**                         |
| Companion                | 702.139a, 702.139b, 903.5a            |     2 | Verified unchanged                            |

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
