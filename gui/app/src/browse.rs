//! Browse — the Card object's search screen, per reference/CardBrowser.jsx
//! (chrome vendored in assets/browse.css). Ships the DIRECT grammar query
//! path only; the NL/Oracle ask bar is gui-oracle scope. All data flows
//! through the live EngineClient (card_search / card_get / card_printings).

use crate::ds::*;
use crate::icons;
use crate::state::{use_app_state, ConnState};
use dioxus::prelude::*;
use mtg_edh_mcp_client::{CardDetail, CardRef, CardSearchParams, EngineClient, Printing};
use std::sync::Arc;

const WUBRG: [&str; 5] = ["W", "U", "B", "R", "G"];

/// Scryfall named-image URL (handoff gotcha #2: format=image&version=normal —
/// art_crop can fail to decode in webviews). Fallback is the CSS frame.
fn scryfall_image(name: &str) -> String {
    let encoded: String = name
        .chars()
        .map(|c| match c {
            ' ' => "+".to_string(),
            '&' => "%26".to_string(),
            '#' => "%23".to_string(),
            '?' => "%3F".to_string(),
            c => c.to_string(),
        })
        .collect();
    format!("https://api.scryfall.com/cards/named?exact={encoded}&format=image&version=normal")
}

fn ready_client(conn: &ConnState) -> Option<Arc<EngineClient>> {
    match conn {
        ConnState::Ready(client) => Some(client.clone()),
        _ => None,
    }
}

