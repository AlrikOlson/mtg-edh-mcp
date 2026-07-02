//! Collection — the owned-cards object, per reference/Collection.jsx (chrome
//! in assets/collection.css). MEMBERSHIP-ONLY by recorded decision (think:133):
//! the engine collection is a Set of oracle_ids, so the design's qty badges and
//! sort-by-quantity are deliberately dropped — no fake quantities. Includes the
//! build-from-collection surface: budget_plan use_collection → acquire_usd.

use crate::browse::{ready_client, scryfall_image};
use crate::ds::*;
use crate::icons;
use crate::state::use_app_state;
use dioxus::prelude::*;
use mtg_edh_mcp_client::CardDetail;
use std::collections::HashMap;

#[component]
pub fn CollectionScreen() -> Element {
    let state = use_app_state();
    let mut rev = use_signal(|| 0u32);
    let mut query = use_signal(String::new);
    let mut sort = use_signal(|| "value".to_string());
    let mut view = use_signal(|| "grid".to_string());
    let mut add_input = use_signal(String::new);
    let mut unresolved = use_signal(Vec::<String>::new);
    let mut confirm_clear = use_signal(|| false);

    // Owned set + joined details (one batched card_get) + build-from-collection.
    let data = use_resource(move || {
        let conn = (state.conn)();
        let deck_id = (state.active_deck_id)();
        let _ = rev();
        async move {
            let client = ready_client(&conn)?;
            let owned = client.collection_get().await.ok()?;
            let details: HashMap<String, CardDetail> = if owned.owned.is_empty() {
                HashMap::new()
            } else {
                client
                    .card_get(&owned.owned)
                    .await
                    .map(|r| {
                        r.cards
                            .into_iter()
                            .map(|c| (c.oracle_id.clone(), c))
                            .collect()
                    })
                    .unwrap_or_default()
            };
            // Build-from-collection: acquire_usd vs full min-buy for the active deck.
            let budget = match deck_id {
                Some(id) => client.budget_plan(&id, true).await.ok(),
                None => None,
            };
            Some((owned, details, budget))
        }
    });

    let add_cards = move |_| {
        let conn = (state.conn)();
        let raw = add_input().trim().to_string();
        if raw.is_empty() {
            return;
        }
        spawn(async move {
            if let Some(client) = ready_client(&conn) {
                let cards: Vec<String> = raw
                    .split([',', ';', '\n'])
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect();
                if let Ok(result) = client.collection_add(&cards).await {
                    unresolved.set(result.unresolved);
                    add_input.set(String::new());
                    rev += 1;
                }
            }
        });
    };

    rsx! {
        div { style: "flex: 1; display: flex; flex-direction: column; min-height: 0;",
            match &*data.read() {
                Some(Some((owned, details, budget))) => {
                    // Join + filter + sort (membership-only: no qty anywhere).
                    let q = query().trim().to_lowercase();
                    let mut items: Vec<CardDetail> = owned.owned.iter()
                        .filter_map(|id| details.get(id).cloned())
                        .filter(|d| {
                            q.is_empty()
                                || d.name.to_lowercase().contains(&q)
                                || d.type_line.to_lowercase().contains(&q)
                        })
                        .collect();
                    match sort().as_str() {
                        "name" => items.sort_by(|a, b| a.name.cmp(&b.name)),
                        _ => items.sort_by(|a, b| {
                            let p = |c: &CardDetail| c.default_usd.unwrap_or(0.0);
                            p(b).partial_cmp(&p(a)).unwrap_or(std::cmp::Ordering::Equal)
                        }),
                    }
                    let total: f64 = owned.owned.iter()
                        .filter_map(|id| details.get(id).and_then(|d| d.default_usd))
                        .sum();
                    let top = items.iter().max_by(|a, b| {
                        a.default_usd.unwrap_or(0.0)
                            .partial_cmp(&b.default_usd.unwrap_or(0.0))
                            .unwrap_or(std::cmp::Ordering::Equal)
                    }).map(|d| d.name.split(',').next().unwrap_or(&d.name).to_string());
                    let shown = items.len();
                    let acquire = budget.as_ref().and_then(|b| b.get("acquire_usd")).and_then(|v| v.as_f64());
                    let min_buy = budget.as_ref().and_then(|b| b.get("min_buy_usd")).and_then(|v| v.as_f64());
                    rsx! {
                        div { class: "col-stats", style: "margin-top: var(--space-4);",
                            div { class: "col-stat",
                                b { class: "accent", "{owned.owned_count}" }
                                span { "Cards owned" }
                            }
                            div { class: "col-stat",
                                b { "${total:.0}" }
                                span { "Est. value" }
                            }
                            div { class: "col-stat",
                                b { if let Some(t) = &top { "{t}" } else { "—" } }
                                span { "Most valuable" }
                            }
                            // Build-from-collection — the moat surface.
                            div { class: "col-stat", "data-budget": "acquire",
                                b {
                                    match (acquire, min_buy) {
                                        (Some(a), _) => format!("${a:.0}"),
                                        (None, Some(_)) => "—".to_string(),
                                        _ => "no deck".to_string(),
                                    }
                                }
                                span {
                                    if let Some(m) = min_buy {
                                        "To finish deck (min-buy ${m:.0})"
                                    } else {
                                        "To finish deck"
                                    }
                                }
                            }
                        }
                        div { style: "display: flex; align-items: center; gap: var(--space-3); padding: 0 var(--space-5) var(--space-3);",
                            div { class: "mb-input mb-input--md", style: "flex: 0 1 280px; min-width: 170px;",
                                span { class: "mb-input__icon", Ico { svg: icons::SEARCH } }
                                input {
                                    r#type: "text",
                                    placeholder: "Search your collection…",
                                    value: query(),
                                    onchange: move |e| query.set(e.value()),
                                }
                            }
                            Badge { tone: "neutral".to_string(), mono: true, "{shown} shown" }
                            div { style: "flex: 1;" }
                            Select {
                                size: "sm".to_string(),
                                options: vec!["value".into(), "name".into()],
                                on_change: move |v: String| sort.set(v),
                            }
                            SegmentedControl {
                                options: vec![
                                    SegOption { value: "grid", label: "Grid", icon: Some(icons::VIEW_GRID) },
                                    SegOption { value: "table", label: "List", icon: Some(icons::LIST) },
                                ],
                                value: view(),
                                on_change: move |v: String| view.set(v),
                            }
                            Button {
                                variant: "ghost".to_string(),
                                size: "sm".to_string(),
                                onclick: move |_| confirm_clear.set(true),
                                "Clear all"
                            }
                        }
                        // Add-by-name (comma/newline separated) with the unresolved report.
                        div { style: "display: flex; align-items: center; gap: var(--space-2); padding: 0 var(--space-5) var(--space-3);",
                            div { class: "mb-input mb-input--md", style: "flex: 1; max-width: 480px;",
                                input {
                                    r#type: "text",
                                    placeholder: "Add cards by name or oracle_id (comma-separated)",
                                    value: add_input(),
                                    onchange: move |e| add_input.set(e.value()),
                                }
                            }
                            Button {
                                variant: "secondary".to_string(),
                                leading_icon: Some(rsx! { Ico { svg: icons::PLUS } }),
                                onclick: add_cards,
                                "Add to collection"
                            }
                        }
                        if !unresolved().is_empty() {
                            div { style: "padding: 0 var(--space-5) var(--space-3);",
                                Badge { tone: "warning".to_string(), dot: true,
                                    "{unresolved().len()} unresolved: {unresolved().join(\", \")}"
                                }
                            }
                        }
                        div { style: "flex: 1; overflow: auto; padding: 0 var(--space-5) var(--space-5);",
                            if items.is_empty() {
                                div { class: "col-empty",
                                    if owned.owned.is_empty() {
                                        "No owned cards yet — add some above."
                                    } else {
                                        "No owned cards match the search."
                                    }
                                }
                            } else if view() == "grid" {
                                div { style: "display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: var(--space-3);",
                                    for card in items {
                                        div { class: "col-tile",
                                            CardTile {
                                                name: card.name.clone(),
                                                type_line: Some(card.type_line.clone()),
                                                identity: card.color_identity.clone(),
                                                price_usd: card.default_usd,
                                                image: Some(scryfall_image(&card.name)),
                                                cost: Some(rsx! { ManaCost { cost: card.mana_cost.clone(), size: 12 } }),
                                                footer: Some(rsx! {
                                                    Button {
                                                        variant: "ghost".to_string(),
                                                        size: "sm".to_string(),
                                                        full_width: true,
                                                        onclick: {
                                                            let id = card.oracle_id.clone();
                                                            move |_| remove_owned(state, id.clone(), rev)
                                                        },
                                                        "Remove"
                                                    }
                                                }),
                                            }
                                        }
                                    }
                                }
                            } else {
                                div { style: "display: grid; grid-template-columns: repeat(auto-fill, minmax(330px, 1fr)); column-gap: var(--space-4); row-gap: 2px;",
                                    for card in items {
                                        div { class: "deckrow col-listrow",
                                            CardRow {
                                                name: card.name.clone(),
                                                type_line: Some(card.type_line.clone()),
                                                identity: card.color_identity.clone(),
                                                price_usd: card.default_usd,
                                                cost: Some(rsx! { ManaCost { cost: card.mana_cost.clone(), size: 13 } }),
                                                action: Some(rsx! {
                                                    IconButton {
                                                        label: "Remove from collection".to_string(),
                                                        size: "sm".to_string(),
                                                        onclick: {
                                                            let id = card.oracle_id.clone();
                                                            move |_| remove_owned(state, id.clone(), rev)
                                                        },
                                                        Ico { svg: icons::MINUS }
                                                    }
                                                }),
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                },
                Some(None) => rsx! {
                    div { class: "col-empty", "Engine offline — collection unavailable." }
                },
                None => rsx! {
                    div { class: "col-empty", "Loading collection…" }
                },
            }
            if confirm_clear() {
                Dialog {
                    title: Some("Clear collection".to_string()),
                    description: Some("Remove every owned card from this session's collection?".to_string()),
                    on_close: move |_| confirm_clear.set(false),
                    footer: Some(rsx! {
                        Button { variant: "ghost".to_string(), onclick: move |_| confirm_clear.set(false), "Cancel" }
                        Button {
                            variant: "danger".to_string(),
                            onclick: move |_| {
                                let conn = (state.conn)();
                                spawn(async move {
                                    if let Some(client) = ready_client(&conn) {
                                        let _ = client.collection_clear().await;
                                        rev += 1;
                                    }
                                });
                                confirm_clear.set(false);
                            },
                            "Clear all"
                        }
                    }),
                    div { style: "font: var(--type-body-sm); color: var(--text-secondary);",
                        "This cannot be undone."
                    }
                }
            }
        }
    }
}

/// Removal = collection_set with the remaining ids (the engine is a Set; no
/// per-card remove tool exists — verified from collectionTools.ts).
fn remove_owned(state: crate::state::AppState, oracle_id: String, mut rev: Signal<u32>) {
    let conn = (state.conn)();
    spawn(async move {
        if let Some(client) = ready_client(&conn) {
            if let Ok(current) = client.collection_get().await {
                let remaining: Vec<String> = current
                    .owned
                    .into_iter()
                    .filter(|id| *id != oracle_id)
                    .collect();
                let _ = client.collection_set(&remaining).await;
                rev += 1;
            }
        }
    });
}
