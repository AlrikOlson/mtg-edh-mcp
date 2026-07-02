# Handoff: Manabase → Dioxus 0.7 desktop (mtg-edh-mcp GUI)

## Overview

This bundle is everything needed to implement the **Manabase** design — "Dark Arcane
Workbench" — as the GUI of **mtg-edh-mcp** (`AlrikOlson/mtg-edh-mcp`), a Rust /
**Dioxus 0.7 desktop** app for building and analyzing MTG Commander decks. Three
screens: **Browse** (card search), **Workbench** (deck editor + Oracle agent + live
Insights rail), **Collection** (forward-looking, out of v1 engine scope).

## About the design files

Everything in `reference/` is a **design reference written in HTML/React** — a working
prototype of intended look and behavior, **not production code**. The task is to
re-express these designs as **Dioxus RSX components** in the existing `gui/` scaffold,
using the CSS files in `assets/` verbatim. Nothing here assumes React at runtime:
the durable contract is (1) the CSS custom-property tokens, (2) the CSS class names,
(3) the component prop APIs in `COMPONENTS.md`, (4) the behavior described below.

## Fidelity

**High-fidelity.** Colors, type, spacing, radii, shadows, and copy are final.
Recreate pixel-perfectly; where the webview differs, the CSS files win over screenshots.

## What's in this bundle

| Path | What it is |
|---|---|
| `assets/manabase.css` | **Ship this file.** All design tokens (dark on `:root`, light on `:root[data-theme="light"]`) + base element defaults, flattened to one file. |
| `assets/components.css` | The class contract for all 27 DS components (`.mb-btn`, `.mb-cardrow`, `.mb-badge`, …), extracted from the specimens. Ship as-is. |
| `assets/screens.css` | The class contract for the app shell + screens (nav rail, top bar, command zone, Oracle, deck rows/card frames, Insights rail + cards, browser, collection). Ship as-is. |
| `assets/logo/` | The mark (WUBRG color-pie ringed in gold), mono variant, favicon. |
| `COMPONENTS.md` | Per-component props API (TypeScript defs) + design intent notes. |
| `DESIGN_SYSTEM.md` | The full design-system guide (foundations, voice, iconography). |
| `reference/` | The working HTML/React prototype — the behavioral source of truth (shipped as `.jsx.txt` so it reads as documentation; the runnable original lives in the design-system project). `data.js` mirrors the engine's `analyze_*` / sim / bracket data shapes. |

> Note: pane-level layout (flex columns, pane widths) lives as **inline styles in the
> `reference/*.jsx`** files, not in `screens.css`. The key measurements are documented
> below; for anything else, read the jsx.

## Wiring it up in Dioxus

```rust
// main.rs / app root
use dioxus::prelude::*;

static MANABASE_CSS:   Asset = asset!("/assets/manabase.css");
static COMPONENTS_CSS: Asset = asset!("/assets/components.css");
static SCREENS_CSS:    Asset = asset!("/assets/screens.css");

#[component]
fn App() -> Element {
    rsx! {
        document::Stylesheet { href: MANABASE_CSS }
        document::Stylesheet { href: COMPONENTS_CSS }
        document::Stylesheet { href: SCREENS_CSS }
        Shell {}
    }
}
```

- **Theme toggle**: tokens flip on `<html data-theme="light">`. From Dioxus:
  `document::eval(r#"document.documentElement.dataset.theme = 'light'"#)` (remove for dark).
- **Components = class names.** A Manabase button is
  `button { class: "mb-btn mb-btn--primary mb-btn--md", … }` — the CSS does the rest.
  Match the DOM structure used in `COMPONENTS.md` / the specimen jsx (e.g. `CardRow`
  is `.mb-cardrow > .mb-cardrow__thumb + .mb-cardrow__main + .mb-cardrow__meta`).
- **Webview support**: the CSS uses `color-mix(in oklab, …)` and `clamp()`. Fine on
  WebView2 (Windows) and recent WebKit (macOS). On Linux, require WebKitGTK ≥ 2.42.

## Fonts & icons

