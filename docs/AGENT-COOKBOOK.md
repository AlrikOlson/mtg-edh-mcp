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

## Normalize construction goals

Use `construction_spec` before choosing cards. It accepts an empty request,
a theme, a command zone, a partial library or a saved `deck_id`, without
creating or changing a deck. These are illustrative tool calls:

```text
construction_spec {}
construction_spec {"request":{"schema_version":1,"theme":"Artifact recursion"}}
construction_spec {
  "request":{
    "schema_version":1,
    "commanders":["Atraxa, Praetors' Voice"],
    "command_zone_kind":"single",
    "theme":"Counters",
    "cards":[{"oracle_id":"Sol Ring","qty":1},{"oracle_id":"Forest","qty":6}],
    "budget":{"mode":"target","usd":150},
    "lands":{"min":35,"max":38,"strength":"preferred"},
    "roles":{"ramp":{"min":10,"max":14,"strength":"preferred"}}
  }
}
```

Card references accept exact indexed names or Oracle IDs, including the
`oracle_id` input fields. Unknown or ambiguous names require a choice; the tool
does not substitute fuzzy matches. The version-1 result contains
`specification`, `diagnostics`, `choices` and
`unresolved_requirements`. Respond to `needs_choices` by reviewing the supplied
options and making another request with the chosen values. A `conflict` needs
the conflicting inputs corrected; diagnostics identify their paths. Hard
constraints are never silently relaxed. Review
`specification.preferred_relaxations` before accepting a suggested tradeoff.

Budget modes are deliberate: an omitted budget inherits
`intent.soft.spend_target_usd`, including saved intent, as a target or stays
`unspecified` when none exists. `unspecified` does not mean unlimited;
`{"mode":"unbounded"}` explicitly removes a spending bound,
`{"mode":"cap","usd":150}` sets a hard ceiling, and
`{"mode":"target","usd":150}` expresses a preferred estimate. Caps and targets
require an amount. `include_companion` defaults to `false` and controls whether
the budget includes the outside-deck companion. Price availability and actual
purchase cost still need downstream checks.

Land and role ranges carry `strength: "hard"` or `"preferred"`. Role membership
can overlap: a card contributing to ramp and draw occupies one library slot.
`requirements` retain authored prose and its strength; `strategy_dependencies`
can name prerequisite cards and roles. Unsupported or unproved requirements
remain in `unresolved_requirements`, rather than becoming claims of compliance.

Keep competing command zones explicit instead of silently selecting one:

```text
construction_spec {
  "request":{
    "theme":"Scry",
    "command_zone_alternatives":[
      {"commanders":["Eligeth, Crossroads Augur"],"command_zone_kind":"single"},
      {"commanders":["Eligeth, Crossroads Augur","Siani, Eye of the Storm"],"command_zone_kind":"partner"}
    ],
    "budget":{"mode":"unbounded"}
  }
}
```

The supported kinds are `single`, `partner`, `background` and
`doctor_companion`; candidates retain their own validation results. Set the
chosen `commanders` and `command_zone_kind` in the next request. One command-zone
card leaves 99 library slots; a legal pair leaves 98. Remove
`command_zone_alternatives` when supplying a selected command zone. A `companion`
is a separate card reference outside the 100, not a third commander or a library slot.
Companion restrictions still require evaluation against the eventual deck.

To continue a saved build, read its current version, then normalize it with
`deck_id`. Replace the illustrative version `3` with the returned version:

```text
deck_get {"deck_id":"DECK_ID"}
construction_spec {"deck_id":"DECK_ID","expected_version":3}
construction_spec {"deck_id":"DECK_ID","expected_version":3,"request":{"budget":{"mode":"cap","usd":150},"edit_bounds":{"max_additions":10,"max_removals":10}}}
```

Saved cards and intent are reused; `specification.source` records the source
deck version, card snapshot and intent snapshot. A version conflict requires a
fresh read before retrying. Supplying a different `request.cards` baseline with
`deck_id` returns `SAVED_SEED_OVERRIDE_CONFLICT`; use a request without `deck_id` for a separate
hypothetical list. Existing cards are seeds that remain editable,
unless protected by explicit intent or edit bounds; their presence alone does
not lock them. The call does not save its request back to deck intent.

Edit bounds count physical card copies: `max_additions` and `max_removals`
limit each direction, while `max_changes` limits their sum. Replacing one
card uses one removal and one addition, including a saved commander or companion replacement.
Saved hard `change_limit` constraints remain binding. Normalization checks
necessary edit counts; the availability of suitable replacements still needs
candidate search.

