# Commander Deckbuilder MCP — Design Specification

**Status:** Draft v1.0
**Scope:** An MCP server exposing primitive tools that let an AI agent construct *any* legal Magic: The Gathering Commander (EDH) deck — budget, casual, themed/tribal, jank/build-around, precon upgrade, or cEDH.

---

## 1. Design philosophy

The server is **not** a deckbuilder. It is the deterministic substrate a deckbuilder stands on. The agent supplies *strategy and taste*; the server supplies *ground truth, bookkeeping, computation, and validation*. Every design decision below follows from eight principles.

1. **Deterministic substrate, strategic agent.** There is no `build_deck` tool and no tool that makes a card-selection decision. Tools answer questions, mutate state, compute statistics, and validate. The creative/strategic layer lives entirely in the agent. This is what makes "any deck imaginable" possible — the server never constrains the *kind* of deck, only enforces the *rules* of the format.

2. **Everything is grounded.** No card can be referenced except by a canonical identifier resolved against real data. The agent physically cannot add a hallucinated card to a deck — `deck_add` accepts `oracle_id`s, and the only way to get one is to resolve a real name or run a real search. This single constraint eliminates the dominant failure mode of LLM deckbuilding.

3. **Composable, orthogonal primitives.** Each tool does exactly one thing and composes with the others. Search → resolve → validate-precheck → add → analyze → re-validate is a pipeline the agent assembles, not a workflow the server hardcodes.

4. **Stateful workspace.** A deck is a long-lived server-side object the agent mutates incrementally and queries cheaply. The agent is never asked to hold the whole 100-card list in context to operate on it.

5. **Local-first data plane.** Scryfall bulk data is ingested into a local indexed store. Search, color-identity computation, legality checks, and analysis all run locally and deterministically — no per-query network calls, no rate limits, reproducible results. The live API and EDHREC are reserved for enrichment (prices, synergy) and graceful fallback.

6. **Token economy by default.** Tools return lean references (id + name + the few fields needed) and expand only on request via explicit field projection. IDs travel between tools; full card blobs do not, unless asked for.

7. **Continuous, cheap validation.** The agent can ask "is this legal?" or "can this card go here?" at any point and get a structured, machine-readable answer. Validation is a first-class, low-cost operation, not an end-of-build gate.

8. **Fail loud and structured.** Errors are typed and actionable (`UNKNOWN_CARD`, `COLOR_IDENTITY_VIOLATION`, `AMBIGUOUS_NAME` with candidates). The agent can branch on error type without parsing prose.

---

## 2. Architecture

```
                 ┌─────────────────────────────────────────────┐
                 │                MCP Server                     │
   AI Agent ───► │  Transport (stdio | streamable HTTP)          │
   (MCP client)  │                                               │
                 │  ┌─────────────┐  ┌──────────────────────┐    │
                 │  │  Tools      │  │  Resources           │    │
                 │  │  (mutate +  │  │  card://{oracle_id}   │    │
                 │  │   compute)  │  │  deck://{deck_id}     │    │
                 │  └──────┬──────┘  └──────────┬───────────┘    │
                 │         │                    │                │
                 │  ┌──────▼────────────────────▼───────────┐    │
                 │  │  Core engines                          │    │
                 │  │  • Query (local Scryfall-grammar eval)  │    │
                 │  │  • Rules/Validation                     │    │
                 │  │  • Analysis (curve, composition, mana)  │    │
                 │  │  • Deck state (versioned)               │    │
                 │  └──────┬─────────────────────┬───────────┘    │
                 └─────────┼─────────────────────┼────────────────┘
                           │                     │
              ┌────────────▼─────┐    ┌──────────▼──────────────┐
              │ Local card index │    │ Enrichment (cached)      │
              │ (Scryfall bulk:  │    │ • Scryfall live API      │
              │  oracle_cards +  │    │ • EDHREC json.edhrec.com │
              │  default_cards)  │    │ • Commander Spellbook    │
              │  + FTS + JSON    │    │ • Bracket / Game Changers │
              └──────────────────┘    └─────────────────────────┘
```

**Resources vs. tools (MCP-idiomatic split).**
- **Resources** are read-only and addressable: `card://{oracle_id}` returns the canonical card object; `deck://{deck_id}` returns the current decklist. Clients can subscribe to `deck://` updates so a UI re-renders on mutation.
- **Tools** are everything that computes or mutates. Read-only computation (search, analysis, validation) is also exposed as tools because tools can take rich arguments; resources are reserved for stable addressable entities.

