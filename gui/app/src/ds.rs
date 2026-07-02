//! Manabase design-system components — Dioxus RSX over the `mb-*` class
//! contract in `assets/components.css` (see the handoff's COMPONENTS.md for
//! the prop APIs these mirror). Presentational only: styling comes entirely
//! from the vendored CSS; every value here is a token or a class name.

use dioxus::prelude::*;

/// Inline an Iconoir SVG (from `icons.rs`) so it inherits `currentColor` and
/// font-size. `display: contents` keeps the `svg` a structural child for the
/// `.mb-* svg` descendant rules.
#[component]
pub fn Ico(svg: &'static str) -> Element {
    rsx! {
        span { style: "display: contents;", dangerous_inner_html: svg }
    }
}

// ============================== Core ==================================

#[component]
pub fn Badge(
    #[props(default = "neutral".to_string())] tone: String,
    #[props(default = false)] dot: bool,
    #[props(default = false)] mono: bool,
    children: Element,
) -> Element {
    let tnum = if mono { " mb-badge--tnum" } else { "" };
    rsx! {
        span { class: "mb-badge mb-badge--{tone}{tnum}",
            if dot {
                span { class: "mb-badge__dot" }
            }
            {children}
        }
    }
}

#[component]
pub fn Button(
    #[props(default = "secondary".to_string())] variant: String,
    #[props(default = "md".to_string())] size: String,
    #[props(default = false)] full_width: bool,
    leading_icon: Option<Element>,
    trailing_icon: Option<Element>,
    #[props(default = false)] disabled: bool,
    onclick: Option<EventHandler<MouseEvent>>,
    children: Element,
) -> Element {
    let full = if full_width { " mb-btn--full" } else { "" };
    rsx! {
        button {
            class: "mb-btn mb-btn--{variant} mb-btn--{size}{full}",
            disabled,
            onclick: move |e| {
                if let Some(handler) = onclick {
                    handler.call(e);
                }
            },
            if let Some(icon) = leading_icon {
                span { class: "mb-btn__icon", {icon} }
            }
            {children}
            if let Some(icon) = trailing_icon {
                span { class: "mb-btn__icon", {icon} }
            }
        }
    }
}

