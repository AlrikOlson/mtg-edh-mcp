# Manabase — Component API reference

One entry per design-system component: the TypeScript props contract (from the
`.d.ts`) and the design intent / usage notes (from the `.prompt.md`). The CSS
class contract for all of these lives in `assets/components.css`.

In Dioxus, each becomes an RSX component with the same prop names (snake_case
them per Rust convention) emitting the same class names.

---


# Core

## Badge

**Badge** — small status pill for legality, bracket, counts, and the data snapshot. Use `mono` for numbers/dates.

```jsx
<Badge tone="success" dot>Legal</Badge>
<Badge tone="danger" dot>Banned</Badge>
<Badge tone="accent">Bracket 3</Badge>
<Badge tone="info" mono>2026-06-27</Badge>
```

```ts
import * as React from "react";

export type BadgeTone =
  | "neutral"
  | "accent"
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "solid";

/** Small status pill — legality, bracket, counts, snapshot date. */
export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Color tone. Default "neutral". */
  tone?: BadgeTone;
  /** Show a leading status dot. */
  dot?: boolean;
  /** Use the mono font with tabular figures (for counts/dates). */
  mono?: boolean;
  children?: React.ReactNode;
}

export declare function Badge(props: BadgeProps): React.JSX.Element;
```

---

## Button

**Button** — the primary action control. Gold `primary` is the command-zone accent (use once per view); everything else is `secondary` or `ghost`.

```jsx
<Button variant="primary" size="md">Add to deck</Button>
<Button variant="secondary" leadingIcon={<SearchIcon />}>Search</Button>
<Button variant="ghost" size="sm">Cancel</Button>
<Button variant="danger">Remove</Button>
```

Variants: `primary` (gold, glows), `secondary` (raised surface), `ghost` (transparent), `danger` (red outline). Sizes: `sm` 26px · `md` 32px · `lg` 38px. `fullWidth` stretches it; `as="a"` renders a link.

```ts
import * as React from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

/**
 * Primary action control for Manabase. Gold `primary` is the command-zone
 * accent — use at most one per view; default to `secondary`/`ghost`.
 *
 * @startingPoint section="Core" subtitle="Buttons in every variant & size" viewport="700x200"
 */
export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Visual weight. Default "secondary". */
  variant?: ButtonVariant;
  /** Control height. Default "md" (32px). */
  size?: ButtonSize;
  /** Stretch to fill its container. */
  fullWidth?: boolean;
  /** Icon node placed before the label. */
  leadingIcon?: React.ReactNode;
  /** Icon node placed after the label. */
  trailingIcon?: React.ReactNode;
  /** Render as another element/component (e.g. "a"). Default "button". */
  as?: React.ElementType;
  children?: React.ReactNode;
}

export declare function Button(props: ButtonProps): React.JSX.Element;
```

---

## Checkbox

**Checkbox** — boolean toggle with the gold-glow checked state. Use for filters (exclude lands, owned-only) and multi-select lists.

```jsx
<Checkbox label="Exclude lands" defaultChecked />
<Checkbox label="Owned only" />
```

```ts
import * as React from "react";

/** Checkbox with the gold-glow checked state. */
export interface CheckboxProps
  extends React.InputHTMLAttributes<HTMLInputElement> {
  /** Label text (or pass children). */
  label?: React.ReactNode;
  children?: React.ReactNode;
}

export declare function Checkbox(props: CheckboxProps): React.JSX.Element;
```

---

## Dialog

**Dialog** — modal with scrim, title/description, body, and footer actions. Used for new-deck, import, confirm-delete.

```jsx
<Dialog
  title="New deck"
  description="Choose a commander to set the color identity."
  onClose={close}
  footer={<><Button variant="ghost" onClick={close}>Cancel</Button>
           <Button variant="primary">Create</Button></>}
>
  <Input label="Deck name" />
</Dialog>
```

```ts
import * as React from "react";

/** Modal dialog with scrim, title/description, body, and a footer action row. */
export interface DialogProps {
  /** Whether the dialog is shown. Default true. */
  open?: boolean;
  title?: React.ReactNode;
  description?: React.ReactNode;
  /** Called on scrim click / close button. Omit to hide the × button. */
  onClose?: () => void;
  /** Footer node — typically a row of <Button>s. */
  footer?: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
}

export declare function Dialog(props: DialogProps): React.JSX.Element | null;
```