**Tool naming.** `namespace_action`, lowercase, underscore-delimited (e.g. `card_search`, `deck_add`, `validate_deck`) for maximum client compatibility. Grouped logically below.

**Transport.** Support both stdio (local/desktop agents) and streamable HTTP (hosted). State (decks) is keyed to a session/auth principal; bulk card data is shared and read-only.

---

## 3. Data ingestion & freshness

| Source | Cadence | Use |
|---|---|---|
| Scryfall `oracle_cards` bulk | every 12h | gameplay data: oracle text, MV, type line, **color_identity**, **legalities** |
| Scryfall `default_cards` bulk | every 12h | printings, set codes, images, collector data |
| Scryfall price fields | daily | USD/EUR/MTGO prices (refreshed once/day upstream) |
| EDHREC `json.edhrec.com` | daily, cached | synergy/inclusion %, salt, themes, average decks |
| Commander Spellbook | weekly, cached | combo database |
| Official bracket / Game Changers list | on change, cached | power-level classification |

**Rules:**
- Ingest replaces the live index atomically (build new, swap, drop old) so queries never see a half-loaded state.
- Every tool response includes `data_snapshot` (ISO date of the card index) so the agent and downstream consumers know the data vintage.
- Live Scryfall calls are a *fallback only* (e.g. a card newer than the last bulk swap) and are rate-limited at <2 req/s for search-class endpoints, ≥100 ms spacing otherwise, with a mandatory descriptive `User-Agent`.
- **The banlist is never hardcoded.** Commander legality is read from each card's `legalities.commander` field (`legal` / `banned` / `restricted` / `not_legal`). When the format's banlist changes, a bulk refresh propagates it automatically.

---

## 4. Canonical data model

**`CardRef`** (the lean currency that moves between tools):
```json
{ "oracle_id": "uuid", "name": "Sol Ring", "mv": 1, "ci": ["C"], "type": "Artifact" }
```

**`Card`** (full object, returned only by `card_get` / `card://` resource): all Scryfall gameplay fields — `oracle_id`, `name`, `mana_cost`, `mv`, `colors`, `color_identity`, `type_line`, `oracle_text`, `power`/`toughness`/`loyalty`, `keywords`, `legalities`, `prices`, `is_commander_eligible`, plus server-derived `roles` (see §7) and `printings[]`.

**`Deck`** (server state):
```json
{
  "deck_id": "uuid",
  "name": "Atraxa Superfriends",
  "format": "commander",
  "commanders": ["oracle_id", "..."],
  "command_zone_kind": "single | partner | background | doctor_companion",
  "cards": [ { "oracle_id": "uuid", "qty": 1 } ],
  "computed_color_identity": ["W","U","B","G"],
  "version": 7,
  "data_snapshot": "2026-06-27"
}
```

**`Violation`** (the unit of validation output):
```json
{ "rule": "COLOR_IDENTITY", "severity": "error",
  "card": {"oracle_id":"...","name":"Lightning Bolt"},
  "detail": "R not in deck identity WUBG", "fix_hint": "remove or change commander" }
```

---

## 5. Tool catalog

### A. Card knowledge

| Tool | Purpose |
|---|---|
| `card_search` | **The cornerstone primitive.** Evaluate a full Scryfall-grammar query against the local index. |
| `card_get` | Fetch full `Card` object(s) by `oracle_id` (batch). |
| `card_resolve_name` | Fuzzy/exact name → `oracle_id`; returns disambiguation candidates. The anti-hallucination gateway. |
| `card_printings` | All printings + per-printing prices/images for an oracle card. |

**`card_search` — why it carries the whole format.** Nearly every deckbuilding constraint reduces to a Scryfall query: functional (`o:"draw a card"`), typal (`t:dragon`), statistical (`mv<=2 pow>=4`), identity (`id<=wubg`), categorical (`is:manarock`, `is:dual`, `is:commander`), and arbitrary boolean combinations. Exposing the *full grammar*, evaluated locally, is what makes "any deck imaginable" tractable without bespoke tools per archetype.

