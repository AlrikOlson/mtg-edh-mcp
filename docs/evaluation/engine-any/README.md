# Commander-legal pool census

The any-deck denominator: every Oracle identity that Scryfall marks
`legalities.commander = legal` in the served snapshot, frozen by identity and
exact-source digest, with every source obligation routed to a pending owner in
the native Magistr roadmap. This directory is evaluation data under the
[engine charter](../../ENGINE-CHARTER.md); the native roadmap remains
authoritative and nothing here executes rules or authorizes play.

## Files

| File                                                     | Owner                                                              | Content                                                                                                                                                                                                                                  |
| -------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [census-v1.json](census-v1.json)                         | `scripts/legal-pool-census.mjs` over `src/evaluation/legalPool.ts` | Snapshot, rules and vocabulary bindings, denominators, status totals, owner and family tables, keyword tables, layouts, baseline drift, banned identities, ledger digest, unresolved rows (must be empty), limitations.                  |
| [pool-ledger-v1.jsonl](pool-ledger-v1.jsonl)             | same generator                                                     | One `[oracle_id, name, source_digest]` line per legal identity, sorted by oracle_id. The digest is the key-sorted compact JSON SHA-256 of the canonical `CardGameplay` record, identical to the Rust support registry's `source_digest`. |
| [keyword-vocabulary-v1.json](keyword-vocabulary-v1.json) | frozen from Scryfall's catalog endpoints on 2026-09-11             | 223 keyword abilities, 79 keyword actions and 69 ability words with per-list digests. Membership classifies labels; it is never behavior evidence.                                                                                       |
| `src/evaluation/legalPoolOwnership.ts`                   | this repository                                                    | Family → chunk owners, the nine keyword batches and the three qualified-evidence rows. A vocabulary entry outside every batch fails `npm test`.                                                                                          |

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

## Regenerating and checking

```sh
MCP_DATA_DIR="$HOME/.mtg-edh-mcp/cards" node scripts/legal-pool-census.mjs           # rewrite
MCP_DATA_DIR="$HOME/.mtg-edh-mcp/cards" node scripts/legal-pool-census.mjs --check   # compare
```

The generator bundles the TypeScript owner with esbuild into `build/`, opens
the served snapshot read-only, reads the published rules manifest and never
reaches the network. `src/evaluation/legalPool.test.ts` always checks the
ownership table, the digest convention against the frozen Reclamation Sage
record, the fixture classification and baseline drift reporting; when a served
data root exists it also regenerates the census and requires equality with the
committed files.

A new snapshot changes the ledger, the pool digest and usually the keyword
tables. Review the diff, assign any new vocabulary to a batch (the test fails
until you do), file requalification work for changed identities, then commit
the regenerated files as a new version. Do not edit the generated files by
hand and do not narrow the denominator to make a report look better.
