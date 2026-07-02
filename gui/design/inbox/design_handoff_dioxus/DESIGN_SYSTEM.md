# Manabase — Design System

**Manabase** is the design system for **mtg-edh-mcp**, a desktop application for
building and analyzing *Magic: The Gathering* Commander (EDH) decks. It is a
power-user deckbuilding workbench: search a card universe, assemble 100-card
singleton decks, validate legality, and read deep analysis (mana curve, color /
role coverage, goldfish simulations, bracket / power level, budget plans,
combos). Dense, fast, keyboard-friendly, information-rich — a pro tool you run
at night, not a casual mobile app.

The system is **object-first (OOUX)**: each core domain object renders through one
recognizable component everywhere, with consistent actions.

- **Card** → `CardRow` (dense list) / `CardTile` (art grid)
- **Deck** → command zone + the versioned 99 + validation
- **Collection** → owned cards (a forward-looking surface; out of v1 engine scope)
- **Analysis / Meta** → curve, composition, mana base, role coverage, goldfish, bracket

---

## Platform

The target app is a **Dioxus 0.7 desktop** application written in **Rust** (RSX
components), rendered through a webview — so standard CSS applies, but there is
**no React/Tailwind/JS theme** in the product itself. Accordingly:

- **Design tokens are CSS custom properties** (`styles.css` → `tokens/*.css`). A
  Rust/Dioxus app consumes them directly; nothing here assumes a JS framework.
- **Light and dark themes both ship.** Dark is the default (on `:root`); light is
  a full sibling under `:root[data-theme="light"]`.
- The reusable **components in this repo are React** — they exist so design work
  and prototypes can be assembled quickly and so the visual contract is precise.
  They are *specimens of the visual language*, to be re-expressed as Dioxus RSX in
  the product. Token names and values are the durable, cross-framework contract.

---

## Sources

This system was derived entirely from the engine repository (the GUI was an
unbuilt Dioxus scaffold at the time, so there was no prior visual language — the
brand below was designed fresh, in the chosen "Dark Arcane Workbench" direction).

