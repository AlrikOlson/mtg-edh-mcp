# Agent cookbook

Use this server to search card data, maintain deck state, and test a
deckbuilding idea. Strategy remains with the user and assistant. The live
`tools/list` schemas are the reference for exact argument and response shapes;
tool descriptions include USE / NOT / FLOW / ARGS / RETURNS guidance.

## Start a session

Call `data_status` to confirm `has_index: true`, then `deck_list` to find
existing builds. If there is no index, call `data_ingest`, poll `data_status`
until ingestion is `done` and `has_index: true`, then request `tools/list`
again. You can search and build on the same connection; no restart is needed.
Older index formats also require `data_ingest` after an upgrade. The rebuild
publishes a new recoverable snapshot and preserves saved decks and collections.
An `error` is retryable after addressing its reported cause. See the
[first-run flow](./INSTALL.md#starting-without-an-index) and the read-only
`doctor` command for diagnostics. Avoid creating a new deck every time the
conversation resumes.

Structured tool results include `data_snapshot`, the date of the underlying
card-data snapshot. Read `structuredContent` when available; clients that consume
only text receive the same JSON in a text block. Both modern and older protocol
clients use the same tools. HTTP clients should re-list and re-read after changes;
HTTP does not offer subscription notifications.

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
  rename, commander, companion, and role changes. A conflict applies no mutation.
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

## Preserve build goals and constraints

Create a deck with `deck_create` even when no commander or cards are chosen,
then use `deck_get_intent` to read its version and defaults. Intent does not
require an EDHREC profile. Every `deck_set_intent` mutation requires the current
`expected_version`; a stale version returns a conflict without writing.

```text
deck_create {"name":"Artifact workshop"}
deck_get_intent {"deck_id":"DECK_ID"}
deck_set_intent {"deck_id":"DECK_ID","expected_version":1,"action":"set","intent":{"schema_version":1,"hard":{"locked_cards":[{"oracle_id":"Sol Ring","qty":1}],"excluded_cards":["Mana Vault"],"change_limit":10},"soft":{"goals":["Win with an artifact engine"],"strategy":"Artifact recursion","favorites":[{"oracle_id":"Myr Retriever","qty":1}],"role_targets":{"ramp":{"min":10,"max":14}},"spend_target_usd":100,"playgroup_preferences":["Long interactive games"]},"unsupported":["Guarantee a turn-five win"]}}
deck_set_intent {"deck_id":"DECK_ID","expected_version":2,"action":"patch","patch":{"soft":{"role_targets":{"ramp":null},"strategy":"Artifact tokens"}}}
deck_set_intent {"deck_id":"DECK_ID","expected_version":3,"action":"clear"}
```

Use returned versions after each write. `set` replaces the entire intent;
`patch` uses an object-shaped [JSON Merge Patch](https://www.rfc-editor.org/rfc/rfc7396.html):
omission retains fields, `null` removes them, nested objects merge and arrays
replace in full. `schema_version` must remain 1. `clear` removes all authored
intent. Legacy decks read as `intent: null`, with computed defaults rather than
invented preferences.

`hard` stores `locked_cards` minimum quantities across the 100-card deck,
`excluded_cards`, a `change_limit` for future change plans, and `commanders`
constraints: `allowed` candidates, `required` choices, and `color_identity`
as a permitted color set (`[]` means colorless). Missing constraints are open.
References in ID fields accept installed Oracle IDs or exact case-insensitive
card names, then persist canonical IDs. Partial names, unknown references,
duplicate quantities and contradictory hard requirements reject atomically
with diagnostics. Retained canonical IDs can survive a missing card index
during patches; new references require installed card data.

`soft` contains advisory goals, strategy, favorites (desired quantities),
role targets, a USD spend target and qualitative playgroup preferences.
Favorites may coexist with exclusions: the hard exclusion takes precedence
in future planning. `unsupported` records requirements the engine cannot
evaluate. These sections do not automatically add/remove cards, choose a
commander, enforce a playgroup policy or certify a build. Hard constraints
are checked for internal contradictions; their satisfaction by the current
deck remains `not_evaluated`. Rules legality is always independent.

`analyze_role_coverage` and `deck_status` overlay saved role targets on their
heuristic Commander defaults; explicit analysis `bands` override this view.
Clearing a role target restores its default without changing card role
overrides. Spend targets are exposed for planning and are advisory; pass an
explicit `target_usd` to `budget_plan` to evaluate a price target.
Intent survives restart, snapshots and restore, is session-scoped, and appears
in `deck_get`, the deck resource and `deck_diff.metadata.intent`. Text decklist
exports contain cards only; use deck state/snapshots to retain intent.

## Correct role labels

Use `deck_set_roles` for a card already in this deck (library, commander, or
companion). Labels replace the classifier's list for that card in this deck.

```text
deck_set_roles {"deck_id":"DECK_ID","card":"Sol Ring","roles":["ramp","mana_rock","combo_piece"]}
analyze_composition {"deck_id":"DECK_ID"}
analyze_role_coverage {"deck_id":"DECK_ID"}

deck_set_roles {"deck_id":"DECK_ID","card":"Sol Ring","roles":[]}
deck_set_roles {"deck_id":"DECK_ID","card":"Sol Ring","roles":null}
```

The first call preserves the mana roles and adds a deck-specific combo label.
`[]` deliberately assigns no roles; `null` removes the correction and restores
classifier defaults. Pass the current `expected_version` when coordinating
edits. Each response distinguishes `inferred_roles`, `effective_roles`, and
`role_source`. `deck_get.role_overrides` is stored under its returned `deck`.

Corrections persist with the deck, participate in snapshots and restore, and
feed composition, coverage, status gaps, and role-based advice. They do not
change global `card_get`/search labels, card types, or rules legality. Library
analyses still count library entries only, including each entry's quantity.
A correction for a removed card stays with the deck for later re-addition;
reset it by Oracle ID if its card data is no longer resolvable.

## Inspect card mechanics with evidence

`card_mechanics` reads the stored Oracle text of each face and returns only
the mechanics in its declared catalog: triggers, activation costs, effects and
standing permissions across sacrifice, tokens, counters, draw/discard,
graveyard, spellcasting, combat, lifegain and landfall.

```text
card_mechanics {"cards":["Mayhem Devil","Ashnod's Altar"]}
card_mechanics {"cards":"Korvold, Fae-Cursed King","deck_id":"DECK_ID","include_unmodeled":false}
```

Every annotation names its `pattern_id` (for example `cost.sacrifice_permanent`
versus `trigger.sacrifice`), the ability it belongs to, the `subject` whose
resources it concerns (`controller`, `opponent`, `each_player`,
`target_player`, `any_player`, `self`, `unknown`), a `condition`
(`unconditional`, or `conditional` with the supporting clause), an `optional`
flag for "you may", `explicit` or `inferred` provenance, the extractor
version, and an exact `evidence` span into the source Oracle field. Use the
span to quote the text back rather than paraphrasing it.

Text the extractor does not model is returned in `unmodeled` with a status of
`unmodeled` (outside the catalog) or `uncertain` (granted ability text,
unrecognized trigger events or cost elements, extra events of a compound
trigger). `coverage` counts abilities and sentences so you can tell a fully
modeled card from a partially read one. Treat an empty `annotations` list as
"nothing supported was found", never as "this card does nothing".

`roles` carries the same `inferred_roles`, `effective_roles` and
`role_source` fields as `deck_set_roles`; pass `deck_id` to overlay that
deck's corrections. The tool never changes roles, card data or legality, and
`legality` is always `not_evaluated`. Measured precision on the annotated
corpus is documented in `docs/evaluation/mechanics/README.md`.

## Find cards without filling the context

`card_search` returns lean card references. Use `card_get` to inspect the
chosen names or IDs; set `compact: true` for larger batches. Request
`include_printings: true` or `card_printings` only when comparing printings.

```text
card_get {"cards":["Sol Ring","Arcane Signet"],"compact":true}
```

Both full and compact `card_get` responses retain `gameplay`, the versioned
source evidence also returned by `card://{oracle_id}`. It carries the supplied
layout, Scryfall/Oracle identifiers, top-level `characteristics`, ordered
`faces`, and `related_cards`. Each face has a zero-based `face_index` and a
`source_path` JSON Pointer into the original card (`/card_faces/0`, or `""`
for a single face drawn from the root). Missing source values are `null`;
an explicitly empty mana cost or list remains empty. A missing or unsupported
layout does not imply a normal single-faced card. `gameplay.color_identity`
preserves the supplied whole-card identity separately from face colors.

For code consumers, `oracleTextEvidence(card, faceIndex, start, end)` returns
an exact Oracle substring, source field pointer and printing/Oracle identity.
Offsets are half-open UTF-16 code units in the unmodified source field; a null
face index selects root text. Missing text or invalid bounds return `null`.

Read `gameplay.faces` when the card has alternative faces or spell parts.
The existing flat `mana_cost`, `mv`, `type_line`, `oracle_text`, and roles are
compatibility projections for search and heuristic analysis. Joined face costs
and types do not establish a playable combination, and an absent face mana
value does not inherit another face's value. `produced_mana` describes possible
mana types, not how much mana is available or whether an ability can be used.
Do not count alternative faces as simultaneous lands, spells, or mana sources.
`face_relationship` labels the source layout; `playability: "not_evaluated"`
means this evidence does not determine castability, activation conditions,
zone-specific characteristics, alternative costs, or current mana availability.
See Scryfall's [card objects](https://scryfall.com/docs/api/cards) and
[layouts](https://scryfall.com/docs/api/layouts) for the source field semantics.

The query language supports text (`o:`, `t:`, `kw:`), comparisons (`mv<=3`,
`usd<5`), color identity (`id<=wubg`, also `ci<=wubg`), printing predicates (`set:`, `rarity:`,
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

## Read the reasons behind advice

`meta_recommend` explains each addition with inferred or corrected roles,
EDHREC synergy/inclusion evidence, tradeoffs, and the local one-copy price
impact. Compare those roles with the gaps returned by `deck_status`.
`meta_budget_swaps` explains both the outgoing
cut and its proposed replacement: matching roles, roles lost or gained, mana
value changes, and savings for the proposed quantity. These calls suggest
changes; they do not edit the deck. Review the evidence, take a snapshot, then
apply the returned quantities through `deck_remove` and `deck_add` and validate.

Role overlap is a heuristic, not functional equivalence. A swap may remove
protection, a combo piece, or another role your deck needs. Community inclusion
and synergy are population statistics, not a win-rate prediction; missing
metrics are marked unknown in the evidence. The
[EDHREC FAQ](https://edhrec.com/faq) describes its inclusion/synergy data and
update delays; its [methodology note](https://edhrec.com/articles/from-synergy-to-lift-the-math-behind-edhrecs-new-era)
distinguishes commander-page synergy from card-page lift.

The response source includes the EDHREC URL, cache fetch time and age, and
whether a failed refresh returned stale data. Fetch age describes this server's
cache; the upstream dataset's update time can remain unknown. `data_snapshot`
identifies local card data, while pricing timestamps may be unknown.

Budget reports separate `full_deck` (library plus every command-zone slot),
`library`, `command_zone`, and the outside-deck `companion`. Use
`budget_plan.full_deck`, `analyze_stats.budget.full_deck`, or
`deck_status.price.full_deck` for complete-deck value. Existing top-level
budget/stats price fields and `deck_status.price.total_usd/min_buy_usd`
retain library scope, explicitly labeled `price_scope: "library"`.
Card counts and mana statistics remain library statistics. Auxiliary zones
are not represented by the stored deck model; their cost is not included.
Stored extra copies across zones are counted and flagged, never silently
deduplicated. Pricing a deck does not certify its count or legality.

`meta_budget_swaps.target_met` compares the projected complete-deck estimate;
`current_full_deck` and `projected_full_deck` include commanders.
The existing `current_min_buy_usd/projected_min_buy_usd` fields retain library
scope. Proposals replace library cards only and do not deduct ownership.

All sums use integer USD cents internally. Numeric totals are known subtotals
when cards or prices are missing: inspect `coverage`, including unresolved
identifiers, quantities, and default/cheapest/acquisition coverage. A missing
required price makes the corresponding target comparison unknown, never a
zero-price success. `target_met` compares the observed estimate, not a checkout
quote. Price timestamps remain null and freshness unknown when the index has
no provider observation timestamp; `data_snapshot` is a separate dataset date.
A supplied observation timestamp reports stale coverage against a 24-hour
default age threshold. A set release date is not a pricing timestamp.

`full_deck.default_total_usd` estimates default-printing deck value;
`full_deck.min_buy_usd` estimates buying all copies at the cheapest indexed
nonfoil USD printing. Opting into `use_collection` adds
`full_deck.acquire_usd`, the estimated new spending under the existing
membership model: membership covers **all copies** of that oracle card,
including basics and commanders. It does not establish inventory quantities
or available copies. An absent/empty collection retains null acquisition
figures for compatibility. No sale proceeds are deducted.

[Scryfall prices](https://scryfall.com/docs/api/cards) are daily market
estimates. Fees, taxes, shipping, stock availability, condition and seller
minimums can change actual spending; these are not checkout quotes.

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
