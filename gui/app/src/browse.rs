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
pub fn scryfall_image(name: &str) -> String {
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

pub fn ready_client(conn: &ConnState) -> Option<Arc<EngineClient>> {
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
    // Pagination (gui-browse-pagination): pages after the first accumulate in
    // `extra`; `more_cursor` holds the cursor to continue from once a load-more
    // has run (page 1's cursor lives in the resource result itself).
    let mut extra = use_signal(Vec::<CardRef>::new);
    let mut more_cursor = use_signal(|| Option::<Option<String>>::None);

    // The effective grammar query, shared by page 1 and every load-more page.
    let effective_query = move || {
        let mut q = query().trim().to_string();
        if q.is_empty() {
            q = "t:creature".to_string();
        }
        let ci_now = ci();
        if !ci_now.is_empty() {
            let pips: String = ci_now.iter().map(|c| c.to_lowercase()).collect();
            q = format!("{q} id<={pips}");
        }
        q
    };

    // Search resource — re-runs whenever query/filters/order/connection change.
    // Any re-run is a NEW page 1, so the accumulated pages reset.
    let results = use_resource(move || {
        let conn = (state.conn)();
        let q = effective_query();
        let owned = owned_only();
        let ord = order();
        extra.set(Vec::new());
        more_cursor.set(None);
        async move {
            let client = ready_client(&conn)?;
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

    // The cursor a load-more should use: the last appended page's, or page 1's.
    let pending_cursor = move || -> Option<String> {
        match more_cursor() {
            Some(c) => c,
            None => match &*results.read() {
                Some(Some(Ok(r))) => r.next_cursor.clone(),
                _ => None,
            },
        }
    };

    let load_more = move |_| {
        let conn = (state.conn)();
        let Some(cursor) = pending_cursor() else {
            return;
        };
        let q = effective_query();
        let owned = owned_only();
        let ord = order();
        spawn(async move {
            let Some(client) = ready_client(&conn) else {
                return;
            };
            let params = CardSearchParams {
                query: q,
                order: Some(ord),
                limit: Some(60),
                owned_only: if owned { Some(true) } else { None },
                cursor: Some(cursor),
            };
            match client.card_search(params).await {
                Ok(page) => {
                    let mut list = extra();
                    list.extend(page.results);
                    extra.set(list);
                    more_cursor.set(Some(page.next_cursor));
                }
                Err(e) => crate::state::toast(state, "danger", format!("Load more failed: {e}")),
            }
        });
    };

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
                            "data-search": "universe",
                            value: query(),
                            placeholder: "id<=wubg t:creature mv<=4",
                            aria_label: "Scryfall grammar query",
                            onchange: move |e| query.set(e.value()),
                        }
                    }
                }
                div { style: "display: flex; align-items: center; gap: var(--space-3); padding: var(--space-2) var(--space-4);",
                    span { style: "font: var(--type-label-sm); color: var(--text-muted);", "data-results": "count",
                        match &*results.read() {
                            Some(Some(Ok(r))) => format!("{} of {} cards", r.returned + extra().len() as u64, r.total),
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
                                    for card in res.results.iter().cloned().chain(extra()) {
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
                                    for card in res.results.iter().cloned().chain(extra()) {
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
                            if pending_cursor().is_some() {
                                div { style: "display: flex; justify-content: center; padding: var(--space-3);",
                                    span { "data-browse": "load-more",
                                        Button {
                                            variant: "secondary".to_string(),
                                            size: "sm".to_string(),
                                            onclick: load_more,
                                            "Load more"
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
            {
                let state = use_app_state();
                let oracle_id = card.oracle_id.clone();
                let card_name = card.name.clone();
                let mut qty_input = use_signal(|| 1u32);
                let has_deck = (state.active_deck_id)().is_some();
                rsx! {
                    div { style: "display: flex; gap: var(--space-2); align-items: center;",
                        div { class: "mb-input mb-input--sm", style: "width: 64px;",
                            input {
                                r#type: "number",
                                min: "1",
                                max: "99",
                                "data-add": "qty",
                                value: "{qty_input()}",
                                oninput: move |e| qty_input.set(e.value().parse().unwrap_or(1).max(1)),
                            }
                        }
                        Button {
                            variant: "primary".to_string(),
                            full_width: true,
                            disabled: !has_deck,
                            onclick: move |_| {
                                let conn = (state.conn)();
                                let deck_id = (state.active_deck_id)();
                                let id = oracle_id.clone();
                                let name = card_name.clone();
                                let qty = qty_input();
                                spawn(async move {
                                    if let (Some(client), Some(deck_id)) = (ready_client(&conn), deck_id) {
                                        let res = client.deck_add(&deck_id, &[(id, qty)]).await;
                                        let label = if qty > 1 { format!("{qty}× {name}") } else { name };
                                        crate::state::toast_add_outcome(state, &label, &res);
                                        let mut rev = state.deck_rev;
                                        rev += 1;
                                    }
                                });
                            },
                            if has_deck { "Add to deck" } else { "No active deck" }
                        }
                    }
                }
            }
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
