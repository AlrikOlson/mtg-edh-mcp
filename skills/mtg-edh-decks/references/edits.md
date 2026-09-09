# Safe state changes

## Atomic complete plans

`deck_plan_preview` takes `input:{name?,request:{cards:[...]}}`. The cards are the complete final library, not a delta. Keep commanders separate; repeated references add quantities. Existing-deck previews additionally require top-level `deck_id` and current `expected_version`; omit both for a new deck. Omitted commander/companion/name/intent/role metadata inherits from saved state; explicit `companion:null` clears it. Inventory revision binding is unsupported.

Read `desired`, `diff`, `validation` and unresolved findings. A valid preview saves no deck, snapshot or receipt. `PLAN_INVALID` has no applyable change; correct the proposal rather than forcing it. When application is authorized, call `deck_plan_apply {plan: <exact returned object>}`. Do not reconstruct the plan, change its payload, or treat its digest as an authorization credential.

Apply rechecks final constraints, deck version, session and served data revision, including same-date data changes. Conflicts need current state and a fresh preview, not a patched binding. A revision writes once and returns a restore snapshot; a new deck starts at version 1. Exact retries return the original durable receipt without reapplying, even after later edits or deletion. `replayed:true` contains historical state: read `deck_get` for the current deck. A fresh preview is needed for an intentionally separate creation.

## Incremental operations

| Operation            | Correct use and verification                                                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `deck_create`        | Start an authorized saved draft. Its commander shortcut computes identity but does not validate the zone.                              |
| `deck_set_commander` | Validate and assign the single/pair zone; check `ok` before using its identity for searches.                                           |
| `deck_set_companion` | Set/clear the outside-deck card; finish with full companion validation.                                                                |
| `deck_add`           | Names/IDs, singular or batches with quantities. Inspect both resolved `verdicts[]` and unresolved `failed[]`.                          |
| `deck_remove`        | Remove specified copies; repeated requests can remove more. Inspect failures and returned version.                                     |
| `deck_rename`        | Change the title with a current version guard.                                                                                         |
| `deck_import`        | Text creates a deck or adds to supplied `deck_id`; it never replaces the list. Inspect `unresolved[]`, assign the commander, validate. |
| `deck_export`        | Return quantity/name text. Does not preserve intent, role overrides or printing selections.                                            |
| `deck_snapshot`      | Save the checkpoint ID before an experiment. Do not blindly repeat after a lost response.                                              |
| `deck_diff`          | Compare a checkpoint with current state or another snapshot before deciding on rollback.                                               |
| `deck_restore`       | Restore the selected checkpoint; this is a new mutation with an increased version.                                                     |
| `deck_delete`        | Permanently discard the identified deck only when deletion is within user authorization.                                               |

Use `expected_version` where supported: add/remove, rename, commander, companion and role changes. Do not invent that argument on tools without it. After conflict or uncertain transport, read current state and reassess; retry only unapplied work. Batch and import successes survive unrelated unresolved entries. Use `force:true` on additions only for a specifically authorized illegal experiment, never to satisfy a normal build request.

For a committed result, use `validate_deck` for full legality, `deck_status` for standing and any relevant mana/role/strategy/policy checks. Read exact violation counts as well as capped lists. A complete list may still have unknown budget or policy evidence. Preserve unrelated user changes and report the actual final version.