Three text families — **Spectral** (display serif), **Hanken Grotesk** (UI), **JetBrains
Mono** (every number/price/%/query, always `tnum`) — plus **Mana** (WUBRG pips) and
**Keyrune** (set symbols). `manabase.css` currently pulls all of them from CDNs via
`@import`. **For a desktop app, self-host**: download the `.woff2` files, put them in
`assets/fonts/`, and replace the three `@import` lines at the top of `manabase.css`
with local `@font-face` rules (the Mana/Keyrune `@font-face` blocks are already there —
just point `src` at the local files, and vendor `mana.min.css` for the per-symbol
class rules).

Mana pips are markup, not images: `<i class="ms ms-r ms-cost"></i>`. Keep the
`.ms.ms-cost { display:inline-flex; … }` rule from `manabase.css`; never override
`line-height` on `.ms`.

**UI icons are Iconoir** (deliberately not Lucide). The prototype loads them through
the Iconify web component; in Dioxus, vendor the SVGs instead — either the
`dioxus-free-icons` crate with the Iconoir feature, or inline the ~30 used glyphs.
The exact set (Iconoir names): search, plus, minus, settings, list, view-grid, check,
xmark, warning-triangle, nav-arrow-down, nav-arrow-right, sun-light, half-moon, filter,
trash, copy, info-circle, floppy-disk, sparks, bookmark-book, multiple-pages,
stats-up-square, archive, dice-five, crown, graph-up, flask, percentage-circle,
box-iso, arrow-up, arrow-down, git-compare. Icons inherit `currentColor` and font-size.

## Layout metrics (the shell)

- Icon **nav rail** `--rail-nav: 56px`; nav items 42×42, tooltip flyouts on hover,
  spring-slid gold indicator behind the active item.
- **Top bar** `--topbar-h: 52px`: crown + deck name (ellipsizes), identity pips,
  `v7` / `Legal` / `Bracket 3` badges, ⌘K search affordance, snapshot date, gold
  Snapshot button. Sheds chrome by priority at ≤1280 / ≤1120 / ≤980px
  (classes `mb-tb__hide-lg/-md/-sm` in `screens.css`).
- **Workbench** = deck column (min 400px) + **Insights rail**
  `width: clamp(336px, 36vw, 620px)`; workspace scrolls horizontally below that.
- Command-zone hero: 176px min-height, full-bleed commander art
  (Scryfall), gold border + glow; compact mode ≤760px viewport height.
- Controls 32px (`--control-h`), rows 36px (`--row-h`), 13.5px base type, 4px grid
  with half-steps. Designed for 1440×860, degrades to ~900px wide.

## Interactions & behavior (source of truth: `reference/*.jsx`)

- **Router**: three screens keyed off the nav rail; active state in one signal.
- **The Oracle** (Workbench): ask bar (⌘K focuses) + suggestion chips → streams terse
  tool-call captions (`card_search id<=wubg …  → 41 hits`) → materializes an inline
  change-set: proposed adds render as gold dashed "spectral" rows on top of the list,
  cuts get a red CUT tag + strikethrough in place. **Enter accepts, Esc rejects**;
  accepted rows flash gold and the stat tiles count up (~520ms cubic ease-out).
- **What-if projection**: while a change-set is pending, the Insights rail overlays
  ghosted dashed-gold deltas (projected curve/pips/composition/coverage/health) computed
  from `deck − cuts + adds`. See `analyzeDeck` / `projectSim` in `DeckEditor.jsx`.
- **Insights rail**: one vertical scroll of cards; left icon subnav is a scroll-spy
  (active section = gold pill, spring `cubic-bezier(0.34,1.4,0.5,1)`); clicking jumps.
  Deck Health hero = animated radial score (weighted blend: coverage ×0.45,
  goldfish keep ×0.35, curve shape ×0.20).
- **Deck list**: group by Type/MV/Color/Role, sort by MV/Name/Price, collapsible
  sticky group headers, per-row identity color bar + blurred right-edge art, hover
  reveals remove action; List and **Cards** view (physical card frames). Click a card
  → inspector modal (big card, stats, roles, remove).
- **Card images**: Scryfall `…/cards/named?exact=NAME&format=image&version=normal`,
  always with an `onerror` fallback to the identity-tinted CSS card frame. Cache on
  disk in the real app and respect Scryfall rate limits.