```json
// card_search input schema (abridged)
{
  "type": "object",
  "required": ["query"],
  "properties": {
    "query":   { "type": "string", "description": "Scryfall query syntax, e.g. 'id<=wubg t:creature o:proliferate mv<=4'" },
    "deck_id": { "type": "string", "description": "If set, auto-constrains results to the deck's color identity and excludes cards already in the deck." },
    "fields":  { "type": "array", "items": {"type":"string"},
                 "description": "Field projection. Default returns CardRef only." },
    "order":   { "type": "string", "enum": ["name","mv","price","edhrec_rank","released"] },
    "limit":   { "type": "integer", "default": 25, "maximum": 175 },
    "cursor":  { "type": "string", "description": "Opaque pagination cursor." }
  }
}
```
```json
// card_search output (structured content)
{ "total": 312, "returned": 25, "next_cursor": "…",
  "data_snapshot": "2026-06-27",
  "results": [ { "oracle_id":"…","name":"…","mv":2,"ci":["U"],"type":"Instant" } ] }
```

`deck_id` is the convenience that lets an agent say *"give me proliferate payoffs that fit this deck"* in one call — the server injects `id<={deck_ci}` and `-in_deck` automatically.

### B. Deck workspace (state)

| Tool | Purpose |
|---|---|
| `deck_create` | New workspace; set name, format, and initial commander(s). Returns `deck_id`. |
| `deck_get` | Current state, lean by default; `fields`/`expand` for full card data. |
| `deck_set_commander` | Set/replace commander(s); validates partner/background/companion eligibility and recomputes identity. |
| `deck_add` | Add cards by `oracle_id` (batch, with qty). Idempotent on `(deck_id, oracle_id)`. |
| `deck_remove` | Remove cards (batch). |
| `deck_list` / `deck_delete` | Manage workspaces. |
| `deck_snapshot` / `deck_diff` / `deck_restore` | Versioning: try a variant, compare, roll back. |
| `deck_import` | Parse a decklist (Moxfield/Archidekt/MTGO/Arena/plaintext) → resolved deck, with an unresolved-lines report. |
| `deck_export` | Emit decklist in a chosen text format. |

`deck_add` returns, for each card, an inline **pre-check verdict** (`ok` | rejected with `Violation`) so the agent learns immediately if an add was illegal — without a separate validation round-trip. Adds that violate identity/legality/singleton are rejected by default (overridable with `force: true` for scratch/wishlist work, which marks the card `illegal` in state rather than silently dropping it).

### C. Validation

| Tool | Purpose |
|---|---|
| `validate_deck` | Full format check → array of `Violation`. The authoritative gate. |
| `validate_card` | "Can this card legally go in this deck?" without mutating. Cheap precheck. |
| `validate_commander` | Is X a legal commander? Is this partner/background pairing legal? |

`validate_deck` checks, in order: exact card count (100, incl. command zone) · singleton (max 1 nonbasic, with the "any number of cards named …" exception list + oracle-text heuristic) · color-identity subset for every card · banlist via `legalities.commander` · commander eligibility · multi-commander rule legality · companion condition (if a companion is declared). Output is fully structured; `severity` separates hard errors from warnings (e.g. "97 cards — 3 short" is an error; "0 ramp pieces" is not a *legality* issue and is surfaced by analysis, not validation).

### D. Analysis (deterministic computation the LLM must not do by hand)

| Tool | Purpose |
|---|---|
| `analyze_curve` | MV distribution (filterable: exclude lands, by role, by color). |
| `analyze_composition` | Counts by card type and by **functional role** (ramp, draw, removal, board wipe, protection, wincon, land, etc. — see taxonomy). |
| `analyze_mana_base` | Color-source counts per color, untapped vs. tapped, fixing density, fetch/dual coverage; flags under-supported colors. |
| `analyze_stats` | Aggregates: avg MV, color-pip distribution, total price, EDHREC-rank summary. |
| `analyze_role_coverage` | Compares role counts against configurable target bands (e.g. "8–12 ramp, 8–10 draw, 10+ interaction") and reports gaps. |

These exist because LLMs miscount and mis-sum reliably. The agent should never tally a curve in its head; it calls `analyze_curve`. Chart-friendly output (arrays keyed by bucket) so a client can render directly.

### E. Meta / synergy / combos / power level