---

## IconButton

**IconButton** — square, icon-only button for toolbars, row affordances, and the nav rail. Always pass `label` for accessibility.

```jsx
<IconButton label="Settings"><GearIcon /></IconButton>
<IconButton label="Add" solid><PlusIcon /></IconButton>
<IconButton label="Grid view" active><GridIcon /></IconButton>
```

`solid` gives it a bordered surface; `active` applies the gold toggled tint. Sizes `sm`/`md`/`lg` match the other controls.

```ts
import * as React from "react";

export type IconButtonSize = "sm" | "md" | "lg";

/** Square, icon-only button — toolbar actions, row affordances, the nav rail. */
export interface IconButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Control size. Default "md". */
  size?: IconButtonSize;
  /** Render with a bordered/raised surface instead of bare ghost. */
  solid?: boolean;
  /** Toggled/selected state (gold tint). */
  active?: boolean;
  /** Accessible label — required since there's no visible text. */
  label: string;
  children?: React.ReactNode;
}

export declare function IconButton(props: IconButtonProps): React.JSX.Element;
```

---

## Input

**Input** — text field with optional label, leading icon, suffix, and hint/error. Set `mono` for query syntax or numeric entry.

```jsx
<Input label="Deck name" placeholder="Atraxa Superfriends" />
<Input mono leadingIcon={<SearchIcon />} placeholder="id<=wubg t:creature mv<=4" />
<Input label="Budget" suffix="USD" mono />
<Input label="Name" error="Required" />
```

```ts
import * as React from "react";

/** Text input with optional label, leading icon, suffix, and hint/error text. */
export interface InputProps
  extends React.InputHTMLAttributes<HTMLInputElement> {
  /** Field label rendered above the control. */
  label?: string;
  /** Helper text below the field. */
  hint?: string;
  /** Error message (replaces hint, turns the field red). */
  error?: string;
  /** Control height. Default "md". */
  size?: "md" | "lg";
  /** Use the mono/data font (for query syntax, numbers). */
  mono?: boolean;
  /** Icon node inside the field, before the text. */
  leadingIcon?: React.ReactNode;
  /** Trailing static text (e.g. a unit or hotkey). */
  suffix?: React.ReactNode;
}

export declare function Input(props: InputProps): React.JSX.Element;
```

---

## SegmentedControl

**SegmentedControl** — compact toggle for mutually-exclusive views (table vs grid, on-the-play vs draw).

```jsx
<SegmentedControl
  value={view}
  onChange={setView}
  options={[{value:"table",icon:<ListIcon/>,label:"Table"},{value:"grid",icon:<GridIcon/>,label:"Grid"}]}
/>
```

```ts
import * as React from "react";

export type SegmentOption =
  | string
  | { value: string; label?: React.ReactNode; icon?: React.ReactNode };

/** Compact segmented toggle for mutually-exclusive view options. */
export interface SegmentedControlProps {
  /** The segments, as strings or `{ value, label, icon }`. */
  options: SegmentOption[];
  /** Currently selected value. */
  value: string;
  /** Called with the new value on click. */
  onChange?: (value: string) => void;
  className?: string;
}

export declare function SegmentedControl(
  props: SegmentedControlProps,
): React.JSX.Element;
```

---

## Select

**Select** — native dropdown with Manabase chrome. Pass `options` as strings or `{value,label}`.

```jsx
<Select options={["name", "mv", "price", "edhrec_rank"]} defaultValue="mv" />
<Select options={[{value:"w",label:"White"},{value:"u",label:"Blue"}]} />
```

```ts
import * as React from "react";

export type SelectOption = string | { value: string; label: string };

/** Native `<select>` wearing the Manabase chrome. */
export interface SelectProps
  extends React.SelectHTMLAttributes<HTMLSelectElement> {
  /** Options as plain strings or `{ value, label }` objects. */
  options?: SelectOption[];
  /** Control size. Default "md". */
  size?: "sm" | "md";
}

export declare function Select(props: SelectProps): React.JSX.Element;
```

---

## Switch

**Switch** — on/off toggle for immediate-effect settings (theme, auto-constrain to deck identity).