- **Motion**: 110–260ms, `--ease-standard`/`--ease-out`, fades + 2–4px translations
  only; everything collapses to 0ms under `prefers-reduced-motion`.
- **Hover/press/focus**: hover lightens surface (gold gets brighter, not darker);
  press nudges 0.5px down; focus is always the 2px gold ring (`--ring-focus`);
  disabled = 45% opacity.

## State (per screen)

- **Shell**: `active_screen`, `theme`.
- **Workbench**: `deck: Vec<Card>`, `phase: Idle | Thinking | Proposing`,
  `proposal { adds, cuts, summary }`, `view: List | Cards`, `group_by`, `sort_by`,
  `query`, `collapsed: HashSet<Group>`, `inspect: Option<Card>`; derived (memoized off
  `deck`): counts, avg MV, price, full analysis + projected analysis.
- **Browse**: `nl_query`, `translated_query`, `phase`, `results`, `selected`,
  `view: Table | Grid`, filter state. **Collection**: `query`, `sort`, `view`.
- All data arrives via MCP tool calls; `reference/data.js` mirrors the exact
  `analyze_curve` / `analyze_composition` / `analyze_mana_base` /
  `analyze_role_coverage` / `simulateDeck` / `meta_classify_bracket` shapes.

## Key tokens (full set in `assets/manabase.css`)

- **Surfaces (dark)**: canvas `#0a0c11` → base `#0e1118` → panel `#141821` → card
  `#1a1f2a` → raised `#222836` → overlay `#2b3242`; input `#11151d`.
- **Text**: primary `#e6eaf2`, secondary `#a7b0c0`, muted `#6e7889`, faint `#565f6e`.
- **Gold accent**: `--accent: #e3ad4c`, hover `#f0d091`, `--text-on-accent: #1c1404`.
- **WUBRG (dark)**: W `#ece4cb` · U `#4ea4e6` · B `#a47fd9` · R `#f0644b` ·
  G `#5fbd7d` · colorless `#aeb7c4` (+ `-soft` 18% mixes for fills).
- **Status**: success `#4fbe82`, warning `#e8973f`, danger `#e5544a`, info = U.
- Radii: 3/5/7/10/14px + pill. Depth = 1px borders + `--shadow-bevel` top highlight;
  real shadows only for floating things; `--glow-gold` is the signature halo.
- Type roles: `--type-display/title` (Spectral 600), `--type-h1…h3`, `--type-body(-sm)`,
  `--type-label(-sm)`, `--type-eyebrow` (uppercase, `--tracking-caps`),
  `--type-data(-sm/-lg/-xl)` (JetBrains Mono, tabular).

## Copy & voice

Terse, technical, deterministic — "a substrate, not an advisor." Sentence case
everywhere; UPPERCASE only for eyebrows and rule codes (`COLOR_IDENTITY`). Every
number is mono + tabular. Real EDH vocabulary (commander, MV, ramp, goldfish,
bracket, Game Changers). Errors are typed and actionable: rule + specifics + fix
hint. **No emoji** — the WUBRG pips are the only glyphs.

## Gotchas (hard-won, don't relearn)

1. Load `mana.min.css` such that its per-symbol rules actually apply (the flattened
   file imports it at the top; if you split files again, link it directly — a nested
   `@import` chain drops glyph content rules in some webviews).
2. Scryfall `version=art_crop` can fail to decode in webviews; `format=image&version=normal`
   works. Always keep the CSS-frame fallback.
3. Every var referenced by the CSS exists in `manabase.css` — if you rename tokens,
   remember one bad `var()` silently kills the whole declaration.
4. Entrance animations animate transform, gated so reduced-motion/print shows content.

## Assets & licensing

Card names/art and mana symbology are © Wizards of the Coast (unofficial Fan Content
policy); art via Scryfall. Mana font & Keyrune by Andrew Gioia (MIT-style licenses).
Spectral / Hanken Grotesk / JetBrains Mono are OFL via Google Fonts. Iconoir is MIT.
The logo SVGs in `assets/logo/` are original to this system.