- **GitHub:** [`AlrikOlson/mtg-edh-mcp`](https://github.com/AlrikOlson/mtg-edh-mcp) — explore further to build higher-fidelity designs:
  - `commander-deckbuilder-mcp-spec.md` — the full tool/data design (read this first).
  - `src/types/` — the canonical data model: `Card`, `CardRef`, `Deck`, `Violation`, `Role`, color identity.
  - `src/analyze/` — `analyze_curve`, `analyze_composition`, `analyze_stats`, `analyze_mana_base`, `analyze_role_coverage`, `simulateDeck` (goldfish) — the exact chart/sim data shapes.
  - `src/meta/` — `meta_classify_bracket` (power level), EDHREC enrichment.
  - `gui/` — the Dioxus 0.7 desktop scaffold (target platform).

> The reader is *not* assumed to have access to these. The links are recorded so
> that anyone who does can go deeper. Card data and mana symbols are © Wizards of
> the Coast / via Scryfall — unofficial Fan Content.

---

## Visual Foundations

**Direction — "Dark Arcane Workbench."** Deep blue-black ink surfaces, luminous
mana pips, and high-contrast charts with a subtle glow. Restrained chrome; the
color comes from the data (WUBRG) and a single warm gold.

- **Color.** A blue-black ink ramp (`#0a0c11` canvas → `#2b3242` overlay) carries
  depth through *layered surfaces + borders*, not big drop shadows. Text is a cool
  slate ramp. The five colors **WUBRG** are a first-class semantic system (charts,
  identity, accents); on the dark canvas white→parchment and black→arcane violet
  so both stay luminous, and colorless is steel. A single **command-zone gold**
  (`#e3ad4c`) is the brand accent — primary actions, focus, the commander — chosen
  to sit apart from all five mana colors and to echo MTG's legendary/gold frames.
  Status uses green / amber / red / blue, each with a soft tinted background.
- **Type.** Three voices. **Spectral** (serif) for display / titles / the wordmark —
  arcane-grimoire character without costume. **Hanken Grotesk** for all UI and body.
  **JetBrains Mono** for *every* number, price, percentage, query string, and ID,
  always with tabular figures. Scale is a tight ~1.2 minor-third (13.5px base) for
  a dense workbench; UI text never drops below ~11.5px.
- **Spacing & density.** 4px base grid with half-steps (3/6/10px) because real
  toolbars and table rows don't snap to 8px. "Dense but breathable": 32px controls,
  36px rows, a 56px icon nav rail. Designed responsive from ~1440 down to ~1100.
- **Radius.** Crisp. Cards/panels 10px, controls 5–7px, chips & mana pips full pill.
  Nothing rounder than it needs to be.
- **Elevation.** On dark, depth = a 1px top **bevel** highlight + borders. Real drop
  shadows (`shadow-1…4`) are reserved for things that float (popovers, dialogs,
  dragged cards). The signature move is **glow**: a gold halo on focus, on the
  command zone, and on active data; WUBRG bars carry a faint colored glow.
- **Backgrounds & imagery.** No gradients-as-decoration, no textures, no hero
  imagery. The only imagery is real card art (Scryfall art-crops) in `CardRow` /
  `CardTile`, which gracefully fall back to identity-tinted placeholders. Charts use
  subtle vertical fills/glows, never rainbow gradients.
- **Motion.** Restrained and snappy — a tool, not a toy. Fades + small (2–4px)
  translations on `--ease-out`/`--ease-standard`; no bounce, no spring. Mana/glow
  elements may pulse *subtly*. All durations collapse to 0 under
  `prefers-reduced-motion`.
- **Hover / press / focus.** Hover lightens the surface (gold goes *brighter*, not
  darker, on dark); press nudges 0.5px down. Focus is always a 2px gold ring,
  visible on every surface. Disabled drops to ~45% opacity.
- **Cards.** A card = `--surface-card` (`#1a1f2a`) + 1px `--border-subtle` + 10px
  radius + a top bevel. Hover raises border contrast and a small shadow; selected
  gets a gold tint + glow.
- **Accessibility.** WCAG AA (4.5:1 body text) on both themes; status colors are
  deepened in the light theme to hold contrast on white.

---

## Content Fundamentals

The voice is the product's own: **a deterministic substrate, not an advisor.** The
engine "makes zero strategic decisions — it answers questions, mutates state,
computes statistics, and validates. The agent supplies the taste." Copy follows
suit.

- **Tone:** precise, technical, confident, terse. It states facts and counts, never
  hypes. "97 cards — 3 short." "R not in deck identity WUBG." "2 Game Changers, no
  mass land denial → Upgraded (3)."
- **Person:** address the builder as **you** ("Add to deck", "Search your
  collection"); the system refers to itself by what it did, not "I".
- **Casing:** Sentence case for labels, buttons, and headings. UPPERCASE only for
  small tracked eyebrows/overlines and rule codes (`COLOR_IDENTITY`, `CARD_COUNT`).
- **Numbers & domain terms:** always exact and mono. Use real MTG/EDH vocabulary
  without softening — *commander, color identity, singleton, mana value (MV),
  ramp, wincon, goldfish, bracket, Game Changers, proliferate*. Tool and field
  names appear verbatim (`card_search`, `analyze_curve`, `expected_version`).
- **Emoji:** none. The five WUBRG mana pips are the only "emoji-like" glyphs, and
  they are load-bearing iconography, not decoration.
- **Errors:** typed, structured, actionable — a rule, the specifics, and a fix hint
  ("Remove or change commander"), never a vague apology.

---

## Iconography

Two complementary systems:

1. **Mana symbols — the Mana font** by Andrew Gioia
   ([mana-font](https://github.com/andrewgioia/mana)), the de-facto standard for
   WUBRG pips, generic/hybrid/Phyrexian symbols, tap/untap, etc. Used via
   `<i class="ms ms-r ms-cost">` and wrapped by `ManaPip` / `ManaCost` /
   `ColorIdentity`. **Keyrune** (set symbols) is also shipped for printings.
   - Loaded from CDN. `styles.css` ships explicit `@font-face` rules (absolute
     URLs) so the binaries resolve, **and** the class CSS via `@import`. ⚠️ Some
     webviews mangle the per-symbol content rules when the icon CSS is reached
     through a nested `@import` chain — so every standalone deliverable in this
     repo *also* links `mana-font/css/mana.css` directly. Do the same in any page
     that shows pips.
2. **UI iconography — [Iconoir](https://iconoir.com)**, delivered via the
   [Iconify](https://iconify.design) web component (`<iconify-icon>`). A deliberate
   choice *away from* the ubiquitous Lucide/Heroicons/Tabler: Iconoir's crisp,
   slightly editorial line work suits the dark workbench, and the MTG flavor is
   already carried by the mana pips. Used in the UI kit (`ui_kits/manabase/icons.jsx`).
   No emoji, no Unicode-glyph icons.

> Substitution flags: the engine repo ships **no fonts or icon assets** (the GUI is
> a scaffold), so all three families — Spectral / Hanken Grotesk / JetBrains Mono,
> the Mana/Keyrune icon fonts, and Iconoir — were *chosen* for the brand and load
> from CDNs. To self-host for production, drop the `.woff2` files in
> `assets/fonts/` and swap the `@import`s for local `@font-face` rules. Tiny
> functional glyphs inside the primitives (a checkbox tick, a select chevron) are
> intrinsic inline SVG so controls render with zero network dependency.

---

## Index / Manifest

**Root**
- `styles.css` — the single entry point (consumers link this). `@import` lines only.
- `readme.md` — this guide.
- `SKILL.md` — Agent-Skill manifest for downloading + reuse.

**`tokens/`** — `fonts.css`, `colors.css`, `typography.css`, `spacing.css`,
`radius.css`, `elevation.css`, `motion.css`, `base.css`.

**`assets/logo/`** — `manabase-mark.svg` (WUBRG color-pie ringed in gold),
`manabase-mark-mono.svg` (currentColor), `favicon.svg`.

**`components/`** (React; 27 components, each with `.jsx` + `.d.ts` + `.prompt.md`)
- `core/` — Button, IconButton, Input, Select, Checkbox, Switch, SegmentedControl,
  Badge, Tag, Tabs, Tooltip, Dialog, Toast.
- `mtg/` (OOUX object components) — ManaPip, ManaCost, ColorIdentity, RoleChip,
  CardRow, CardTile, ValidationItem, BracketMeter, StatTile.
- `dataviz/` — CurveChart, PipDistribution, RoleCoverageBars, ManaSourceBars, SimReadout.

**`guidelines/`** — foundation specimen cards (Colors, Type, Spacing, Mana, Brand)
that populate the Design System tab.

**`ui_kits/manabase/`** — the interactive desktop app recreation: `index.html`
(open this), `app.jsx` (shell + router), `CardBrowser.jsx`, `DeckEditor.jsx`,
`AnalysisDashboard.jsx`, `Collection.jsx`, `icons.jsx`, `data.js`.

> **Note on the bundle:** the component cards and the UI kit load the auto-generated
> `_ds_bundle.js` (built from the `components/`). It is regenerated at the end of
> each turn — if a card looks blank immediately after authoring, reload once the
> bundle exists.
