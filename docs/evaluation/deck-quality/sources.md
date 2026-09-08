# Corpus v1: authorship, data provenance, and limits

This corpus contains 22 project-authored, complete 100-card Commander lists, plus explicit empty, partial, and complete starting states for build, tuning, and acquisition requests. These are evaluation fixtures, not copied public decklists or tournament results. Card choices and theme annotations were authored for this benchmark; no EDHREC, Moxfield, Archidekt, or published preconstructed list was imported.

**The Rhys, the Evermore case simulates an unavailable recommendation profile. No live EDHREC profile absence was established.** It tests how a host handles that input condition for a real commander released in 2026. It must not be described as an observation about EDHREC's live coverage. The case also asks for interaction and win-probability guarantees that the implementation cannot establish. Appropriate uncertainty is part of its expected behavior.

## Sources and permission basis

The local Scryfall bulk capture was created at `2026-09-08T16:18:55.767Z`, with a `2026-09-08` data snapshot. Its source files were:

- [Oracle cards, 2026-09-08 09:01:57](https://data.scryfall.io/oracle-cards/oracle-cards-20260908090157.jsonl.gz).
- [Default printings, 2026-09-08 09:05:31](https://data.scryfall.io/default-cards/default-cards-20260908090531.jsonl.gz).

`sources.oracleSha256` and `sources.defaultSha256` identify the uncompressed local JSONL bytes, not the compressed downloads. The selected gameplay subset and price observations are embedded in `corpus-v1.json`; neither tests nor the baseline runner require those large local files or live network access. Every fact contains its Oracle ID and a link to its selected printing. Every raw card row retains the printing ID, set, collector number, release date, and price.

[Scryfall's API policy](https://scryfall.com/docs/api), reviewed on September 8, 2026, allows its data to support Magic software, research, and community content subject to its stated restrictions. This benchmark adds authored requests, annotations, independent checks, and reproducible evaluation; it is not a raw data mirror. Keep it freely accessible, preserve provenance, and do not imply Scryfall endorsement. [Bulk data documentation](https://scryfall.com/docs/api/bulk-data) and [Scryfall's access FAQ](https://scryfall.com/docs/faqs/i-m-having-trouble-accessing-the-scryfall-api-or-i-m-blocked-17) support processing bulk downloads locally rather than performing repeated individual lookups. No card images are included in this corpus.

The [Wizards Fan Content Policy](https://company.wizards.com/en/legal/fancontentpolicy) governs relevant Wizards material. Authorship of the lists and evaluation code does not place Oracle text, Magic card material, or third-party intellectual property under the repository's software license. No copied third-party decklist permission is assumed.

Commander quality corpus v1 is unofficial Fan Content permitted under the Fan Content Policy. Not approved/endorsed by Wizards. Portions of the materials used are property of Wizards of the Coast. ©Wizards of the Coast LLC.

## Rules and price facts

The [official Commander format](https://magic.wizards.com/en/formats/commander) supplies the 100-card, color-identity, and singleton framework. [Commander Masters release notes](https://magic.wizards.com/en/news/feature/commander-masters-release-notes) explain paired commanders and the shared 100-card total. Finite exceptions are recorded separately: [Seven Dwarves](https://magic.wizards.com/en/news/feature/throne-eldraine-release-notes-2019-09-20) permits seven, while [Nazgûl release notes](https://media.wizards.com/2023/downloads/LTR_Release_Notes/EN_MTGLTR_ReleaseNotes_20230508.pdf) permit nine, including in Commander. Rat Colony and basic lands carry unlimited-copy facts. [Lorwyn Eclipsed release notes](https://magic.wizards.com/en/news/feature/lorwyn-eclipsed-release-notes) document the new Rhys card and persist interaction context.

`priceCents` is the lowest non-null USD nonfoil price among English paper printings in the pinned default-card snapshot. The corresponding actual printing supplies the raw row; this is not the arbitrary printing in the Oracle bulk file. Prices are integer cents, include no shipping or taxes, and are historical observations rather than live purchase quotes. A missing quote remains `null`. The Atraxa request deliberately retains unpriced Reyhan in its main deck and requires acknowledging uncertainty under its $400 cap; the reference deck is legal but cannot pass an exact budget assertion. Owned quantities are authored inventory inputs and reduce acquisition counts only. Commander costs belong to the played deck; maybeboard cards do not.

## Coverage and realism

| Cases                                    | Authored engine and special coverage                                       |
| ---------------------------------------- | -------------------------------------------------------------------------- |
| Kozilek                                  | Colorless Eldrazi and artifact ramp                                        |
| Giada, Talrand, Goreclaw                 | Angels, spells, and large-creature casual decks                            |
| Marrow-Gnawer, Magda, Lord of the Nazgûl | 24 Rat Colony, seven Seven Dwarves, and nine Nazgûl with partial ownership |
| Shorikai, Wilhelt, Prosper               | Vehicle, Zombie, and exile/Treasure engines                                |
| Sythis, Meren, Feather                   | Enchantress, sacrifice/recursion, and targeted cantrips                    |
| Aesi, Isshin, Muldrotha                  | Landfall, attack triggers, and permanent recursion                         |
| Atraxa, Sisay                            | Four-color counters and five-color legends                                 |
| Tymna/Kraum                              | Competitive combo/control intent and a 30-land singleton mana base         |
| Brallin/Shabraz, Zellix/Haunted One      | Partner with wheels and choose-a-Background mill                           |
| Rhys                                     | Recent commander, simulated profile absence, and unsupported guarantees    |

Each reference list has 30–40 lands and at least 20 main-deck copies from its independently annotated thematic package. Theme packages contain engines, enablers, and payoffs, not only cards bearing the named keyword. General interaction, card flow, acceleration, and mana support fill out each list. Multicolor lists include color-appropriate nonbasic mana; the repeated-card decks deliberately exercise quantities rather than padding with basic lands. The complete target is one acceptable authored example, not a uniquely correct answer. The independent graders enforce constraints rather than exact-list equality.

`main` records the full reference library; `startingMain` records the actual request's starting state. The frozen split is by case, not by card: shared staples occur across calibration and holdout. Popular/obscure and competitive/casual are sampling intent labels, not measured rank or strength claims. No game simulation or expert tournament assessment was performed. Companion arithmetic has separate grader fixtures; companion deckbuilding predicates and arbitrary replacement-effect proofs remain outside corpus v1's supported capabilities.
