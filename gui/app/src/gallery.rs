//! The component gallery — the "everything in Storybook" surface (/craft §B).
//! Every Manabase component from COMPONENTS.md rendered in its states, in
//! light + dark, so visual review and the gui-scrutiny Playwright gate have a
//! stable regression surface. Sample data mirrors the engine's real shapes.

use crate::ds::*;
use crate::icons;
use dioxus::prelude::*;

/// One titled specimen section.
#[component]
fn Section(title: &'static str, children: Element) -> Element {
    rsx! {
        section { class: "gal__section", "data-component": "{title}",
            h2 { class: "gal__title", "{title}" }
            div { class: "gal__body", {children} }
        }
    }
}

/// A horizontal specimen row.
#[component]
fn Row(children: Element) -> Element {
    rsx! {
        div { style: "display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap;",
            {children}
        }
    }
}

#[component]
pub fn Gallery() -> Element {
    let mut light = use_signal(|| false);
    let mut dialog_open = use_signal(|| false);
    use_effect(move || {
        let script = if light() {
            "document.documentElement.dataset.theme = 'light'"
        } else {
            "delete document.documentElement.dataset.theme"
        };
        document::eval(script);
    });

    rsx! {
        div { class: "gal", style: "max-width: 980px; margin: 0 auto; padding: var(--space-6) var(--space-5) var(--space-10); display: flex; flex-direction: column; gap: var(--space-6);",

            header { style: "display: flex; align-items: center; gap: var(--space-3);",
                img { src: crate::logo_url(), alt: "Manabase", width: "28", height: "28" }
                h1 { style: "font: var(--type-display); color: var(--text-primary); margin: 0; flex: 1;",
                    "Manabase — component gallery"
                }
                Button {
                    variant: "secondary".to_string(),
                    leading_icon: Some(rsx! {
                        Ico { svg: if light() { icons::HALF_MOON } else { icons::SUN_LIGHT } }
                    }),
                    onclick: move |_| light.toggle(),
                    if light() { "Dark" } else { "Light" }
                }
            }

            Section { title: "Badge",
                Row {
                    Badge { tone: "success".to_string(), dot: true, "Legal" }
                    Badge { tone: "danger".to_string(), dot: true, "Banned" }
                    Badge { tone: "accent".to_string(), "Bracket 3" }
                    Badge { tone: "warning".to_string(), "3 warnings" }
                    Badge { tone: "info".to_string(), mono: true, "2026-06-27" }
                    Badge { tone: "neutral".to_string(), mono: true, "99" }
                    Badge { tone: "solid".to_string(), "v7" }
                }
            }

            Section { title: "Button",
                Row {
                    Button { variant: "primary".to_string(), "Add to deck" }
                    Button {
                        variant: "secondary".to_string(),
                        leading_icon: Some(rsx! { Ico { svg: icons::SEARCH } }),
                        "Search"
                    }
                    Button { variant: "ghost".to_string(), "Cancel" }
                    Button { variant: "danger".to_string(), "Remove" }
                    Button { variant: "secondary".to_string(), disabled: true, "Disabled" }
                }
                Row {
                    Button { variant: "primary".to_string(), size: "sm".to_string(), "Small" }
                    Button { variant: "primary".to_string(), size: "md".to_string(), "Medium" }
                    Button { variant: "primary".to_string(), size: "lg".to_string(), "Large" }
                }
            }

            Section { title: "Checkbox",
                Row {
                    Checkbox { label: Some("Exclude lands".to_string()), checked: true }
                    Checkbox { label: Some("Owned only".to_string()) }
                }
            }

            Section { title: "Dialog",
                Row {
                    Button {
                        variant: "secondary".to_string(),
                        onclick: move |_| dialog_open.set(true),
                        "Open dialog"
                    }
                }
                if dialog_open() {
                    Dialog {
                        title: Some("New deck".to_string()),
                        description: Some("Choose a commander to set the color identity.".to_string()),
                        on_close: move |_| dialog_open.set(false),
                        footer: Some(rsx! {
                            Button {
                                variant: "ghost".to_string(),
                                onclick: move |_| dialog_open.set(false),
                                "Cancel"
                            }
                            Button { variant: "primary".to_string(), "Create" }
                        }),
                        Input {
                            label: Some("Deck name".to_string()),
                            placeholder: "Atraxa Superfriends".to_string(),
                        }
                    }
                }
            }

            Section { title: "IconButton",
                Row {
                    IconButton { label: "Settings".to_string(), Ico { svg: icons::SETTINGS } }
                    IconButton { label: "Add".to_string(), solid: true, Ico { svg: icons::PLUS } }
                    IconButton { label: "Grid view".to_string(), active: true, Ico { svg: icons::VIEW_GRID } }
                    IconButton { label: "Delete".to_string(), size: "sm".to_string(), Ico { svg: icons::TRASH } }
                    IconButton { label: "Simulate".to_string(), size: "lg".to_string(), solid: true, Ico { svg: icons::DICE_FIVE } }
                }
            }

            Section { title: "Input",
                div { style: "display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-4);",
                    Input { label: Some("Deck name".to_string()), placeholder: "Atraxa Superfriends".to_string() }
                    Input {
                        mono: true,
                        leading_icon: Some(rsx! { Ico { svg: icons::SEARCH } }),
                        placeholder: "id<=wubg t:creature mv<=4".to_string(),
                    }
                    Input { label: Some("Budget".to_string()), suffix: Some("USD".to_string()), mono: true, value: "150".to_string() }
                    Input { label: Some("Name".to_string()), error: Some("Required".to_string()) }
                }
            }

            Section { title: "SegmentedControl",
                Row {
                    SegmentedControl {
                        options: vec![
                            SegOption { value: "table", label: "Table", icon: Some(icons::LIST) },
                            SegOption { value: "grid", label: "Grid", icon: Some(icons::VIEW_GRID) },
                        ],
                        value: "table".to_string(),
                    }
                }
            }

            Section { title: "Select",
                Row {
                    Select { options: vec!["name".into(), "mv".into(), "price".into(), "edhrec_rank".into()] }
                    Select { size: "sm".to_string(), options: vec!["White".into(), "Blue".into(), "Black".into()] }
                }
            }

            Section { title: "Switch",
                Row {
                    Switch { label: Some("Dark theme".to_string()), checked: true }
                    Switch { label: Some("Constrain to deck identity".to_string()) }
                }
            }

            Section { title: "Tabs",
                Tabs {
                    tabs: vec![
                        TabItem { id: "curve", label: "Curve", count: None },
                        TabItem { id: "comp", label: "Composition", count: Some(99) },
                        TabItem { id: "mana", label: "Mana base", count: None },
                    ],
                    value: "curve".to_string(),
                }
            }

            Section { title: "Tag",
                Row {
                    Tag { tag_key: Some("type:".to_string()), removable: true, "creature" }
                    Tag { tag_key: Some("id<=".to_string()), accent: true, removable: true, "wubg" }
                    Tag { removable: false, "proliferate" }
                }
            }

            Section { title: "Toast",
                div { style: "display: flex; flex-direction: column; gap: var(--space-3); max-width: 420px;",
                    Toast { tone: "success".to_string(), title: Some("Added".to_string()), message: Some("Sol Ring — legal in WUBG.".to_string()) }
                    Toast { tone: "danger".to_string(), title: Some("Rejected".to_string()), message: Some("Lightning Bolt — R not in deck identity.".to_string()) }
                    Toast { tone: "warning".to_string(), title: Some("Companion broken".to_string()), message: Some("Deck no longer meets the condition.".to_string()) }
                    Toast { tone: "info".to_string(), title: Some("Snapshot".to_string()), message: Some("Saved v7 at 2026-06-27.".to_string()) }
                }
            }

            Section { title: "Tooltip",
                Row {
                    Tooltip { content: "Run the goldfish sim".to_string(), kbd: Some("⌘G".to_string()),
                        IconButton { label: "Simulate".to_string(), solid: true, Ico { svg: icons::DICE_FIVE } }
                    }
                    Tooltip { content: "Bottom side".to_string(), side: "bottom".to_string(),
                        Button { variant: "ghost".to_string(), "Hover me" }
                    }
                }
            }

            Section { title: "ManaPip / ManaCost / ColorIdentity",
                Row {
                    ManaPip { symbol: "W".to_string() }
                    ManaPip { symbol: "U".to_string() }
                    ManaPip { symbol: "B".to_string() }
                    ManaPip { symbol: "R".to_string() }
                    ManaPip { symbol: "G".to_string() }
                    ManaPip { symbol: "C".to_string() }
                    ManaPip { symbol: "2".to_string() }
                    ManaPip { symbol: "X".to_string() }
                }
                Row {
                    ManaCost { cost: "{2}{W}{U}".to_string() }
                    ManaCost { cost: "{X}{R}{R}".to_string(), size: 18 }
                    ManaCost { cost: "{G}{W}{U}{B}".to_string() }
                }
                Row {
                    ColorIdentity { identity: vec!["G".into(), "W".into(), "U".into(), "B".into()] }
                    ColorIdentity { identity: vec![] }
                }
            }

            Section { title: "RoleChip",
                Row {
                    RoleChip { role: "ramp".to_string() }
                    RoleChip { role: "card_draw".to_string() }
                    RoleChip { role: "tutor".to_string() }
                    RoleChip { role: "spot_removal".to_string() }
                    RoleChip { role: "board_wipe".to_string() }
                    RoleChip { role: "protection".to_string() }
                    RoleChip { role: "wincon".to_string() }
                    RoleChip { role: "utility".to_string() }
                }
            }

            Section { title: "CardRow",
                div { style: "display: flex; flex-direction: column; gap: var(--space-1);",
                    CardRow {
                        name: "Atraxa, Praetors' Voice".to_string(),
                        type_line: Some("Legendary Creature — Phyrexian Angel Horror".to_string()),
                        identity: vec!["W".into(), "U".into(), "B".into(), "G".into()],
                        price_usd: Some(12.40),
                        edhrec_rank: Some(12),
                        cost: Some(rsx! { ManaCost { cost: "{G}{W}{U}{B}".to_string() } }),
                        identity_node: Some(rsx! { ColorIdentity { identity: vec!["W".into(), "U".into(), "B".into(), "G".into()] } }),
                        action: Some(rsx! { IconButton { label: "Add".to_string(), size: "sm".to_string(), Ico { svg: icons::PLUS } } }),
                    }
                    CardRow {
                        name: "Rhystic Study".to_string(),
                        type_line: Some("Enchantment".to_string()),
                        identity: vec!["U".into()],
                        price_usd: Some(38.10),
                        selected: true,
                        cost: Some(rsx! { ManaCost { cost: "{2}{U}".to_string() } }),
                        role_nodes: Some(rsx! { RoleChip { role: "card_draw".to_string() } }),
                    }
                    CardRow {
                        name: "Lightning Bolt".to_string(),
                        type_line: Some("Instant".to_string()),
                        identity: vec!["R".into()],
                        price_usd: Some(1.20),
                        illegal: true,
                        cost: Some(rsx! { ManaCost { cost: "{R}".to_string() } }),
                        action: Some(rsx! { IconButton { label: "Remove".to_string(), size: "sm".to_string(), Ico { svg: icons::TRASH } } }),
                    }
                }
            }

            Section { title: "CardTile",
                div { style: "display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: var(--space-3); max-width: 660px;",
                    CardTile {
                        name: "Sol Ring".to_string(),
                        type_line: Some("Artifact".to_string()),
                        identity: vec![],
                        price_usd: Some(1.49),
                        cost: Some(rsx! { ManaCost { cost: "{1}".to_string(), size: 13 } }),
                        footer: Some(rsx! { Button { size: "sm".to_string(), full_width: true, "Add" } }),
                    }
                    CardTile {
                        name: "Cyclonic Rift".to_string(),
                        type_line: Some("Instant".to_string()),
                        identity: vec!["U".into()],
                        price_usd: Some(21.00),
                        selected: true,
                        cost: Some(rsx! { ManaCost { cost: "{1}{U}".to_string(), size: 13 } }),
                    }
                    CardTile {
                        name: "Doubling Season".to_string(),
                        type_line: Some("Enchantment".to_string()),
                        identity: vec!["G".into()],
                        price_usd: Some(34.99),
                        cost: Some(rsx! { ManaCost { cost: "{4}{G}".to_string(), size: 13 } }),
                    }
                }
            }

            Section { title: "StatTile",
                div { style: "display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: var(--space-3); max-width: 660px;",
                    StatTile { label: "Avg MV".to_string(), value: "3.42".to_string(), accent: true }
                    StatTile { label: "Min buy".to_string(), value: "$184".to_string(), unit: Some("USD".to_string()), sub: Some("100 cards".to_string()) }
                    StatTile { label: "Keepable".to_string(), value: "68.4%".to_string(), delta: Some(2.1) }
                    StatTile { label: "Dead hands".to_string(), value: "14.2%".to_string(), delta: Some(-1.3) }
                }
            }

            Section { title: "ValidationItem",
                div { style: "display: flex; flex-direction: column; gap: var(--space-2); max-width: 560px;",
                    ValidationItem {
                        rule: "COLOR_IDENTITY".to_string(),
                        severity: "error".to_string(),
                        card: Some("Lightning Bolt".to_string()),
                        detail: Some("R not in deck identity WUBG".to_string()),
                        fix_hint: Some("Remove or change commander".to_string()),
                    }
                    ValidationItem {
                        rule: "CARD_COUNT".to_string(),
                        severity: "error".to_string(),
                        detail: Some("97 cards — 3 short".to_string()),
                    }
                    ValidationItem {
                        rule: "COMPANION_CONDITION".to_string(),
                        severity: "warning".to_string(),
                        card: Some("Keruga, the Macrosage".to_string()),
                        detail: Some("14 cards under MV 3".to_string()),
                    }
                }
            }

            Section { title: "BracketMeter",
                div { style: "display: flex; flex-direction: column; gap: var(--space-5); max-width: 420px;",
                    BracketMeter { bracket: 3 }
                    BracketMeter { bracket: 5, show_scale: false }
                }
            }

            Section { title: "CurveChart",
                div { style: "max-width: 480px;",
                    CurveChart {
                        buckets: vec![
                            ("0".to_string(), 2), ("1".to_string(), 8), ("2".to_string(), 14),
                            ("3".to_string(), 12), ("4".to_string(), 9), ("5".to_string(), 5),
                            ("6".to_string(), 3), ("7+".to_string(), 3),
                        ],
                    }
                }
            }

            Section { title: "ManaSourceBars",
                div { style: "max-width: 420px;",
                    ManaSourceBars {
                        sources: vec![
                            ("W".to_string(), 14), ("U".to_string(), 9), ("B".to_string(), 16),
                            ("R".to_string(), 0), ("G".to_string(), 11),
                        ],
                        threshold: 10,
                        under_supported: vec!["U".to_string(), "R".to_string()],
                    }
                }
            }

            Section { title: "PipDistribution",
                div { style: "max-width: 420px;",
                    PipDistribution {
                        pips: vec![
                            ("W".to_string(), 24), ("U".to_string(), 18), ("B".to_string(), 30),
                            ("R".to_string(), 0), ("G".to_string(), 12),
                        ],
                    }
                }
            }

            Section { title: "RoleCoverageBars",
                div { style: "max-width: 480px;",
                    RoleCoverageBars {
                        gaps: vec![
                            CoverageGap { role: "ramp", have: 9, want_min: 8, want_max: 12, status: "ok" },
                            CoverageGap { role: "card_draw", have: 6, want_min: 8, want_max: 12, status: "under" },
                            CoverageGap { role: "board_wipe", have: 5, want_min: 2, want_max: 4, status: "over" },
                            CoverageGap { role: "spot_removal", have: 8, want_min: 6, want_max: 10, status: "ok" },
                        ],
                    }
                }
            }

            Section { title: "SimReadout",
                div { style: "max-width: 480px;",
                    SimReadout {
                        keepable_rate: 0.684,
                        mulligan_rate: 0.316,
                        dead_on_arrival_rate: 0.142,
                        lands_by_turn: vec![
                            (1, 0.9), (2, 1.7), (3, 2.5), (4, 3.2), (5, 3.9), (6, 4.5),
                        ],
                    }
                }
            }
        }
    }
}