#[component]
pub fn Checkbox(label: Option<String>, #[props(default = false)] checked: bool) -> Element {
    rsx! {
        label { class: "mb-check",
            input { r#type: "checkbox", checked }
            span { class: "mb-check__box", Ico { svg: crate::icons::CHECK } }
            if let Some(text) = label {
                span { class: "mb-check__label", "{text}" }
            }
        }
    }
}

#[component]
pub fn Dialog(
    title: Option<String>,
    description: Option<String>,
    on_close: Option<EventHandler<MouseEvent>>,
    footer: Option<Element>,
    children: Element,
) -> Element {
    rsx! {
        div { class: "mb-dialog__scrim",
            div { class: "mb-dialog", role: "dialog", aria_modal: "true",
                div { class: "mb-dialog__head",
                    div { class: "mb-dialog__titles",
                        if let Some(t) = title {
                            div { class: "mb-dialog__title", "{t}" }
                        }
                        if let Some(d) = description {
                            div { class: "mb-dialog__desc", "{d}" }
                        }
                    }
                    if let Some(close) = on_close {
                        button {
                            class: "mb-dialog__close",
                            aria_label: "Close",
                            onclick: move |e| close.call(e),
                            Ico { svg: crate::icons::XMARK }
                        }
                    }
                }
                div { class: "mb-dialog__body", {children} }
                if let Some(f) = footer {
                    div { class: "mb-dialog__foot", {f} }
                }
            }
        }
    }
}

#[component]
pub fn IconButton(
    label: String,
    #[props(default = "md".to_string())] size: String,
    #[props(default = false)] solid: bool,
    #[props(default = false)] active: bool,
    onclick: Option<EventHandler<MouseEvent>>,
    children: Element,
) -> Element {
    let solid = if solid { " mb-iconbtn--solid" } else { "" };
    let active = if active { " mb-iconbtn--active" } else { "" };
    rsx! {
        button {
            class: "mb-iconbtn mb-iconbtn--{size}{solid}{active}",
            aria_label: "{label}",
            title: "{label}",
            onclick: move |e| {
                if let Some(handler) = onclick {
                    handler.call(e);
                }
            },
            {children}
        }
    }
}

#[component]
pub fn Input(
    label: Option<String>,
    hint: Option<String>,
    error: Option<String>,
    #[props(default = "md".to_string())] size: String,
    #[props(default = false)] mono: bool,
    leading_icon: Option<Element>,
    suffix: Option<String>,
    #[props(default = String::new())] placeholder: String,
    #[props(default = String::new())] value: String,
) -> Element {
    let mono_class = if mono { " mb-input--mono" } else { "" };
    let err_class = if error.is_some() {
        " mb-input--error"
    } else {
        ""
    };
    rsx! {
        div { class: "mb-field",
            if let Some(l) = label {
                label { class: "mb-field__label", "{l}" }
            }
            div { class: "mb-input mb-input--{size}{mono_class}{err_class}",
                if let Some(icon) = leading_icon {
                    span { class: "mb-input__icon", {icon} }
                }
                input { r#type: "text", placeholder, value }
                if let Some(s) = suffix {
                    span { class: "mb-input__suffix", "{s}" }
                }
            }
            if let Some(e) = error {
                div { class: "mb-field__hint mb-field__hint--error", "{e}" }
            } else if let Some(h) = hint {
                div { class: "mb-field__hint", "{h}" }
            }
        }
    }
}

#[derive(Clone, PartialEq)]
pub struct SegOption {
    pub value: &'static str,
    pub label: &'static str,
    pub icon: Option<&'static str>,
}

#[component]
pub fn SegmentedControl(
    options: Vec<SegOption>,
    value: String,
    on_change: Option<EventHandler<String>>,
) -> Element {
    rsx! {
        div { class: "mb-seg",
            for opt in options {
                button {
                    class: "mb-seg__btn",
                    aria_pressed: if opt.value == value { "true" } else { "false" },
                    onclick: {
                        let handler = on_change;
                        let v = opt.value.to_string();
                        move |_| {
                            if let Some(h) = handler {
                                h.call(v.clone());
                            }
                        }
                    },
                    if let Some(icon) = opt.icon {
                        Ico { svg: icon }
                    }
                    "{opt.label}"
                }
            }
        }
    }
}

#[component]
pub fn Select(
    options: Vec<String>,
    #[props(default = "md".to_string())] size: String,
    on_change: Option<EventHandler<String>>,
) -> Element {
    let sm = if size == "sm" { " mb-select--sm" } else { "" };
    rsx! {
        div { class: "mb-select{sm}",
            select {
                onchange: move |e| {
                    if let Some(handler) = on_change {
                        handler.call(e.value());
                    }
                },
                for opt in options {
                    option { value: "{opt}", "{opt}" }
                }
            }
            span { class: "mb-select__chevron", Ico { svg: crate::icons::NAV_ARROW_DOWN } }
        }
    }
}

#[component]
pub fn Switch(label: Option<String>, #[props(default = false)] checked: bool) -> Element {
    rsx! {
        label { class: "mb-switch",
            input { r#type: "checkbox", checked }
            span { class: "mb-switch__track", span { class: "mb-switch__thumb" } }
            if let Some(text) = label {
                span { class: "mb-switch__label", "{text}" }
            }
        }
    }
}

#[derive(Clone, PartialEq)]
pub struct TabItem {
    pub id: &'static str,
    pub label: &'static str,
    pub count: Option<u32>,
}

#[component]
pub fn Tabs(tabs: Vec<TabItem>, value: String, on_change: Option<EventHandler<String>>) -> Element {
    rsx! {
        div { class: "mb-tabs", role: "tablist",
            for tab in tabs {
                button {
                    class: "mb-tabs__tab",
                    role: "tab",
                    aria_selected: if tab.id == value { "true" } else { "false" },
                    onclick: {
                        let handler = on_change;
                        let id = tab.id.to_string();
                        move |_| {
                            if let Some(h) = handler {
                                h.call(id.clone());
                            }
                        }
                    },
                    "{tab.label}"
                    if let Some(count) = tab.count {
                        span { class: "mb-tabs__count", "{count}" }
                    }
                }
            }
        }
    }
}

#[component]
pub fn Tag(
    tag_key: Option<String>,
    #[props(default = false)] accent: bool,
    removable: bool,
    children: Element,
) -> Element {
    let accent = if accent { " mb-tag--accent" } else { "" };
    rsx! {
        span { class: "mb-tag{accent}",
            if let Some(k) = tag_key {
                span { class: "mb-tag__key", "{k}" }
            }
            {children}
            if removable {
                button { class: "mb-tag__remove", aria_label: "Remove",
                    Ico { svg: crate::icons::XMARK }
                }
            }
        }
    }
}

#[component]
pub fn Toast(
    #[props(default = "info".to_string())] tone: String,
    title: Option<String>,
    message: Option<String>,
    #[props(default = true)] closable: bool,
) -> Element {
    let icon = match tone.as_str() {
        "success" => crate::icons::CHECK,
        "warning" | "danger" => crate::icons::WARNING_TRIANGLE,
        _ => crate::icons::INFO_CIRCLE,
    };
    rsx! {
        div { class: "mb-toast mb-toast--{tone}", role: "status",
            span { class: "mb-toast__icon", Ico { svg: icon } }
            div { class: "mb-toast__body",
                if let Some(t) = title {
                    div { class: "mb-toast__title", "{t}" }
                }
                if let Some(m) = message {
                    div { class: "mb-toast__msg", "{m}" }
                }
            }
            if closable {
                button { class: "mb-toast__close", aria_label: "Dismiss",
                    Ico { svg: crate::icons::XMARK }
                }
            }
        }
    }
}

#[component]
pub fn Tooltip(
    content: String,
    kbd: Option<String>,
    #[props(default = "top".to_string())] side: String,
    children: Element,
) -> Element {
    rsx! {
        span { class: "mb-tip", tabindex: "0",
            {children}
            span { class: "mb-tip__pop", "data-side": "{side}", role: "tooltip",
                "{content}"
                if let Some(k) = kbd {
                    span { class: "mb-tip__kbd", "{k}" }
                }
            }
        }
    }
}

// ========================= MTG object components ==========================

/// One mana symbol via the Mana icon font: `<i class="ms ms-w ms-cost">`.
/// `symbol` is a Scryfall token ("W", "2", "W/U", "G/P", …).
#[component]
pub fn ManaPip(
    symbol: String,
    #[props(default = 16)] size: u32,
    #[props(default = true)] cost: bool,
    #[props(default = true)] shadow: bool,
) -> Element {
    let ms = symbol.to_lowercase().replace('/', "");
    let cost_class = if cost { " ms-cost" } else { "" };
    let shadow_class = if shadow { " mb-pip--shadow" } else { "" };
    rsx! {
        span { class: "mb-pip{shadow_class}",
            i { class: "ms ms-{ms}{cost_class}", style: "font-size: {size}px;" }
        }
    }
}

/// A full Scryfall mana-cost string ("{2}{W}{U}") as a row of pips.
#[component]
pub fn ManaCost(cost: String, #[props(default = 15)] size: u32) -> Element {
    let tokens: Vec<String> = cost
        .split(['{', '}'])
        .filter(|t| !t.is_empty())
        .map(str::to_string)
        .collect();
    rsx! {
        span { class: "mb-cost",
            for token in tokens {
                ManaPip { symbol: token, size }
            }
        }
    }
}

/// A color identity as pips, always normalized to WUBRG order.
#[component]
pub fn ColorIdentity(identity: Vec<String>, #[props(default = 14)] size: u32) -> Element {
    const WUBRG: [&str; 5] = ["W", "U", "B", "R", "G"];
    let mut pips: Vec<String> = WUBRG
        .iter()
        .filter(|c| identity.iter().any(|i| i.eq_ignore_ascii_case(c)))
        .map(|c| c.to_string())
        .collect();
    if pips.is_empty() {
        pips.push("C".to_string());
    }
    rsx! {
        span { class: "mb-ci",
            for pip in pips {
                ManaPip { symbol: pip, size }
            }
        }
    }
}

/// A functional-role chip, color-coded by taxonomy category.
#[component]
pub fn RoleChip(role: String) -> Element {
    let category = match role.as_str() {
        "ramp" | "mana_rock" | "mana_dork" | "land" | "fixing" => "mana",
        "card_draw" | "card_advantage" | "tutor" => "know",
        "spot_removal" | "board_wipe" | "counterspell" | "graveyard_hate" | "stax" => "interact",
        "protection" | "recursion" => "protect",
        "combo_piece" | "payoff" | "wincon" => "win",
        _ => "util",
    };
    let label = role.replace('_', " ");
    rsx! {
        span { class: "mb-role mb-role--{category}",
            span { class: "mb-role__dot" }
            "{label}"
        }
    }
}

/// The canonical Card object as a dense list row.
#[component]
pub fn CardRow(
    name: String,
    type_line: Option<String>,
    #[props(default = Vec::new())] identity: Vec<String>,
    price_usd: Option<f64>,
    edhrec_rank: Option<u32>,
    image: Option<String>,
    #[props(default = false)] selected: bool,
    #[props(default = false)] illegal: bool,
    cost: Option<Element>,
    identity_node: Option<Element>,
    role_nodes: Option<Element>,
    action: Option<Element>,
) -> Element {
    let selected = if selected {
        " mb-cardrow--selected"
    } else {
        ""
    };
    let illegal = if illegal { " mb-cardrow--illegal" } else { "" };
    let tint = identity_tint(&identity);
    // Scryfall images can fail to decode in webviews (handoff gotcha #2) —
    // onerror falls back to the identity-tinted CSS frame.
    let mut img_failed = use_signal(|| false);
    let shown_image = image.filter(|_| !img_failed());
    rsx! {
        div { class: "mb-cardrow{selected}{illegal}",
            div { class: "mb-cardrow__thumb",
                if let Some(src) = shown_image {
                    img {
                        src: "{src}",
                        alt: "{name}",
                        loading: "lazy",
                        onerror: move |_| img_failed.set(true),
                    }
                } else {
                    div { class: "mb-cardrow__ph", style: "background: {tint};" }
                }
            }
            div { class: "mb-cardrow__main",
                div { class: "mb-cardrow__name", "{name}" }
                if let Some(t) = type_line {
                    div { class: "mb-cardrow__type", "{t}" }
                }
            }
            div { class: "mb-cardrow__meta",
                if let Some(roles) = role_nodes {
                    span { class: "mb-cardrow__roles", {roles} }
                }
                if let Some(c) = cost {
                    span { class: "mb-cardrow__cost", {c} }
                }
                if let Some(ci) = identity_node {
                    span { class: "mb-cardrow__ci", {ci} }
                }
                if let Some(p) = price_usd {
                    span { class: "mb-cardrow__price", "${p:.2}" }
                }
                if let Some(r) = edhrec_rank {
                    span { class: "mb-cardrow__rank", "#{r}" }
                }
                if let Some(a) = action {
                    span { class: "mb-cardrow__action", {a} }
                }
            }
        }
    }
}

/// The Card object as an art tile for grid views.
#[component]
pub fn CardTile(
    name: String,
    type_line: Option<String>,
    #[props(default = Vec::new())] identity: Vec<String>,
    price_usd: Option<f64>,
    image: Option<String>,
    #[props(default = false)] selected: bool,
    cost: Option<Element>,
    footer: Option<Element>,
) -> Element {
    let selected = if selected { " mb-tile--selected" } else { "" };
    let tint = identity_tint(&identity);
    // Scryfall images can fail to decode in webviews (handoff gotcha #2) —
    // onerror falls back to the identity-tinted CSS frame.
    let mut img_failed = use_signal(|| false);
    let shown_image = image.filter(|_| !img_failed());
    rsx! {
        div { class: "mb-tile{selected}",
            div { class: "mb-tile__art",
                if let Some(src) = shown_image {
                    img {
                        src: "{src}",
                        alt: "{name}",
                        loading: "lazy",
                        onerror: move |_| img_failed.set(true),
                    }
                } else {
                    div { class: "mb-tile__ph", style: "background: {tint};" }
                }
                if let Some(c) = cost {
                    span { class: "mb-tile__cost", {c} }
                }
            }
            div { class: "mb-tile__body",
                div { class: "mb-tile__name", "{name}" }
                div { class: "mb-tile__meta",
                    if let Some(t) = type_line {
                        span { class: "mb-tile__type", "{t}" }
                    }
                    if let Some(p) = price_usd {
                        span { class: "mb-tile__price", "${p:.2}" }
                    }
                }
            }
            if let Some(f) = footer {
                div { class: "mb-tile__foot", {f} }
            }
        }
    }
}

/// Identity-tinted placeholder gradient for missing card art (token colors only).
fn identity_tint(identity: &[String]) -> String {
    let var = match identity.first().map(|s| s.to_uppercase()) {
        Some(c) if c == "W" => "--mtg-w-soft",
        Some(c) if c == "U" => "--mtg-u-soft",
        Some(c) if c == "B" => "--mtg-b-soft",
        Some(c) if c == "R" => "--mtg-r-soft",
        Some(c) if c == "G" => "--mtg-g-soft",
        _ => "--mtg-c-soft",
    };
    format!("var({var})")
}

/// One key metric: big mono value + eyebrow label.
#[component]
pub fn StatTile(
    label: String,
    value: String,
    unit: Option<String>,
    sub: Option<String>,
    delta: Option<f64>,
    #[props(default = false)] accent: bool,
) -> Element {
    let accent = if accent {
        " mb-stat__value--accent"
    } else {
        ""
    };
    rsx! {
        div { class: "mb-stat",
            div { class: "mb-stat__label", "{label}" }
            div { class: "mb-stat__value{accent}",
                "{value}"
                if let Some(u) = unit {
                    span { class: "mb-stat__unit", "{u}" }
                }
                if let Some(d) = delta {
                    {
                        let arrow = if d >= 0.0 { "▲" } else { "▼" };
                        let dir = if d >= 0.0 { "up" } else { "down" };
                        let magnitude = d.abs();
                        rsx! {
                            span { class: "mb-stat__delta mb-stat__delta--{dir}", "{arrow}{magnitude:.1}" }
                        }
                    }
                }
            }
            if let Some(s) = sub {
                div { class: "mb-stat__sub", "{s}" }
            }
        }
    }
}

/// One `Violation` from validate_deck, severity-coded.
#[component]
pub fn ValidationItem(
    rule: String,
    #[props(default = "error".to_string())] severity: String,
    card: Option<String>,
    detail: Option<String>,
    fix_hint: Option<String>,
) -> Element {
    rsx! {
        div { class: "mb-viol mb-viol--{severity}",
            span { class: "mb-viol__icon", Ico { svg: crate::icons::WARNING_TRIANGLE } }
            div { class: "mb-viol__body",
                div { class: "mb-viol__top",
                    span { class: "mb-viol__rule", "{rule}" }
                    if let Some(c) = card {
                        span { class: "mb-viol__card", "{c}" }
                    }
                }
                if let Some(d) = detail {
                    div { class: "mb-viol__detail", "{d}" }
                }
                if let Some(f) = fix_hint {
                    div { class: "mb-viol__fix",
                        Ico { svg: crate::icons::NAV_ARROW_RIGHT }
                        "{f}"
                    }
                }
            }
        }
    }
}

/// The 1–5 Commander power-bracket gauge.
#[component]
pub fn BracketMeter(
    #[props(default = 2)] bracket: u8,
    #[props(default = true)] show_scale: bool,
) -> Element {
    const TIERS: [&str; 5] = ["Exhibition", "Core", "Upgraded", "Optimized", "cEDH"];
    let tier = TIERS[usize::from(bracket.clamp(1, 5)) - 1];
    rsx! {
        div { class: "mb-bracket",
            div { class: "mb-bracket__row",
                span { class: "mb-bracket__name", "{tier}" }
                span { class: "mb-bracket__num",
                    "{bracket}"
                    small { "/5" }
                }
            }
            div { class: "mb-bracket__seg",
                for i in 1..=5u8 {
                    div {
                        class: if i <= bracket { "mb-bracket__cell mb-bracket__cell--on" } else { "mb-bracket__cell" },
                    }
                }
            }
            if show_scale {
                div { class: "mb-bracket__scale",
                    for tier in TIERS {
                        span { "{tier}" }
                    }
                }
            }
        }
    }
}

// ============================== Data viz ==================================

/// Mana-curve histogram from analyze_curve buckets.
#[component]
pub fn CurveChart(
    buckets: Vec<(String, u32)>,
    #[props(default = 150)] height: u32,
    /// Projected (what-if) counts per bucket label — dashed-gold ghost bars.
    #[props(default)]
    ghost: Option<Vec<(String, u32)>>,
) -> Element {
    let ghost_of = |label: &str| -> Option<u32> {
        ghost
            .as_ref()?
            .iter()
            .find(|(l, _)| l == label)
            .map(|(_, n)| *n)
    };
    let max = buckets
        .iter()
        .map(|(_, n)| *n)
        .chain(ghost.iter().flatten().map(|(_, n)| *n))
        .max()
        .unwrap_or(1)
        .max(1);
    rsx! {
        div { class: "mb-curve",
            div { class: "mb-curve__plot", style: "--_h: {height}px;",
                for (label, count) in buckets {
                    div { class: "mb-curve__col",
                        div { class: "mb-curve__barwrap",
                            div {
                                class: "mb-curve__bar",
                                style: "height: {count * 100 / max}%;",
                                span { class: "mb-curve__count", "{count}" }
                            }
                            if let Some(g) = ghost_of(&label) {
                                if g != count {
                                    div {
                                        class: "mb-curve__ghost",
                                        style: "height: {g * 100 / max}%;",
                                        span { class: "mb-curve__gcount", "{g}" }
                                    }
                                }
                            }
                        }
                        div { class: "mb-curve__label", "{label}" }
                    }
                }
            }
        }
    }
}

/// Per-color mana-source bars from analyze_mana_base.
#[component]
pub fn ManaSourceBars(
    sources: Vec<(String, u32)>,
    #[props(default = 10)] threshold: u32,
    #[props(default = Vec::new())] under_supported: Vec<String>,
) -> Element {
    let max = sources
        .iter()
        .map(|(_, n)| *n)
        .max()
        .unwrap_or(1)
        .max(threshold);
    rsx! {
        div { class: "mb-src",
            for (color, count) in sources {
                div { class: "mb-src__row",
                    span { class: "mb-src__pip",
                        ManaPip { symbol: color.clone(), size: 15 }
                    }
                    div { class: "mb-src__track",
                        div {
                            class: "mb-src__fill mb-src__fill--{color}",
                            style: "width: {count * 100 / max}%;",
                        }
                        div { class: "mb-src__thresh", style: "left: {threshold * 100 / max}%;" }
                    }
                    span { class: "mb-src__meta",
                        "{count}"
                        if under_supported.contains(&color) {
                            span { class: "mb-src__warn", Ico { svg: crate::icons::WARNING_TRIANGLE } }
                        }
                    }
                }
            }
        }
    }
}

/// Color-pip distribution from analyze_stats.color_pips.
#[component]
pub fn PipDistribution(pips: Vec<(String, u32)>) -> Element {
    let max = pips.iter().map(|(_, n)| *n).max().unwrap_or(1).max(1);
    rsx! {
        div { class: "mb-pips",
            for (color, count) in pips {
                div { class: "mb-pips__row",
                    span { class: "mb-pips__pip",
                        ManaPip { symbol: color.clone(), size: 15 }
                    }
                    div { class: "mb-pips__track",
                        div {
                            class: "mb-pips__fill mb-pips__fill--{color}",
                            style: "width: {count * 100 / max}%;",
                        }
                    }
                    span { class: "mb-pips__val", "{count}" }
                }
            }
        }
    }
}

/// A role's coverage vs its target band (analyze_role_coverage.gaps entry).
#[derive(Clone, PartialEq)]
pub struct CoverageGap {
    pub role: &'static str,
    pub have: u32,
    pub want_min: u32,
    pub want_max: u32,
    pub status: &'static str, // "under" | "ok" | "over"
}

/// Role coverage bars from analyze_role_coverage.
#[component]
pub fn RoleCoverageBars(gaps: Vec<CoverageGap>) -> Element {
    let max = gaps
        .iter()
        .map(|g| g.have.max(g.want_max))
        .max()
        .unwrap_or(1)
        .max(1);
    rsx! {
        div { class: "mb-cov",
            for gap in gaps {
                div { class: "mb-cov__row",
                    span { class: "mb-cov__role", "{gap.role.replace('_', \" \")}" }
                    div { class: "mb-cov__track",
                        div {
                            class: "mb-cov__band",
                            style: "left: {gap.want_min * 100 / max}%; width: {(gap.want_max - gap.want_min) * 100 / max}%;",
                        }
                        div {
                            class: "mb-cov__fill mb-cov__fill--{gap.status}",
                            style: "width: {gap.have * 100 / max}%;",
                        }
                    }
                    span { class: "mb-cov__meta",
                        b { "{gap.have}" }
                        " / {gap.want_min}–{gap.want_max}"
                    }
                }
            }
        }
    }
}

/// Goldfish-sim summary: keep/mulligan/DOA split + lands-by-turn curve.
#[component]
pub fn SimReadout(
    keepable_rate: f64,
    mulligan_rate: f64,
    dead_on_arrival_rate: f64,
    lands_by_turn: Vec<(u32, f64)>,
) -> Element {
    let keep = keepable_rate * 100.0;
    let mull = (mulligan_rate - dead_on_arrival_rate).max(0.0) * 100.0;
    let doa = dead_on_arrival_rate * 100.0;
    // Lands-by-turn polyline in a 300×64 viewBox (padded 4px), max 5 lands.
    let points: Vec<(f64, f64)> = lands_by_turn
        .iter()
        .enumerate()
        .map(|(i, (_, lands))| {
            let n = lands_by_turn.len().max(2) as f64;
            let x = 4.0 + (i as f64) * (292.0 / (n - 1.0));
            let y = 60.0 - (lands / 5.0).min(1.0) * 56.0;
            (x, y)
        })
        .collect();
    let polyline = points
        .iter()
        .map(|(x, y)| format!("{x:.1},{y:.1}"))
        .collect::<Vec<_>>()
        .join(" ");
    rsx! {
        div { class: "mb-sim",
            div { class: "mb-sim__bar",
                span { class: "mb-sim__seg mb-sim__seg--keep", style: "width: {keep}%;" }
                span { class: "mb-sim__seg mb-sim__seg--mull", style: "width: {mull}%;" }
                span { class: "mb-sim__seg mb-sim__seg--doa", style: "width: {doa}%;" }
            }
            div { class: "mb-sim__legend",
                span { class: "mb-sim__leg",
                    span { class: "mb-sim__dot", style: "background: var(--success);" }
                    "Keepable "
                    b { "{keep:.1}%" }
                }
                span { class: "mb-sim__leg",
                    span { class: "mb-sim__dot", style: "background: var(--warning);" }
                    "Mulligan "
                    b { "{mulligan_rate * 100.0:.1}%" }
                }
                span { class: "mb-sim__leg",
                    span { class: "mb-sim__dot", style: "background: var(--danger);" }
                    "Dead on arrival "
                    b { "{doa:.1}%" }
                }
            }
            div { class: "mb-sim__turns",
                div { class: "mb-sim__turnhdr", span { "Lands in play by turn" } }
                svg {
                    class: "mb-sim__svg",
                    view_box: "0 0 300 64",
                    preserve_aspect_ratio: "none",
                    polyline { class: "mb-sim__line", points: "{polyline}" }
                    for (x, y) in points {
                        circle { class: "mb-sim__pt", cx: "{x:.1}", cy: "{y:.1}", r: "2.5" }
                    }
                }
            }
        }
    }
}
