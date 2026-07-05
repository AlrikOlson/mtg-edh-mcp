# Agent Cookbook

How an AI agent builds Commander decks against this server with the fewest
calls and the least context. The 41-tool surface is agent-first end to end;
this document is the condensed operating manual. (Tool-by-tool reference:
every description over `tools/list` follows a USE / NOT / FLOW / ARGS /
RETURNS template — read those first when in doubt.)

## The core loop (three tools)

A whole build fits in three tools. Card inputs are **names** (singular or
array — no id resolution round-trips), every mutation returns **vitals**
(no follow-up reads), and **`deck_status`** is the one-call dashboard.

```jsonc
// 1. Create + command zone (names are fine everywhere)
deck_create        { "name": "Atraxa Counters" }
deck_set_commander { "deck_id": "…", "commanders": "Atraxa, Praetors' Voice" }
// → { ok, computed_color_identity: ["W","U","B","G"], vitals: { card_count: 1, … } }

// 2. Add in batches — mixed names/ids, quantities inline
deck_add {
  "deck_id": "…",
  "cards": ["Sol Ring", "Arcane Signet", { "card": "Forest", "qty": 6 }]
}
// → {
//     verdicts: [ { oracle_id, name, status: "ok" | "rejected" | "added_illegal", violations? } ],
//     failed:   [ { input: "Sol Rng", reason: "UNKNOWN_CARD", suggestions: [{ name: "Sol Ring", … }] } ],
//     vitals:   { card_count: 9, land_count: 6, color_identity: […], legal: false, version: 3 }
//   }

// 3. Orient — one offline call, no analyze/validate fan-out
deck_status { "deck_id": "…" }
// → { vitals, legality: { ok, errors, error_count, warning_count },
//     curve: { buckets, avg_mv }, mana: { sources_by_color, under_supported },
//     roles: { gaps }, price: { total_usd, min_buy_usd } }
```

Repeat 2–3 until `vitals.card_count` is 100 and `legality.ok` is true, then
`validate_deck` for the authoritative gate and `deck_export` to share.

## Error recovery

| Signal                                        | Meaning                                                        | Recovery                                                                                |
| --------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `failed[]` entry, `reason: "UNKNOWN_CARD"`    | A name didn't resolve; the rest of the batch **still applied** | Pick from `suggestions[]` and re-add just that card                                     |
| `failed[]` entry, `reason: "AMBIGUOUS_NAME"`  | Name matched several cards                                     | Pick from `candidates[]` (oracle_ids included)                                          |
| Error `INVALID_QUERY`                         | Bad `card_search` grammar                                      | `details.position` locates it; `details.examples[]` shows valid queries                 |
| `{ conflict: true }`                          | Your `expected_version` is stale                               | Re-read (`deck_status`), retry with `current_version`                                   |
| Verdict `status: "rejected"` + `violations[]` | Card breaks identity/banlist/singleton                         | Swap the card, or `force: true` to add it flagged illegal                               |
| Error `UPSTREAM_UNAVAILABLE`                  | EDHREC/Spellbook down with nothing cached                      | Everything offline still works: `deck_status`, `analyze_*`, `validate_*`, `card_search` |

## What a harness may auto-approve

All 41 tools carry MCP annotations. The 27 with `readOnlyHint: true` never
mutate anything (`ping`, `data_status`, `card_*`, `collection_get`,
`deck_get/list/diff/export`, `deck_status`, `validate_*`, `analyze_*`,
`simulate_deck`, `budget_plan`, `meta_*`). `openWorldHint: true` marks the
six that reach the network (`data_ingest` + the `meta_*` family); everything
else answers from the local index. Mutators declare `destructiveHint` and
`idempotentHint` explicitly.

## Server-advertised recipes (MCP prompts)

Clients that surface prompts get the full workflows with arguments
interpolated — no docs needed:

- **`build_commander_deck`** `{ commander, theme?, budget_usd? }` — the whole
  build loop above, plus a mana pass and an optional budget pass.
- **`tune_deck`** `{ deck_id }` — gaps → recommend → swap → re-status →
  bracket.
- **`fit_budget`** `{ deck_id, target_usd }` — reprint savings first (zero
  deck changes), then role-matched swaps.

## Conventions worth internalizing

- **Names in, ids out.** Send card names; responses carry `oracle_id`s you
  can echo back verbatim when precision matters.
- **Trust `vitals`.** Every mutation response tells you where the deck
  stands (`card_count`/100 including the command zone, lands, identity,
  legality, version). Don't re-read after writes.
- **One typo never aborts a batch.** `deck_add`/`deck_remove` apply what
  resolves and report the rest in `failed[]`.
- **Everything lists with a limit.** Exact totals are always reported; pass
  `cursor`/`limit` where offered (`card_search`, `collection_get`).
- **`data_snapshot` on every response** is the card-data vintage the answer
  came from.