```jsx
<Switch label="Dark theme" defaultChecked />
<Switch label="Constrain to deck identity" />
```

```ts
import * as React from "react";

/** On/off switch for immediate-effect settings (theme, live filters). */
export interface SwitchProps
  extends React.InputHTMLAttributes<HTMLInputElement> {
  /** Optional trailing label. */
  label?: React.ReactNode;
}

export declare function Switch(props: SwitchProps): React.JSX.Element;
```

---

## Tabs

**Tabs** — underline tab bar with an accent-glow active state. Optional per-tab `count` and `icon`.

```jsx
<Tabs
  value={tab}
  onChange={setTab}
  tabs={[
    {id:"curve", label:"Curve"},
    {id:"comp", label:"Composition", count:99},
    {id:"mana", label:"Mana base"},
  ]}
/>
```

```ts
import * as React from "react";

export interface TabItem {
  id: string;
  label: React.ReactNode;
  icon?: React.ReactNode;
  /** Optional trailing count (e.g. result/section size). */
  count?: number;
}

/** Underline tab bar with an accent glow on the active tab. */
export interface TabsProps {
  tabs: TabItem[];
  /** Active tab id. */
  value: string;
  /** Called with the new tab id. */
  onChange?: (id: string) => void;
  className?: string;
}

export declare function Tabs(props: TabsProps): React.JSX.Element;
```

---

## Tag

**Tag** — removable chip for active search filters and query facets. Optional muted `tagKey` prefix.

```jsx
<Tag tagKey="type:" onRemove={() => {}}>creature</Tag>
<Tag tagKey="id<=" accent onRemove={() => {}}>wubg</Tag>
```

```ts
import * as React from "react";

/** Removable chip for active search filters / query facets. */
export interface TagProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Muted key prefix, e.g. "type:". */
  tagKey?: string;
  /** Gold-tinted variant. */
  accent?: boolean;
  /** Show a remove (×) button; called on click. */
  onRemove?: () => void;
  children?: React.ReactNode;
}

export declare function Tag(props: TagProps): React.JSX.Element;
```

---

## Toast

**Toast** — transient notification for add/remove confirmations and validation results.

```jsx
<Toast tone="success" title="Added" message="Sol Ring — legal in WUBG." onClose={dismiss} />
<Toast tone="danger" title="Rejected" message="Lightning Bolt — R not in deck identity." />
```

```ts
import * as React from "react";

export type ToastTone = "success" | "warning" | "danger" | "info";

/** Transient notification — add/remove confirmations, validation results. */
export interface ToastProps {
  /** Color + icon. Default "info". */
  tone?: ToastTone;
  title?: React.ReactNode;
  message?: React.ReactNode;
  /** Show a dismiss button; called on click. */
  onClose?: () => void;
  className?: string;
}

export declare function Toast(props: ToastProps): React.JSX.Element;
```

---

## Tooltip

**Tooltip** — hover/focus hint. Wrap the trigger; optional `kbd` shortcut hint.

```jsx
<Tooltip content="Run the goldfish sim" kbd="⌘G">
  <IconButton label="Simulate"><DiceIcon /></IconButton>
</Tooltip>
```

```ts
import * as React from "react";

/** Hover/focus tooltip. Wrap the trigger as children. */
export interface TooltipProps {
  /** Tooltip body. */
  content: React.ReactNode;
  /** Optional keyboard hint shown after the content (e.g. "⌘K"). */
  kbd?: string;
  /** Which side to render. Default "top". */
  side?: "top" | "bottom";
  className?: string;
  children: React.ReactNode;
}

export declare function Tooltip(props: TooltipProps): React.JSX.Element;
```

---


# MTG (object components)

## BracketMeter

**BracketMeter** — the 1–5 Commander power-bracket gauge from `meta_classify_bracket`.

```jsx
<BracketMeter bracket={3} />
<BracketMeter bracket={5} showScale={false} />
```

Pair with a list of pushers (Game Changers, fast mana, tutors, combos) for the full bracket view.

