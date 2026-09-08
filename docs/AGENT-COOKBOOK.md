# Agent cookbook

Use this server to search card data, maintain deck state, and test a
deckbuilding idea. Strategy remains with the user and assistant. The live
`tools/list` schemas are the reference for exact argument and response shapes;
tool descriptions include USE / NOT / FLOW / ARGS / RETURNS guidance.

## Start a session

Call `data_status` to confirm `has_index: true`, then `deck_list` to find
existing builds. If there is no index, follow the
[first-run flow](./INSTALL.md#starting-without-an-index). Avoid creating a new
deck every time the conversation resumes.

Structured tool results include `data_snapshot`, the date of the underlying
card-data snapshot. Read `structuredContent`, not only the short text summary.

## Build and iterate

These are illustrative tool calls, not a JSON file. Replace `DECK_ID` with
the ID returned by `deck_create`.

```text
deck_create {"name":"Atraxa Counters"}

deck_set_commander {
  "deck_id":"DECK_ID",
  "commanders":"Atraxa, Praetors' Voice"
}

card_search {
  "query":"id<=wubg t:creature o:proliferate mv<=4",
  "limit":20
}

deck_add {
  "deck_id":"DECK_ID",
  "cards":["Sol Ring","Arcane Signet",{"card":"Forest","qty":6}]
}

deck_status {"deck_id":"DECK_ID"}
```

Check `deck_set_commander.ok` before adding cards. The returned color identity
scopes subsequent searches. `deck_create` can also take `commanders` directly,
but that shortcut does not validate the command zone; use `deck_set_commander`
or `validate_deck` to check it.

Repeat additions and `deck_status` as needed. Content-changing deck operations
return `vitals`: card count including the command zone, land count, color
identity, legality, and version. `deck_status` adds detailed legality, curve,
mana, role gaps, and pricing. Use `deck_get` when you need the actual list.

Finish with `validate_deck` and inspect its errors before `deck_export`.
A count of 100 alone does not establish legality. Role targets, mana-source
thresholds, and bracket classifications are advisory.

## Make edits safely

- **Read each batch result.** `deck_add` returns `verdicts[]` for resolved cards
  and `failed[]` for unresolved inputs. Successful entries can apply even when
  others fail. Retry only the failed or rejected entries.
- **Preserve a checkpoint.** Use `deck_snapshot` before an experiment. Save
  its `snapshot_id`, review `deck_diff`, and use `deck_restore` to return to it.
  Restore changes the deck and advances its version.
- **Carry the version.** Pass `expected_version` where supported: add, remove,
  rename, commander, and companion changes. A conflict applies no mutation.
  Re-read the current deck, reassess the edit, then retry with its version.
- **Avoid blind retries.** Add, remove, import, create, and snapshot operations
  can change state again when repeated. After an uncertain network result,
  read the current state before replaying the request.
- **Treat import as an addition.** `deck_import` with `deck_id` merges quantities
  into that deck; it does not replace the list. Without `deck_id`, it creates a
  new deck. Inspect `unresolved[]`, set the commander explicitly, and validate.
- **Export is a decklist.** `deck_export` returns quantity/name text. It does
  not preserve selected printing metadata or serve as a full snapshot backup.

`force: true` on `deck_add` permits rule-breaking cards with an illegal flag.
Use it only for an intentional experiment agreed with the user.

## Find cards without filling the context

`card_search` returns lean card references. Use `card_get` to inspect the
chosen names or IDs; set `compact: true` for larger batches. Request
`include_printings: true` or `card_printings` only when comparing printings.

```text
card_get {"cards":["Sol Ring","Arcane Signet"],"compact":true}
```

The query language supports text (`o:`, `t:`, `kw:`), comparisons (`mv<=3`,
`usd<5`), color identity (`id<=wubg`), printing predicates (`set:`, `rarity:`,
`year`), boolean grouping, negation, `is:commander`, and `is:gamechanger`.
It is a subset of Scryfall syntax. Pass sorting as `order`, for example
`{"query":"t:land id<=wubg","order":"price","limit":25}`.

Use `next_cursor` with the same query and ordering to continue paginated
results. `card_search` permits up to 175 results per page; `collection_get`
defaults to 200. Other list tools have their own caps—check their schemas.
`card_printings` returns all printings of the selected card.

## Error recovery

| Result                              | Recovery                                                                                 |
| ----------------------------------- | ---------------------------------------------------------------------------------------- |
| `failed[]` with `UNKNOWN_CARD`      | Choose a suggestion or correct the input; retry only that entry.                         |
| `failed[]` with `AMBIGUOUS_NAME`    | Choose a candidate's Oracle ID.                                                          |
| `card_get.missing[]`                | Correct or explicitly resolve those names with `card_resolve_name`.                      |
| Import or collection `unresolved[]` | Review each unresolved name; successful entries may already be applied.                  |
| `INVALID_QUERY`                     | Read `details.position` and any examples, simplify the query, and retry.                 |
| `conflict: true`                    | Re-read state and reassess before retrying with the current version.                     |
| `verdicts[].status: "rejected"`     | Inspect `violations[]`; choose a legal card or an intentional forced experiment.         |
| `UPSTREAM_UNAVAILABLE`              | Continue with local search and analysis, and explain that the enrichment is unavailable. |

A `STORAGE_ERROR` is an MCP error, not a successful mutation. Check its recovery
guidance for lock contention, free space, permissions, or corrupted storage.
After an interrupted connection, re-read the deck before retrying: a commit
can succeed even when the response never reaches the client. Use
`expected_version` when supported. Automatic backups and offline restore are
documented in the [install guide](./INSTALL.md#user-data-backup-and-restore).

MCP `isError` results and successful results containing conflicts or partial
failures need separate handling. The error array names differ by tool.

## Budgets, collections, and live data

Start with `budget_plan`: cheaper printings can reduce cost without changing
the list. Use `meta_budget_swaps` for suggested replacements and review the
role match before applying them with remove/add operations. Prices are from
the local snapshot and exclude a seller's shipping, taxes, and availability.

`collection_set` replaces owned-card membership; `collection_add` extends it.
It tracks whether a card is owned, not quantities or particular printings.
The executable persists collections across restarts in the same data directory
and principal namespace. `owned_only: true` on `card_search`
only restricts results when the collection is nonempty; an empty collection
does not mean an empty search result.

`meta_combos` sends the deck's card names to Commander Spellbook.
`meta_classify_bracket` may do so too. EDHREC-backed tools query an unofficial
service. Use local tools when the user wants to keep deck contents local.

## MCP prompts and tool annotations

Clients that expose prompts can request these recipes:

| Prompt                 | Arguments                                            |
| ---------------------- | ---------------------------------------------------- |
| `build_commander_deck` | `commander`, optional `theme`, optional `budget_usd` |
| `tune_deck`            | `deck_id`                                            |
| `fit_budget`           | `deck_id`, `target_usd`                              |

Prompt arguments are **strings**, including numeric budgets. Numeric budget
arguments on tools are numbers.

Tools advertise `readOnlyHint` and `openWorldHint`, and mutators declare
destructive and idempotency hints. These describe intended behavior; they do
not grant authorization or replace the user's preferences. Read-only live
tools may send data upstream or populate caches. A disabled background
refresh scheduler does not disable network tools.
