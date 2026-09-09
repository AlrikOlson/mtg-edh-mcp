# Session and recovery

## Data and evidence

`data_status.has_index` must be true for card operations. An authorized first-run setup or data refresh can call `data_ingest`; it downloads roughly 700 MB and returns immediately. Poll `data_status.ingest` until `done` and `has_index:true`, then refresh `tools/list` on the same connection. `already_running` means observe the existing job. On `error`, address its reported cause before one retry; do not repeatedly start ingestion. `force:true` rebuilds even unchanged upstream data. A failed refresh preserves the served snapshot.

Use `structuredContent`, or its equivalent JSON text fallback. Read `isError` separately from successful envelopes carrying `ok:false`, `conflict`, or per-item failures. Preserve `data_snapshot` and returned deck versions with conclusions. A dataset date is not a price observation time or proof of current rules. HTTP sessions require explicit re-listing and re-reading after changes; they have no subscription notifications.

Local card search, discovery, mana analysis and contextual `meta_recommend` work without recommendation providers. EDHREC tools can request unofficial upstream data. `meta_combos` sends card names to Commander Spellbook; bracket classification and applicable policy checks may do so too. Honor a request to keep contents local by selecting local tools and reporting unavailable external evidence. Tool annotations describe behavior, not authorization.

## Mutations and retries

Carry the latest `expected_version` wherever a tool supports it. On conflict, re-read the deck and reassess the proposed operation; never just replace the version on an obsolete edit. An interrupted response can hide a successful commit.

| Observation                                        | Next action                                                                                                                                                            |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `failed[]`, `missing[]`, or `unresolved[]`         | Inspect each entry. Choose an exact name/Oracle ID from candidates or correct it. Successful batch/import entries may already be applied; retry only the missing work. |
| `UNKNOWN_CARD` or `AMBIGUOUS_NAME`                 | Resolve the affected reference explicitly; do not silently choose a fuzzy suggestion.                                                                                  |
| `INVALID_QUERY`                                    | Read the error position and supported examples; simplify the actual query before retrying.                                                                             |
| Rejected addition                                  | Read violations. Select a compliant edit; `force:true` is only for an intentional user-authorized illegal experiment.                                                  |
| `UPSTREAM_UNAVAILABLE`                             | Use local evidence if sufficient; report missing enrichment. Retry only after a relevant external condition changes.                                                   |
| `STORAGE_ERROR`                                    | Treat as failed/uncertain, inspect recovery guidance and current state. Do not delete stores or locks to force progress.                                               |
| Lost response to add/remove/import/create/snapshot | Read current state before retrying; repeating may mutate again.                                                                                                        |
| Lost response to `deck_plan_apply`                 | Retry the identical returned plan. A durable `replayed:true` receipt is historical; `deck_get` gives current state.                                                    |
| Plan hash/session/data/version conflict            | Obtain a new preview from current state. Do not modify the returned plan to bypass a binding.                                                                          |

Use `deck_snapshot` for a reversible experiment and retain its ID. `deck_diff` reviews the change; `deck_restore` writes the snapshot state with a new version. `deck_delete` permanently discards a deck and is not an undo operation. Exported quantity/name text is not a backup of intent, role overrides, or receipts.