```ts
import * as React from "react";

/**
 * The Commander power-bracket gauge (1–5) from `meta_classify_bracket`:
 * 1 Exhibition · 2 Core · 3 Upgraded · 4 Optimized · 5 cEDH.
 */
export interface BracketMeterProps
  extends React.HTMLAttributes<HTMLDivElement> {
  /** The classified bracket, 1–5. Default 2. */
  bracket?: number;
  /** Optional projected bracket (1–5) — outlines the cells a change-set would
   *  gain or lose with a dashed ghost and shows "bracket → ghost". */
  ghost?: number | null;
  /** Show the tier scale beneath the meter. Default true. */
  showScale?: boolean;
}

export declare function BracketMeter(
  props: BracketMeterProps,
): React.JSX.Element;
```

---

## CardRow

**CardRow** — the canonical Card object as a dense list row (search results, deck list, recs). Keep it presentational: pass pre-built nodes for cost/identity/roles/action.

```jsx
<CardRow
  name="Atraxa, Praetors' Voice"
  typeLine="Legendary Creature — Phyrexian Angel Horror"
  image={artUrl}
  cost={<ManaCost cost="{G}{W}{U}{B}" />}
  identityNode={<ColorIdentity identity={["W","U","B","G"]} />}
  priceUsd={12.40}
  action={<IconButton label="Add"><PlusIcon/></IconButton>}
/>
```