| Tool | Purpose |
|---|---|
| `meta_commander_profile` | EDHREC average deck for a commander: top cards by category, inclusion %, synergy score, salt, themes. |
| `meta_recommendations` | Given commander + current cards, scored "what fits next" suggestions (EDHREC recs engine), with `exclude_lands`, identity-filtered. |
| `meta_themes` | Available themes/archetypes for a commander or color identity. |
| `meta_combos` | Combos available within a card set or reachable from a commander (Commander Spellbook): pieces, result, steps. Essential for combo/cEDH builds. |
| `meta_classify_bracket` | Classify the current deck into the official power brackets and report which Game Changers / fast-mana / tutors / mass-land-denial / combos push it up; uses the live Game Changers list. |

`meta_recommendations` is the synergy counterpart to `card_search`'s raw power: search answers "what cards *can* do X," recommendations answer "what do strong decks with this commander actually *play*." The agent uses both — search for build-arounds and jank, recommendations for staples and synergy density.

### F. Pricing (budget builds)

Pricing is folded into card data and `analyze_stats`; `card_search` supports `usd<=`, `eur<=` predicates and `order:price`, so "build the best deck under $100" is `card_search` + `analyze_stats` + iterate. No separate budget tool is needed — that would be a strategy tool, which violates Principle 1.

---

## 6. Validation engine — rules & edge cases

The engine encodes Commander's rules precisely; the subtle parts are called out because "bulletproof" lives here.

- **Color identity** is `color_identity` from Scryfall, which already accounts for mana symbols in cost *and* rules text and color indicators (so a colorless-costed commander with a `{R}` ability is red). The server **trusts Scryfall's computed `color_identity`** rather than re-deriving it, eliminating a whole class of parsing bugs. A deck's identity is the union of its commanders' identities; every other card must satisfy `card.color_identity ⊆ deck.color_identity`.
- **Multi-commander rules** are validated structurally: `Partner`, `Partner with [name]`, `Friends forever`, `Choose a Background` (commander + a Background enchantment), and `Doctor's companion` (a Doctor + a Time Lord companion). The pairing's *combined* identity becomes the deck identity. Illegal pairings (e.g. two non-partners) are hard errors.
- **Singleton** allows unlimited basic lands and the explicit "A deck can have any number of cards named …" cards. Maintain a curated allowlist *and* a fallback oracle-text regex so newly printed any-number cards are handled before the allowlist is updated.
- **Banlist** = `legalities.commander == "banned"`. Auto-updated by bulk refresh. (Restricted is not a Commander concept but the field is read generically.)
- **Companion** (optional declaration): if declared, the engine checks the deckbuilding condition is satisfied; otherwise it's ignored. Companions are not part of the 100.
- **Card count**: exactly 100 including the command zone. The engine reports the delta, not just pass/fail.

---

## 7. Functional role taxonomy

Analysis tools classify each card into zero-or-more **roles**, derived from oracle text patterns, keywords, type line, and (where available) Scryfall/EDHREC tags. Roles power `analyze_composition` and `analyze_role_coverage`:

`ramp` · `mana_rock` · `mana_dork` · `land` · `fixing` · `card_draw` · `card_advantage` · `tutor` · `spot_removal` · `board_wipe` · `counterspell` · `protection` · `recursion` · `graveyard_hate` · `stax` · `combo_piece` · `payoff` · `wincon` · `utility`.

Roles are heuristic and intentionally *advisory* — they feed coverage analysis, never validation. The taxonomy is configurable so a playgroup or agent can define custom target bands.

---

## 8. Error taxonomy

All tool errors return MCP `isError` with a structured `code` so the agent branches without prose parsing:

| Code | Meaning | Agent recovery |
|---|---|---|
| `UNKNOWN_CARD` | oracle_id not in index | re-resolve via `card_resolve_name` |
| `AMBIGUOUS_NAME` | fuzzy match hit multiple cards | pick from returned `candidates[]` |
| `INVALID_QUERY` | malformed Scryfall syntax | includes parse-error position |
| `COLOR_IDENTITY_VIOLATION` | card outside deck identity | swap card or change commander |
| `SINGLETON_VIOLATION` | duplicate nonbasic | remove duplicate |
| `BANNED_CARD` | banned in Commander | swap |
| `INELIGIBLE_COMMANDER` | not a legal commander/pairing | choose another |
| `DECK_NOT_FOUND` | bad deck_id | re-create or re-list |
| `UPSTREAM_UNAVAILABLE` | EDHREC/Spellbook down | retry; core build still works on local data |
| `STALE_CARD` | card newer than bulk snapshot | server attempts live fetch fallback |