`ready` means normalization has no blocking choices or conflicts. It is not a
completed deck, a card search, or proof that a feasible 100-card solution exists.
Use `card_discover` or `card_search` for candidates, then normal deck mutations
and `validate_deck`, `meta_check_policy` and budget checks to evaluate the result.

## Preview and apply a complete deck

Use `deck_plan_preview` when you have selected the entire final library. It
supports new builds, completing a partial list, imports and revisions with the
same contract. Here is a deliberately simple complete list for trying the flow;
choose an appropriate full library for an actual deck:

```text
deck_plan_preview {
  "input":{
    "name":"Marwyn complete-list example",
    "request":{
      "commanders":["Marwyn, the Nurturer"],
      "command_zone_kind":"single",
      "cards":[{"oracle_id":"Forest","qty":99}],
      "budget":{"mode":"unbounded"}
    }
  }
}
```

`input.request.cards` is required and replaces the whole library. Quantities
are additive for repeated references and normalized to Oracle IDs; commanders
are separate and a companion remains outside the 100. A saved source additionally
requires `deck_id` and its current `expected_version` at the top level.
Omitted commanders, companion, name, intent and role overrides inherit the saved
choices. Use `companion:null` to remove a companion. Saved hard intent cannot be
weakened inside a plan; change it explicitly through `deck_set_intent` first.

Review `desired`, `diff` and `validation`. The portable `plan` also carries
this review evidence, the request, and expected deck/data bindings. No deck,
snapshot, receipt or inventory allocation is saved by preview. Invalid or
unsupported proposals return `PLAN_INVALID` with diagnostics and remain
unapplied. Budget omission remains a choice; select a cap, preferred target or
explicit unbounded budget. Hard caps include commanders and optionally the
companion, and unknown prices block a cap. Hard counts, exclusions, protected
quantities and edit bounds must hold for the complete result. Unproved companion
conditions, hard prose, policy or role requirements remain blocked. Preferred
requirements retain advisory findings.

After reviewing the result, call `deck_plan_apply` with
`{"plan": <the exact returned plan object>}`. Apply rechecks complete legality,
hard constraints, source version and the served card-data revision. Changing
card data on the same date also invalidates an unapplied plan. A stale plan
requires a fresh preview; application never searches for substitutions.

A successful new build starts at version 1. Revising a saved deck increments
its version once and returns `snapshot_id`; `deck_restore` restores all
supported pre-change deck state with a new version. The deck, snapshot and
receipt commit together. Repeat the identical apply after a connection failure:
`replayed:true` returns the original receipt without another mutation, even
after restart, subsequent editing, restoration or deletion. The returned deck
on a replay is historical; use `deck_get` for current state. Preview again for
an intentionally separate new deck. Receipts remain in durable user state.

The plan digest checks payload consistency; it is not an authorization token.
The MCP mutation call remains the explicit application step. Session binding
and store ownership prevent accidental cross-session use. Inventory revisions
are reserved for future allocation support: a non-null binding is rejected.
Plan data revisions are lazily hashed from the served SQLite image and cached;
the first plan after opening or changing that image has a one-time cost
proportional to index size.

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
deck remains `not_evaluated` in the intent storage view. Use `meta_check_policy`
for supported policy and construction checks. Rules legality is always independent.

`analyze_role_coverage` and `deck_status` overlay saved role targets on their
heuristic Commander defaults; explicit analysis `bands` override this view.
Clearing a role target restores its default without changing card role
overrides. Spend targets are exposed for planning and are advisory; pass an
explicit `target_usd` to `budget_plan` to evaluate a price target.
Intent survives restart, snapshots and restore, is session-scoped, and appears
in `deck_get`, the deck resource and `deck_diff.metadata.intent`. Text decklist
exports contain cards only; use deck state/snapshots to retain intent.

## Check declared playgroup policies

Save structured declarations in `intent.playgroup`, then evaluate them separately
from `validate_deck` and the heuristic `meta_classify_bracket` estimate:

```text
deck_get_intent {"deck_id":"DECK_ID"}
deck_set_intent {"deck_id":"DECK_ID","expected_version":4,"action":"patch","patch":{"playgroup":{"profile":"thematic","bracket":3,"limits":{"tutors":1,"fast_mana":0}}}}
meta_check_policy {"deck_id":"DECK_ID","expected_version":5}
```