`selected` gold-tints the row; `illegal` red-tints it (the engine's force-added flag). Omits any field you don't pass.

```ts
import * as React from "react";

/**
 * The canonical Card rendering — a dense list row used in search results, the
 * deck list, and recommendations. Fields map to the engine's Card / CardRef.
 * Pass pre-rendered nodes (`cost`, `identityNode`, `roleNodes`, `action`) built
 * from ManaCost / ColorIdentity / RoleChip / Button so the row stays presentational.
 *
 * @startingPoint section="MTG" subtitle="The Card object as a dense list row" viewport="700x220"
 */
export interface CardRowProps extends React.HTMLAttributes<HTMLDivElement> {
  name: string;
  /** Full type line, e.g. "Legendary Creature — Phyrexian Angel Horror". */
  typeLine?: string;
  /** Color identity (for the placeholder tint when no image). */
  identity?: string[];
  /** Default-printing price; renders as "$x.xx". */
  priceUsd?: number;
  /** EDHREC rank; renders as "#123". */
  edhrecRank?: number;
  /** Art-crop image URL; falls back to an identity-tinted placeholder. */
  image?: string;
  /** Highlight as selected (gold tint). */
  selected?: boolean;
  /** Mark as force-added-illegal (red tint) — the engine's `illegal` flag. */
  illegal?: boolean;
  /** Rendered <ManaCost>. */
  cost?: React.ReactNode;
  /** Rendered <ColorIdentity>. */
  identityNode?: React.ReactNode;
  /** Rendered row of <RoleChip>s. */
  roleNodes?: React.ReactNode;
  /** Trailing action node (e.g. an add/remove <IconButton>). */
  action?: React.ReactNode;
}

export declare function CardRow(props: CardRowProps): React.JSX.Element;
```

---

## CardTile

**CardTile** — the Card object as an art tile for grid/gallery views (search grid, collection).

```jsx
<CardTile
  name="Sol Ring" typeLine="Artifact" image={artUrl} priceUsd={1.49}
  cost={<ManaCost cost="{1}" size={13} />}
  footer={<Button size="sm" fullWidth>Add</Button>}
/>
```

The dense list counterpart is **CardRow**.

```ts
import * as React from "react";

/** The Card object as an art tile — the grid / gallery view of search & collection. */
export interface CardTileProps extends React.HTMLAttributes<HTMLDivElement> {
  name: string;
  typeLine?: string;
  identity?: string[];
  priceUsd?: number;
  /** Art-crop image URL; falls back to an identity-tinted placeholder. */
  image?: string;
  selected?: boolean;
  /** Rendered <ManaCost>, overlaid top-right of the art. */
  cost?: React.ReactNode;
  /** Optional footer node (e.g. an add button). */
  footer?: React.ReactNode;
}

export declare function CardTile(props: CardTileProps): React.JSX.Element;
```

---

## ColorIdentity

**ColorIdentity** — a deck/card identity as pips, always normalized to WUBRG order. Maps to the engine's `color_identity` / `computed_color_identity`.

```jsx
<ColorIdentity identity={["G","W","U","B"]} />   {/* renders W U B G */}
<ColorIdentity identity={[]} />                  {/* colorless */}
```

```ts
import * as React from "react";

/**
 * A deck/card color identity as a row of pips, always sorted to WUBRG order.
 * Maps to the engine's `color_identity` / `computed_color_identity`.
 */
export interface ColorIdentityProps
  extends React.HTMLAttributes<HTMLSpanElement> {
  /** Colors, any order: ["G","W","U"]. Empty / ["C"] → colorless. */
  identity: string[];
  /** Pixel size of each pip. Default 14. */
  size?: number;
  /** Render the colorless pip when identity is empty. Default true. */
  showColorless?: boolean;
}

export declare function ColorIdentity(
  props: ColorIdentityProps,
): React.JSX.Element | null;
```

---

## ManaCost

**ManaCost** — a full mana cost as a row of pips. Accepts the raw Scryfall string.

```jsx
<ManaCost cost="{2}{W}{U}" />
<ManaCost cost="{X}{R}{R}" size={18} />
```

Composes **ManaPip**. For a deck's color identity (not a cost) use **ColorIdentity**.

```ts
import * as React from "react";

/** Render a full Scryfall `mana_cost` string as a row of mana pips. */
export interface ManaCostProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Scryfall cost string ("{2}{W}{U}") or an array of tokens (["2","W","U"]). */
  cost: string | string[];
  /** Pixel size of each pip. Default 15. */
  size?: number;
  /** Drop-shadow under each pip. Default true. */
  shadow?: boolean;
}

export declare function ManaCost(props: ManaCostProps): React.JSX.Element;
```

---

## ManaPip

**ManaPip** — one mana symbol via the Mana icon font. `symbol` is a Scryfall token.

```jsx
<ManaPip symbol="W" />
<ManaPip symbol="2" />
<ManaPip symbol="G/P" size={20} />
```

Requires the mana-font CSS (shipped by `styles.css`; standalone deliverables also `<link>` it directly). For a full cost string use **ManaCost**.

```ts
import * as React from "react";

/**
 * A single mana symbol rendered with the Mana icon font.
 *
 * @startingPoint section="MTG" subtitle="Mana symbols, costs & color identity" viewport="700x180"
 */
export interface ManaPipProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Scryfall symbol token: "W","U","B","R","G","C","2","X","W/U","G/P", … */
  symbol: string;
  /** Pixel size of the glyph. Default 16. */
  size?: number;
  /** Render the rounded "cost" badge style (vs. bare glyph). Default true. */
  cost?: boolean;
  /** Drop-shadow under the pip. Default true. */
  shadow?: boolean;
}

export declare function ManaPip(props: ManaPipProps): React.JSX.Element;
```

---

## RoleChip

**RoleChip** — a functional-role chip from the engine's §7 taxonomy, color-coded by category.

```jsx
<RoleChip role="ramp" />          {/* green — mana */}
<RoleChip role="card_draw" />     {/* blue — card advantage */}
<RoleChip role="spot_removal" />  {/* red — interaction */}
<RoleChip role="wincon" />        {/* gold — win */}
```

```ts
import * as React from "react";

export type Role =
  | "ramp" | "mana_rock" | "mana_dork" | "land" | "fixing"
  | "card_draw" | "card_advantage" | "tutor"
  | "spot_removal" | "board_wipe" | "counterspell" | "graveyard_hate" | "stax"
  | "protection" | "recursion"
  | "combo_piece" | "payoff" | "wincon"
  | "utility";

/**
 * A functional-role chip from the engine's §7 role taxonomy, color-coded by
 * category (mana=green, card advantage=blue, interaction=red, protection=violet,
 * win=gold, utility=steel).
 */
export interface RoleChipProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** One role token from the taxonomy. */
  role: Role;
}

export declare function RoleChip(props: RoleChipProps): React.JSX.Element;
```

---

## StatTile

**StatTile** — one key metric (big mono value + eyebrow label) for the analysis dashboard.

```jsx
<StatTile label="Avg MV" value="3.42" accent />
<StatTile label="Min buy" value="$184" unit="USD" sub="100 cards" />
<StatTile label="Keepable" value="68.4%" delta={2.1} />
```

```ts
import * as React from "react";

/**
 * A single key metric — big mono value with an eyebrow label. Built for the
 * analyze_stats dashboard (avg MV, total price, keepable rate, card count).
 */
export interface StatTileProps extends React.HTMLAttributes<HTMLDivElement> {
  label: React.ReactNode;
  value: React.ReactNode;
  /** Trailing unit, e.g. "avg MV", "USD". */
  unit?: React.ReactNode;
  /** Secondary line beneath the value. */
  sub?: React.ReactNode;
  /** Signed delta vs. a baseline; colored up/down. */
  delta?: number;
  /** Render the value in gold. */
  accent?: boolean;
  /** Leading icon in the label. */
  icon?: React.ReactNode;
}

export declare function StatTile(props: StatTileProps): React.JSX.Element;
```

---

## ValidationItem

**ValidationItem** — one `Violation` from `validate_deck`, severity-coded. Maps 1:1 to the engine's Violation shape.

```jsx
<ValidationItem
  rule="COLOR_IDENTITY" severity="error" card="Lightning Bolt"
  detail="R not in deck identity WUBG" fixHint="Remove or change commander"
/>
<ValidationItem rule="CARD_COUNT" severity="error" detail="97 cards — 3 short" />
```

```ts
import * as React from "react";

/**
 * One Violation from `validate_deck`, severity-coded. Maps directly to the
 * engine's Violation shape: { rule, severity, card?, detail, fix_hint? }.
 */
export interface ValidationItemProps
  extends React.HTMLAttributes<HTMLDivElement> {
  /** Rule code, e.g. "COLOR_IDENTITY", "SINGLETON", "CARD_COUNT". */
  rule?: string;
  /** "error" (hard legality) or "warning" (advisory). Default "error". */
  severity?: "error" | "warning";
  /** Offending card name, when the violation is card-scoped. */
  card?: string;
  /** Human-readable specifics, e.g. "R not in deck identity WUBG". */
  detail?: string;
  /** Actionable suggestion (the engine's fix_hint). */
  fixHint?: string;
}

export declare function ValidationItem(
  props: ValidationItemProps,
): React.JSX.Element;
```

---


# Data viz

## CurveChart

**CurveChart** — mana-curve histogram from `analyze_curve`. Pass the `buckets` record straight through.

```jsx
<CurveChart buckets={{ "0":2, "1":8, "2":14, "3":12, "4":9, "5":5, "6":3, "7+":3 }} />
```

Glowing gold bars with counts above each column. For color-pip distribution use **PipDistribution**.

```ts
import * as React from "react";

/**
 * Mana-curve histogram from `analyze_curve`. Pass its `buckets` record keyed by
 * mana value ("0".."6","7+") with quantity-weighted counts.
 *
 * @startingPoint section="Data viz" subtitle="Curve, coverage, mana sources & sim" viewport="700x260"
 */
export interface CurveChartProps extends React.HTMLAttributes<HTMLDivElement> {
  /** analyze_curve buckets, e.g. { "1": 8, "2": 14, "3": 12, "7+": 3 }. */
  buckets: Record<string, number>;
  /** Optional second buckets record (e.g. a projected what-if curve) overlaid as
   *  a dashed ghost outline showing where each column would land. */
  ghost?: Record<string, number> | null;
  /** Plot height in px. Default 150. */
  height?: number;
}

export declare function CurveChart(props: CurveChartProps): React.JSX.Element;
```

---

## ManaSourceBars

**ManaSourceBars** — per-color mana-source counts from `analyze_mana_base`. Threshold marker + under-supported warning icon.

```jsx
<ManaSourceBars
  sources={{ W:14, U:9, B:16, R:0, G:11 }}
  threshold={10}
  underSupported={["U"]}
/>
```

Counts of sources (lands + rocks/dorks). For pip *requirements* (cost demand) use **PipDistribution**.

```ts
import * as React from "react";

/**
 * Per-color mana-source counts from `analyze_mana_base` — WUBRG-colored bars with
 * a threshold marker and an under-supported warning. Map `sources`,
 * `under_supported`, and the threshold straight from the report.
 */
export interface ManaSourceBarsProps
  extends React.HTMLAttributes<HTMLDivElement> {
  /** sources record, e.g. { W: 14, U: 9, B: 16, R: 0, G: 11 }. */
  sources: Record<string, number>;
  /** Source-count threshold (the engine default is 10). */
  threshold?: number;
  /** Colors flagged under-supported (the report's under_supported). */
  underSupported?: string[];
}

export declare function ManaSourceBars(
  props: ManaSourceBarsProps,
): React.JSX.Element;
```

---

## PipDistribution

**PipDistribution** — colored-pip distribution from `analyze_stats.color_pips`. One WUBRG-colored bar per color.

```jsx
<PipDistribution pips={{ W:24, U:18, B:30, R:0, G:12 }} />
```

Needs the mana-font CSS for the row labels (shipped via styles.css). Mana-source counts are a different view — use **ManaSourceBars**.

```ts
import * as React from "react";

/**
 * Color-pip distribution from `analyze_stats.color_pips` — one WUBRG-colored bar
 * per color, scaled to the max. Uses the Mana font for the row labels.
 */
export interface PipDistributionProps
  extends React.HTMLAttributes<HTMLDivElement> {
  /** color_pips record, e.g. { W: 24, U: 18, B: 30, R: 0, G: 12 }. */
  pips: Record<string, number>;
}

export declare function PipDistribution(
  props: PipDistributionProps,
): React.JSX.Element;
```

---

## RoleCoverageBars

**RoleCoverageBars** — role counts vs. target bands from `analyze_role_coverage.gaps`. The ghost band shows the target window; the fill is colored by status.

```jsx
<RoleCoverageBars gaps={[
  {role:"ramp", have:9, want_min:8, want_max:12, status:"ok"},
  {role:"card_draw", have:6, want_min:8, want_max:12, status:"under"},
  {role:"board_wipe", have:5, want_min:2, want_max:4, status:"over"},
]} />
```

```ts
import * as React from "react";

export interface CoverageGap {
  role: string;
  have: number;
  want_min: number;
  want_max: number;
  status: "under" | "ok" | "over";
}

/**
 * Role-coverage bars from `analyze_role_coverage.gaps` — each role's count
 * against its target band, colored by status (under=amber, ok=green, over=blue).
 * The ghost band marks the target min–max window.
 */
export interface RoleCoverageBarsProps
  extends React.HTMLAttributes<HTMLDivElement> {
  gaps: CoverageGap[];
  /** Optional projected gaps[] (e.g. a what-if change-set) — each role's
   *  projected `have` is marked with a dashed tick and the delta is shown. */
  ghost?: CoverageGap[] | null;
}

export declare function RoleCoverageBars(
  props: RoleCoverageBarsProps,
): React.JSX.Element;
```

---

## SimReadout

**SimReadout** — goldfish-sim summary from `simulateDeck`: the keep/mulligan/screw split + lands-by-turn curve.

```jsx
<SimReadout
  keepableRate={0.684} mulliganRate={0.316} deadOnArrivalRate={0.142}
  landsByTurn={{1:0.9, 2:1.7, 3:2.5, 4:3.2, 5:3.9, 6:4.5}}
/>
```

Pair with **StatTile**s for avg opening lands and avg turn-to-first-spell.

```ts
import * as React from "react";

/**
 * Goldfish-sim summary from `simulateDeck` — the keepable/mulligan/dead-on-arrival
 * split as a stacked bar, plus the lands-in-play-by-turn curve.
 */
export interface SimReadoutProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Fraction (0–1) of keepable opening hands. */
  keepableRate: number;
  /** Fraction (0–1) requiring a mulligan. */
  mulliganRate: number;
  /** Fraction (0–1) screwed (≤1 land) or flooded (≥6). */
  deadOnArrivalRate: number;
  /** lands_by_turn record, e.g. { 1: 0.9, 2: 1.7, 3: 2.5, … }. */
  landsByTurn: Record<number, number>;
  /** Optional projected keepable rate (0–1) — overlaid as a dashed split bar +
   *  a keepable delta chip. */
  ghostKeepableRate?: number | null;
  /** Optional projected dead-on-arrival rate (0–1) for the ghost split. */
  ghostDeadOnArrivalRate?: number | null;
  /** Optional projected lands_by_turn — drawn as a dashed ghost line. */
  ghostLandsByTurn?: Record<number, number> | null;
}

export declare function SimReadout(props: SimReadoutProps): React.JSX.Element;
```

---