---

## 9. Token economy & response shaping

- Default responses are `CardRef`-lean; full `Card` objects only via `card_get` or explicit `fields`/`expand`.
- All list-returning tools paginate with opaque cursors and a hard `limit`.
- Large search results return `total` + a window; the agent narrows the query rather than paging blindly.
- `deck_get` defaults to ids+names+qty; the agent expands only the slice it's reasoning about.
- Structured output (machine-parseable JSON) is the contract; any prose is supplementary.

---

## 10. Worked example — proving the primitives are sufficient

Three deliberately different decks, each built purely by *composing* primitives. The point is that the same small toolset spans the entire design space.

**(a) cEDH combo deck — "Thrasios/Tymna fast combo"**
1. `validate_commander` on the partner pairing → legal, identity = WUBG.
2. `deck_create` with both commanders.
3. `meta_combos` reachable from the commanders → candidate win combos; agent picks one.
4. `card_search` `id<=wubg (is:fastmana or o:"add" mv<=1)` → fast-mana suite.
5. `card_search` `id<=wubg is:tutor` → assemble redundancy.
6. `meta_recommendations` → cEDH staples; `deck_add` the package.
7. `analyze_role_coverage` with cEDH target bands; iterate.
8. `meta_classify_bracket` → confirms Bracket 5; `validate_deck` → legal.

**(b) Budget tribal — "$75 Goblins"**
1. `deck_create`, commander = a mono-red goblin lord.
2. `card_search` `id<=r t:goblin usd<=3 order:edhrec_rank` → affordable tribe.
3. `card_search` `id<=r (o:"goblin" or t:goblin) usd<=5` → payoffs/lords.
4. `deck_add`; `analyze_stats` watches the running price total.
5. `analyze_mana_base` → enough red sources; add budget lands via `card_search` `t:land id<=r usd<=2`.
6. `validate_deck`; `deck_export` to Moxfield text.

**(c) Jank build-around — "everyone draws cards" group hug**
1. `card_search` `o:"each player draws"` → identify a build-around commander candidate; `card_resolve_name` to lock it.
2. `deck_create` with it.
3. `card_search` scoped to the deck: payoffs that punish full hands / symmetric draw — pure oracle-text mining no preset archetype tool could anticipate.
4. `meta_themes` → check if EDHREC even has a theme (jank often won't; the local search carries it regardless).
5. `analyze_composition` to balance; `validate_deck`.

In all three, the server made **zero** strategic decisions and **enforced every rule** — exactly the division of labor Principle 1 demands.

---

## 11. Non-functional requirements

- **Determinism:** identical inputs against a given `data_snapshot` yield identical outputs (stable sort tiebreakers, no randomness unless a `random` tool is explicitly requested).
- **Latency:** local search/validation/analysis < 50 ms typical; enrichment calls async with cached fallback.
- **Concurrency:** deck mutations are versioned and last-write-wins per `(deck_id)` with optimistic `version` checks; `deck_add`/`remove` are idempotent.
- **Compliance:** honor Scryfall's Fan Content terms — descriptive `User-Agent`, no data paywalling, the server adds genuine value (state + validation + analysis) rather than proxying raw data.
- **Privacy/auth:** decks are scoped to the session principal; card data is shared read-only.
- **Observability:** every response stamps `data_snapshot`; upstream failures degrade gracefully to local-only capability.

---

## 12. Extension points / open questions

- **Format generalization:** the same primitives generalize to Brawl, Oathbreaker, and other singleton/identity formats by parameterizing the rules engine (count, command-zone kind, banlist source). Keep `format` a first-class field.
- **Combo data confidence:** Commander Spellbook coverage is good but not exhaustive; expose a `source`/`confidence` field on `meta_combos`.
- **Role taxonomy tuning:** heuristic roles will misclassify edge cards; consider a feedback channel or per-deck overrides.
- **Bracket list volatility:** the Game Changers list changes; treat it strictly as fetched data, never code.
- **Collection awareness (future):** an optional `collection` resource so `card_search` can filter to owned cards — useful but explicitly out of scope for v1 to keep primitives clean.