Use actual returned versions. Profiles (`casual`, `thematic`, `competitive`,
`custom`) state advisory goals; they do not infer a bracket or numeric score.
The optional `bracket` selects pinned published restrictions. Optional integer
`limits` (0–100) override category maxima for `game_changers`, `tutors`,
`fast_mana`, `extra_turns`, `mass_land_denial` and `infinite_combos`.
Overrides are identified as custom playgroup decisions. Setting an override to
`null` in a merge patch restores the published default; removing `playgroup`
removes the declaration.

The report returns `compatible`, `incompatible` or `unknown` for declared
constraints, with individual findings, card identities, combo evidence and
source versions. Combo observations are bounded by `limit` (default 20, maximum 200)
per finding; `combo_candidate_count` and `combo_candidates_truncated` expose omitted
evidence. Evaluation counts all observed packages before truncating: variants sharing
canonical ingredient identities and quantities count once. `compatible` does not certify deck quality, bracket suitability,
timing or legality. Hard exclusions, locked quantities and commander constraints
remain structured construction inputs; favorites and theme goals stay advisory.
An excluded or protected-card conflict requires revising the constraints or deck,
not silently cutting a protected card. Free-text preferences are retained but
never translated into hidden bans.

Published restrictions are pinned to the [October 21, 2025 update](https://magic.wizards.com/en/news/announcements/commander-brackets-beta-update-october-21-2025)
and [February 9, 2026 clarification](https://magic.wizards.com/en/news/announcements/commander-brackets-beta-update-february-9-2026),
with the [original bracket definitions](https://magic.wizards.com/en/news/announcements/introducing-commander-brackets-beta).
Tutors have no official numerical cap. Intentional two-card combos, early wins
and extra-turn chaining require context the deck list cannot establish; a custom
infinite-combo limit concerns detected packages, not proven execution.

Game Changer evidence uses positive flags from the installed Scryfall snapshot.
Missing or legacy false flags and unknown publication age prevent certifying
absence. Role/text classifications are incomplete review evidence; explicit
published examples are distinguished. Spellbook failures, stale observations
and non-exhaustive coverage never become proof of no combos. Combo lookup sends
card names to Spellbook only when a bracket 1–3 or custom combo restriction needs
it; other policy checks use local data.

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

## Explain the actual deck's strategy

Use `analyze_strategy` after saving the command zone, library and build intent.
It runs entirely on the installed card snapshot, without recommendation providers,
and returns `deck_version`, `strategy_version` and `data_snapshot` for comparison.

```text
deck_get_intent {"deck_id":"DECK_ID"}
analyze_strategy {"deck_id":"DECK_ID"}
analyze_strategy {"deck_id":"DECK_ID","expected_version":3}
```

An optional `expected_version` rejects a stale read with the same conflict shape as
`deck_get_intent`. The report does not change the deck. All commanders and the
library contribute; the outside-the-deck companion does not. Node quantities
count copies, while redundancy counts distinct card identities.

The initial edge catalog covers compatible token sacrifice/tapping, draw,
lifegain, discard, sacrifice, death and token-created payoffs, self-mill/discard
supply for unfiltered graveyard use, and compatible counter-removal resources.
Other mechanics can still appear as node evidence while their relationships
remain unmodeled. The ten contrast fixtures are synthetic Oracle-text regression
pairs, not a measured precision or coverage claim for the live card pool.

Analysis considers up to 250 distinct card identities and 32 annotations per card.
Presentation returns at most 500 edges, 200 resource conflicts and 100 edge
references per game-plan motif. `coverage` reports analyzed totals and truncation;
provider counts use all analyzed matches even when edges are omitted from display.
Missing cards or truncated analysis make zero/one-source dependencies
`unknown_incomplete`, with `provider_search_complete:false`. A `not_modeled`
dependency has a mechanic or filter outside the graph catalog. Raw node mechanics
retain their own extraction coverage; extracted text is not automatically a
supported graph relationship.

Read `game_plan` alongside `dependencies`, `bottlenecks` and `redundancy`.
A missing local provider means that this catalog found no support in the deck;
it does not prove that the card is unplayable. A single source identifies a fragile
dependency, and multiple sources identify possible redundancy, without promising
that they are available at the same time. Every `edges` entry contains both
mechanic annotations, with exact Oracle source spans, face and ability addresses,
and requirements that remain to be checked.

`declared_intent` preserves authored goals, strategy, constraints and role targets.
Node role evidence distinguishes the classifier from user overrides; protected
quantities and favorites stay visible. Free-text goals are not mechanically
proved or silently replaced with a popular commander archetype.

`recovery_options`, `conflicts` and `win_condition_requirements` describe candidate
recursion, possible resource competition and requirements for supported payoff
routes. They do not certify an executable loop, a win rate or a power level.
For external combo variants and their starting zones, mana and prerequisite
text, call `meta_combos` separately. Check `coverage` and `limitations`: omitted
or unmodeled interactions are unknown, and alternate faces, triggers, targets,
mana payment and actual game state still require contextual review.

## Cite rules and rulings verbatim

The rules tools answer from a local, versioned copy of the Comprehensive Rules
and Scryfall's rulings export. Nothing is stored until you call
`rules_refresh`; every rules response carries `corpus` with the release URL,
SHA-256 digest, effective date, retrieval time and a `status` of `current`,
`stale` or `unavailable`.

```text
rules_refresh {}
rules_search {"query":"commander color identity","section":"903","limit":5}
rules_lookup {"rules":["903.4","903.5c"],"glossary":"Color Identity"}
card_rulings {"cards":["Rhystic Study","Dockside Extortionist"],"source":"wizards_ruling"}
```

`rules_search` requires every query word and returns bounded excerpts; read the
full text with `rules_lookup` before quoting it. A lookup can name a chapter
(`9`), a section (`903`), a rule (`903.5`) or a subrule (`903.5a`). Unknown
identifiers come back with `status: "unknown"`, the reason and the `nearest`
existing prefix. Rule numbers change between releases, so cite the corpus
`effective_date` alongside any number.

`card_rulings` resolves names to Oracle identities and returns each ruling's
raw `source` and a `source_type`: `wizards_ruling` (official) or
`provider_note` (Scryfall's own note). `rulings_status` distinguishes
`recorded`, `none_recorded` (the export lists nothing for that card) and
`unavailable` (no rulings corpus stored). These tools return text, never a
verdict: legality stays with `validate_deck`, and interactions are for the
assistant to reason about with the quoted rules in view.

## Discover candidates from the installed pool

`card_discover` searches local cards without EDHREC, Spellbook or Game Changer
requests. Start with a supported theme (returned in `supported_themes`), explicit
`card_mechanics` pattern IDs, or a local `oracle_query`. Theme expansions are
retrieval hints; inspect the returned spans before judging contribution to a deck.

```text
card_discover {"deck_id":"DECK_ID","theme":"sacrifice","limit":20}
card_discover {"mode":"commanders","theme":"scry","include_pairs":true}
card_discover {"mode":"commanders","theme":"explore","oracle_query":"(o:explore or o:explores)"}
card_discover {"commanders":["Eligeth, Crossroads Augur","Siani, Eye of the Storm"],"theme":"scry"}
```

Card mode excludes the selected command zone, companion, existing library and
saved hard exclusions. It intersects explicit colors, saved intent colors and
the actual command-zone identity. Commander mode honors saved allowed/required
commander IDs and validates each proposed single or pair through the shared
rules. One member of a legal pair may match while the other provides no thematic
evidence. `color_identity:[]` means colorless only.

When mechanics and a query are both supplied, both must match. Local `o:`
search uses complete FTS tokens/phrases: include inflections explicitly, such
as `(o:explore or o:explores)`. Unknown themes return `needs_query` unless
an explicit query or supported mechanic is supplied. A fallback is reported;
free text is never silently treated as a known strategy.

Results carry `data_snapshot`, `deck_version`, `discovery_version` and
`extractor_version`. The default scan and pair-check bounds are 50,000 each
(maximum 100,000), with at most 50 results and eight mechanic spans per card.
Read `truncation`, exclusion counts and evidence truncation flags. These are
candidates from the evaluated portion of the installed pool, not proof that
no other useful cards exist. The tool makes no edits; use normal deck version
checks when applying choices. Pregame color choices are not inferred.

Locked quantities, change limits, full playgroup/package restrictions and soft
goals still need whole-deck evaluation (`meta_check_policy`). The curated
[14-task benchmark](evaluation/discovery-corpus.json) measures retrieval against
42 sourced cards plus 240 irrelevant distractors; it is not a live-pool quality
or precision guarantee.

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
`meta_classify_bracket` and applicable `meta_check_policy` combo checks may do so too. EDHREC-backed tools query an unofficial
service. Use local tools when the user wants to keep deck contents local.

## Inspect combo prerequisites

`meta_combos {"deck_id":"DECK_ID","include_almost":true,"limit":20}` returns
provider candidates with the saved `deck_version`. Read each candidate's
`applicability` before recommending changes:

- `listed_pieces_present` checks required quantities against canonical cards.
- `deck_configuration` checks quantities, designated commanders and supplied
  face indices. A commander-required card in the library fails this check.
  Templates, missing evidence and prerequisite prose can leave it unknown.
- `setup_prerequisites` and `executable_now` remain unknown. A deck list cannot
  establish current zones, untapped state, mana, timing or successful execution.

The `uses`, `requires` and `outputs` records retain quantities and provider
evidence; `mana_needed`, prerequisites and `steps` retain setup instructions.
`used_face` is the provider's one-based face index; resolved applicability
links it to the canonical zero-based face and source path. Null and
`missing_fields` expose unavailable evidence. Follow `url` to the variant.

`provider_category` preserves Spellbook's inventory classification. The default
also includes candidates needing a commander change; `include_almost` adds
missing-copy and color-change categories. Those labels do not validate the
deck's color identity or prove that a template is satisfied. The provider's
[find-my-combos implementation](https://github.com/SpaceCowMedia/commander-spellbook-backend/blob/master/backend/spellbook/views/find_my_combos.py)
and [variant serializer](https://github.com/SpaceCowMedia/commander-spellbook-backend/blob/master/backend/spellbook/serializers/variant_serializer.py)
define these source fields.

Counts describe received provider buckets before the local result limit.
Check `coverage`, `truncated`, `unresolved_oracle_ids` and `freshness`; complete
response coverage still comes from a non-exhaustive catalog. Failed or malformed
refreshes serve marked stale evidence when cached; cold failures report
`UPSTREAM_UNAVAILABLE`. An empty list never establishes combo absence.
`meta_classify_bracket` exposes the same limits through `combo_evidence` and
`provisional`. Its supported candidates require two physical copies and an
explicit infinite/win outcome; unparsed prerequisites stay unknown. Mana value
remains an advisory earliness proxy. Use `validate_deck` after edits.

## Read the reasons behind advice

`meta_recommend {deck_id}` defaults to local contextual ranking with no provider
request. It scans the installed card pool (within `scan_limit`) and considers
every commander, actual library support, missing roles, redundant support,
curve and saved intent. `theme` adds a supported annotation-match preference;
`oracle_query` narrows the pool or provides a fallback for unfamiliar strategies.
Read each suggestion's evidence, unmet requirements, tradeoffs and uncertainty;
no score establishes win rate, executable sequencing or objective power.
Full-pool ranking can take several seconds. A smaller `scan_limit` reduces work
but may miss stronger cards later in the scan; inspect `coverage.scan_truncated`
and avoid comparing scores across different scan coverage.

Use `expected_version` to tie advice to a reviewed deck version. No recommendation
changes the deck; a deck change during optional enrichment returns a conflict.
Prospective one-card additions check identity, legality and declared hard/policy
constraints. When several protected cards are missing, a recommendation may
reduce that deficit while reporting the remaining requirements as failed; this
is construction progress, not full compliance. Complete decks still require a
compatible cut; unknown policy or companion coverage cannot certify a legal
finished plan.

`provider: "edhrec"` adds observations for each commander separately and tolerates
provider failures without changing local scores. Each metric preserves its
`provider_field`, `value`, `scale` and `source`: current `num_decks` and legacy
`inclusion` are counts, commander `synergy` is a proportion difference, and raw
`lift` has an explicitly unknown scale. Missing metrics are absent observations,
not zero. These separate profiles do not model a partner combination.
Explicit `rank: "synergy"` or `"inclusion"` keeps the legacy primary-commander
profile modes; `min_inclusion` applies only there. Those modes still require
EDHREC and do not provide the contextual analysis.

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

| Prompt                 | Arguments                                              |
| ---------------------- | ------------------------------------------------------ |
| `build_commander_deck` | optional `commander`, `theme`, `budget_usd`, `deck_id` |
| `tune_deck`            | `deck_id`                                              |
| `fit_budget`           | `deck_id`, `target_usd`                                |

Prompt arguments are **strings**, including numeric budgets. Numeric budget
arguments on tools are numbers.

Tools advertise `readOnlyHint` and `openWorldHint`, and mutators declare
destructive and idempotency hints. These describe intended behavior; they do
not grant authorization or replace the user's preferences. Read-only live
tools may send data upstream or populate caches. A disabled background
refresh scheduler does not disable network tools.