#[component]
pub fn BrowseScreen() -> Element {
    let state = use_app_state();
    let mut query = use_signal(|| "t:creature".to_string());
    let mut order = use_signal(|| "name".to_string());
    let mut view = use_signal(|| "table".to_string());
    let mut ci = use_signal(Vec::<&'static str>::new);
    let mut owned_only = use_signal(|| false);
    let mut selected = use_signal(|| Option::<CardRef>::None);

    // Search resource — re-runs whenever query/filters/order/connection change.
    let results = use_resource(move || {
        let conn = (state.conn)();
        let base = query();
        let ci_now = ci();
        let owned = owned_only();
        let ord = order();
        async move {
            let client = ready_client(&conn)?;
            let mut q = base.trim().to_string();
            if q.is_empty() {
                q = "t:creature".to_string();
            }
            if !ci_now.is_empty() {
                let pips: String = ci_now.iter().map(|c| c.to_lowercase()).collect();
                q = format!("{q} id<={pips}");
            }
            let params = CardSearchParams {
                query: q,
                order: Some(ord),
                limit: Some(60),
                owned_only: if owned { Some(true) } else { None },
                ..Default::default()
            };
            Some(client.card_search(params).await)
        }
    });

    rsx! {
        div { style: "flex: 1; display: flex; min-height: 0; min-width: 0;",

            // ---- Filter rail --------------------------------------------------
            div { style: "width: clamp(196px, 17vw, 240px); flex: none; border-right: 1px solid var(--border-subtle); overflow: auto; padding: var(--space-4); display: flex; flex-direction: column; gap: var(--space-5);",
                div { class: "cb-filt__hd",
                    span { "Filters" }
                    Button {
                        variant: "ghost".to_string(),
                        size: "sm".to_string(),
                        onclick: move |_| {
                            ci.set(Vec::new());
                            owned_only.set(false);
                        },
                        "Reset"
                    }
                }
                div { class: "cb-filt__sec",
                    div { class: "cb-filt__lbl", "Color identity" }
                    div { style: "display: flex; gap: var(--space-1_5);",
                        for color in WUBRG {
                            button {
                                class: "mb-iconbtn mb-iconbtn--sm",
                                class: if ci().contains(&color) { "mb-iconbtn--active" } else { "" },
                                aria_label: "{color}",
                                aria_pressed: if ci().contains(&color) { "true" } else { "false" },
                                onclick: move |_| {
                                    let mut cur = ci();
                                    if let Some(pos) = cur.iter().position(|c| *c == color) {
                                        cur.remove(pos);
                                    } else {
                                        cur.push(color);
                                    }
                                    ci.set(cur);
                                },
                                ManaPip { symbol: color.to_string(), size: 15 }
                            }
                        }
                    }
                }
                div { class: "cb-filt__sec",
                    div { class: "cb-filt__lbl", "Collection" }
                    label { class: "mb-switch",
                        input {
                            r#type: "checkbox",
                            checked: owned_only(),
                            onchange: move |e| owned_only.set(e.checked()),
                        }
                        span { class: "mb-switch__track", span { class: "mb-switch__thumb" } }
                        span { class: "mb-switch__label", "Owned only" }
                    }
                }
            }

            // ---- Main column --------------------------------------------------
            div { style: "flex: 1; display: flex; flex-direction: column; min-width: 0;",
                div { style: "padding: var(--space-3) var(--space-4); border-bottom: 1px solid var(--border-subtle); display: flex; flex-direction: column; gap: var(--space-2_5);",
                    div { class: "mb-input mb-input--md mb-input--mono",
                        span { class: "mb-input__icon", Ico { svg: icons::SEARCH } }
                        input {
                            r#type: "text",
                            value: query(),
                            placeholder: "id<=wubg t:creature mv<=4",
                            aria_label: "Scryfall grammar query",
                            onchange: move |e| query.set(e.value()),
                        }
                    }
                }
                div { style: "display: flex; align-items: center; gap: var(--space-3); padding: var(--space-2) var(--space-4);",
                    span { style: "font: var(--type-label-sm); color: var(--text-muted);",
                        match &*results.read() {
                            Some(Some(Ok(r))) => format!("{} of {} cards", r.returned, r.total),
                            Some(Some(Err(_))) => "search failed".to_string(),
                            Some(None) => "engine offline".to_string(),
                            None => "searching…".to_string(),
                        }
                    }
                    div { style: "flex: 1;" }
                    Select {
                        options: vec!["name".into(), "mv".into(), "price".into()],
                        size: "sm".to_string(),
                        on_change: move |v: String| order.set(v),
                    }
                    SegmentedControl {
                        options: vec![
                            SegOption { value: "table", label: "Table", icon: Some(icons::LIST) },
                            SegOption { value: "grid", label: "Grid", icon: Some(icons::VIEW_GRID) },
                        ],
                        value: view(),
                        on_change: move |v: String| view.set(v),
                    }
                }
                div { style: "flex: 1; overflow: auto; padding: var(--space-2);",
                    match &*results.read() {
                        Some(Some(Ok(res))) => rsx! {
                            if view() == "grid" {
                                div { style: "display: grid; grid-template-columns: repeat(auto-fill, minmax(182px, 1fr)); gap: var(--space-4); padding: var(--space-3);",
                                    for card in res.results.clone() {
                                        div {
                                            onclick: {
                                                let card = card.clone();
                                                move |_| selected.set(Some(card.clone()))
                                            },
                                            CardTile {
                                                name: card.name.clone(),
                                                type_line: Some(card.type_line.clone()),
                                                identity: card.ci.clone(),
                                                image: Some(scryfall_image(&card.name)),
                                                selected: selected().is_some_and(|s| s.oracle_id == card.oracle_id),
                                            }
                                        }
                                    }
                                }
                            } else {
                                div { style: "display: flex; flex-direction: column; gap: var(--space-1);",
                                    for card in res.results.clone() {
                                        div {
                                            onclick: {
                                                let card = card.clone();
                                                move |_| selected.set(Some(card.clone()))
                                            },
                                            CardRow {
                                                name: card.name.clone(),
                                                type_line: Some(card.type_line.clone()),
                                                identity: card.ci.clone(),
                                                image: Some(scryfall_image(&card.name)),
                                                selected: selected().is_some_and(|s| s.oracle_id == card.oracle_id),
                                                identity_node: Some(rsx! {
                                                    ColorIdentity { identity: card.ci.clone(), size: 13 }
                                                }),
                                            }
                                        }
                                    }
                                }
                            }
                        },
                        Some(Some(Err(e))) => rsx! {
                            div { style: "padding: var(--space-6); color: var(--danger); font: var(--type-body-sm);",
                                "card_search failed: {e}"
                            }
                        },
                        Some(None) => rsx! {
                            div { style: "padding: var(--space-6); color: var(--text-muted); font: var(--type-body-sm);",
                                "Engine offline — connect to search the universe."
                            }
                        },
                        None => rsx! {
                            div { style: "padding: var(--space-6); color: var(--text-muted); font: var(--type-body-sm);",
                                "Searching…"
                            }
                        },
                    }
                }
            }

            Inspector { selected }
        }
    }
}

/// Right-rail Inspector — card detail via card_get + card_printings.
#[component]
fn Inspector(selected: Signal<Option<CardRef>>) -> Element {
    let state = use_app_state();
    let detail = use_resource(move || {
        let conn = (state.conn)();
        let sel = selected();
        async move {
            let client = ready_client(&conn)?;
            let card = sel?;
            let got = client
                .card_get(std::slice::from_ref(&card.oracle_id))
                .await
                .ok()?;
            let detail = got.cards.into_iter().next()?;
            let printings = client
                .card_printings(&card.oracle_id)
                .await
                .map(|p| p.printings)
                .unwrap_or_default();
            Some((detail, printings))
        }
    });

    rsx! {
        div { style: "width: clamp(264px, 24vw, 320px); flex: none; border-left: 1px solid var(--border-subtle); overflow: auto; background: var(--surface-base); position: relative;",
            match (&selected(), &*detail.read()) {
                (Some(card), Some(Some((d, printings)))) => rsx! {
                    InspectorBody { card: card.clone(), detail: d.clone(), printings: printings.clone() }
                },
                (Some(_), _) => rsx! {
                    div { class: "cb-insp__empty", "Loading card…" }
                },
                (None, _) => rsx! {
                    div { class: "cb-insp__empty",
                        Ico { svg: icons::SEARCH }
                        "Select a card to inspect it."
                    }
                },
            }
        }
    }
}

#[component]
fn InspectorBody(card: CardRef, detail: CardDetail, printings: Vec<Printing>) -> Element {
    let image = scryfall_image(&card.name);
    let commander_legal = detail
        .legalities
        .get("commander")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();
    rsx! {
        div { class: "cb-insp__hero",
            div { class: "cb-insp__card",
                img { src: "{image}", alt: "{card.name}" }
            }
        }
        div { class: "cb-insp__body",
            div { class: "cb-insp__name", "{detail.name}" }
            div { class: "cb-insp__type", "{detail.type_line}" }
            div { class: "cb-insp__mi",
                ManaCost { cost: detail.mana_cost.clone() }
                ColorIdentity { identity: detail.color_identity.clone() }
            }
            if !detail.oracle_text.is_empty() {
                div { class: "cb-insp__oracle", "{detail.oracle_text}" }
            }
            if !detail.roles.is_empty() {
                div { style: "display: flex; flex-wrap: wrap; gap: var(--space-1_5);",
                    for role in detail.roles.clone() {
                        RoleChip { role }
                    }
                }
            }
            div { style: "display: flex; align-items: baseline; gap: var(--space-2); font: var(--type-data-sm); color: var(--text-secondary);",
                "Default · cheapest → "
                span { style: "color: var(--text-primary);",
                    {
                        let default = detail.default_usd.map_or("—".to_string(), |p| format!("${p:.2}"));
                        let cheapest = detail.cheapest_usd.map_or("—".to_string(), |p| format!("${p:.2}"));
                        rsx! { "{default} · {cheapest}" }
                    }
                }
            }
            Button { variant: "primary".to_string(), full_width: true, "Add to deck" }
            if commander_legal == "legal" {
                Badge { tone: "success".to_string(), dot: true, "Legal in Commander" }
            } else {
                Badge { tone: "danger".to_string(), dot: true, "{commander_legal} in Commander" }
            }
            if !printings.is_empty() {
                div { class: "cb-insp__lbl", "{printings.len()} printings" }
                div { style: "display: flex; flex-direction: column; gap: var(--space-1); font: var(--type-data-sm); color: var(--text-secondary);",
                    for p in printings.iter().take(6).cloned() {
                        div { style: "display: flex; justify-content: space-between;",
                            span { "{p.set_name} · {p.collector_number}" }
                            span {
                                {
                                    let usd = p.prices.get("usd").and_then(|v| v.as_str()).unwrap_or("—");
                                    rsx! { "${usd}" }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
