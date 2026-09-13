# Commander-legal pool census

The any-deck denominator: every Oracle identity that Scryfall marks
`legalities.commander = legal` in the served snapshot, frozen by identity and
exact-source digest, with every source obligation routed to a pending owner in
the native Magistr roadmap. This directory is evaluation data under the
[engine charter](../../ENGINE-CHARTER.md); the native roadmap remains
authoritative and nothing here executes rules or authorizes play.

## Files

| File                                                     | Owner                                                              | Content                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [census-v1.json](census-v1.json)                         | `scripts/legal-pool-census.mjs` over `src/evaluation/legalPool.ts` | Snapshot, rules and vocabulary bindings, denominators, status totals, owner and family tables, keyword tables, layouts, baseline drift, banned identities, ledger digest, unresolved rows (must be empty), limitations.                                                                                                                                                                                                                           |
| [pool-ledger-v1.jsonl](pool-ledger-v1.jsonl)             | same generator                                                     | One `[oracle_id, name, source_digest]` line per legal identity, sorted by oracle_id. The digest is the key-sorted compact JSON SHA-256 of the canonical `CardGameplay` record, identical to the Rust support registry's `source_digest`.                                                                                                                                                                                                          |
| [keyword-vocabulary-v1.json](keyword-vocabulary-v1.json) | frozen from Scryfall's catalog endpoints on 2026-09-11             | 223 keyword abilities, 79 keyword actions and 69 ability words with per-list digests. Membership classifies labels; it is never behavior evidence.                                                                                                                                                                                                                                                                                                |
| [requalification-v1.json](requalification-v1.json)       | same generator over `src/evaluation/evidenceFreshness.ts`          | The dated update record: previous and current evidence bindings (snapshot, rules release, rulings export, vocabulary, engine pin, ledger and banned digests, qualified evidence, baseline drift, keyword labels), the construction authority's card dependencies and Game Changers membership frozen by digest, the rules-audit excerpt binding, every change between the two, invalidated evidence and the finite requalification units to file. |
| `src/evaluation/legalPoolOwnership.ts`                   | this repository                                                    | Family → chunk owners, the nine keyword batches and the three qualified-evidence rows. A vocabulary entry outside every batch fails `npm test`.                                                                                                                                                                                                                                                                                                   |

Exact Oracle text is not copied here. It stays in the immutable versioned
snapshot named by the census (`snapshot.version`, bulk file provenance and
`index_revision`), and the ledger digests bind each identity to those bytes.

## What the census counts

Rows follow the canonical Rust `cards::support::assess` inventory so a future
`support_check` report joins id for id: the two shared rows, `/layout`,
`/face_relationship`, `/color_identity`, twelve characteristic fields per root
and per face, one clause per non-empty Oracle paragraph addressed by UTF-16
offsets (`/faces/{i}/characteristics/oracle_text:{start}-{end}`), the
`faces` row when the stored record has no face inventory, and
`intrinsic-basic-mana` for basic lands. The census adds rows the Rust module
does not emit: one per Scryfall keyword label, commander configuration,
companion, related token/meld/emblem record, text-created token or emblem
without a related record.

Root characteristic rows are emitted for every card but counted only when the
record has no face inventory, so single-faced cards are not double counted.
Each counted row has exactly one status:

- `qualified`: listed in `QUALIFIED_EVIDENCE` and matched by identity and
  requirement id. Only the Swamp, Island and Forest `intrinsic-basic-mana`
  rows qualify, per the pinned core `core-support-v1` (engine revision in
  `engine/source.json`).
- `owned`: at least one pending chunk owns every family on the row.
- `unresolved`: no owner. The committed census must have none.

Families are planning classes, not semantics. Clause shapes come from the
paragraph opening (loyalty, chapter, mode line, modal, keyword line,
triggered, activated, replacement, reminder, static); a misrouted clause is
still owned, and the eventual qualification evidence is the canonical Rust
report, never this classifier.

## Updating, diffing and requalifying

```sh
MCP_DATA_DIR="$HOME/.mtg-edh-mcp/cards" node scripts/legal-pool-census.mjs           # update
MCP_DATA_DIR="$HOME/.mtg-edh-mcp/cards" node scripts/legal-pool-census.mjs --check   # verify
```

The update step reads the committed census and ledger as the previous
evidence, regenerates the census over the served snapshot, diffs the two with
`src/evaluation/evidenceFreshness.ts`, and writes the new census, ledger and
`requalification-v1.json` together. The generator bundles the TypeScript
owners with esbuild into `build/`, opens the served snapshot read-only, reads
the published rules manifest and never reaches the network. `--check`
regenerates and requires the committed census and ledger to match byte for
byte and the committed requalification's `current` state to match the data
root.

What moves and what it invalidates:

| Source change                            | Detected by                          | Invalidates                                                | Unit filed                                        |
| ---------------------------------------- | ------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------- |
| Oracle text or characteristics of a card | ledger `source_digest`               | qualified rows of that identity; construction dependencies | `pool_identities` per pending owner               |
| New legal identity                       | ledger row added                     | nothing (rows land in their pending owners)                | `pool_identities` per pending owner               |
| Identity banned, unbanned or removed     | ledger row removed; `banned` list    | qualified rows of a removed identity                       | recorded in `changes`; qualified rows open a unit |
| New keyword label                        | census keyword tables                | nothing until the vocabulary batch test fails              | `pool_identities`; `vocabulary` when frozen       |
| Comprehensive Rules release              | rules manifest `sha256`              | the frozen validator excerpt when cut from another release | `rules_release`                                   |
| Rulings export                           | rules manifest `updated_at`/`sha256` | cited card rulings                                         | `rulings_export`                                  |
| Frozen keyword vocabulary                | vocabulary digests                   | batch assignments (`npm test` fails until assigned)        | `vocabulary`                                      |
| Engine source pin                        | `engine/source.json` revision        | every qualified row                                        | `engine_revision`                                 |
| Companion or copy-exception card record  | construction dependency digest       | the validator's assumption about that card                 | `construction_dependency`                         |
| Game Changers membership                 | policy digest                        | bracket/policy evidence                                    | `policy_membership`                               |
| Frozen MVP baseline record               | census baseline drift                | the fixed-corpus evidence                                  | `baseline_corpus` (owner `engine-mvp-corpus`)     |

`status` is `current` when the update rebinds the evidence and opens no work,
and `requalification_required` otherwise. Units with an `owner` are absorbed
by that pending chunk's scope; units with `owner: null` name a new chunk to
file. Filing is the maintainer's step in the native roadmap; the report is
the evidence, never the roadmap.

`src/evaluation/legalPool.test.ts` always checks the ownership table, the
digest convention against the frozen Reclamation Sage record, the fixture
classification and baseline drift reporting; when a served data root exists
it also regenerates the census and requires equality with the committed
files. `src/evaluation/evidenceFreshness.test.ts` exercises the diff on two
fixture snapshots (added, removed and changed identities, a new ban, a new
keyword, a changed copy grant, a changed Game Changers list, a moved engine
pin, a moved rules release) and requires the committed requalification to
bind exactly the committed census.

Review every diff, assign new vocabulary to a batch, file the listed units,
then commit the regenerated files as a new version. Do not edit the generated
files by hand and do not narrow the denominator to make a report look better.
The previous ledger of any committed update is the file at the prior commit;
its digest is recorded under `previous.bindings.ledger_digest`.
