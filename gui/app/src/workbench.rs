//! Workbench — the Deck object's editor CORE, per reference/DeckEditor.jsx
//! (chrome vendored in assets/deckeditor.css). Oracle/what-if is gui-oracle;
//! import/export/snapshots are gui-deck-io. All data flows through the live
//! EngineClient.

use crate::browse::{ready_client, scryfall_image};
use crate::ds::*;
use crate::icons;
use crate::state::use_app_state;
use dioxus::prelude::*;
use mtg_edh_mcp_client::{CardDetail, Deck, DeckCreateParams};
use std::collections::{HashMap, HashSet};

/// Deck entry joined with its card detail (via one batched card_get).
#[derive(Clone, PartialEq)]
struct DeckCard {
    oracle_id: String,
    qty: u32,
    illegal: bool,
    detail: Option<CardDetail>,
}

fn group_key(card: &DeckCard, group_by: &str) -> String {
    let Some(d) = &card.detail else {
        return "Other".to_string();
    };
    let is_land = d.type_line.contains("Land");
    match group_by {
        "mv" => {
            if is_land {
                "Lands".to_string()
            } else if d.mv >= 7.0 {
                "MV 7+".to_string()
            } else {
                format!("MV {}", d.mv as u32)
            }
        }
        "color" => {
            if is_land {
                "Lands".to_string()
            } else {
                match d.color_identity.len() {
                    0 => "Colorless".to_string(),
                    1 => match d.color_identity[0].as_str() {
                        "W" => "White".into(),
                        "U" => "Blue".into(),
                        "B" => "Black".into(),
                        "R" => "Red".into(),
                        "G" => "Green".into(),
                        other => other.to_string(),
                    },
                    _ => "Multicolor".to_string(),
                }
            }
        }
        "role" => {
            if is_land {
                "Lands".to_string()
            } else {
                d.roles
                    .iter()
                    .find(|r| *r != "land")
                    .map(|r| {
                        let spaced = r.replace('_', " ");
                        let mut c = spaced.chars();
                        match c.next() {
                            Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                            None => spaced,
                        }
                    })
                    .unwrap_or_else(|| "Other".to_string())
            }
        }
        // "type" (default): first matching primary type, per the reference.
        _ => {
            const TYPES: [&str; 7] = [
                "Creature",
                "Planeswalker",
                "Instant",
                "Sorcery",
                "Artifact",
                "Enchantment",
                "Land",
            ];
            TYPES
                .iter()
                .find(|t| d.type_line.contains(*t))
                .map(|t| t.to_string())
                .unwrap_or_else(|| "Other".to_string())
        }
    }
}

fn sort_cards(cards: &mut [DeckCard], sort_by: &str) {
    cards.sort_by(|a, b| {
        let (da, db) = (&a.detail, &b.detail);
        let name = |c: &Option<CardDetail>| c.as_ref().map(|d| d.name.clone()).unwrap_or_default();
        match sort_by {
            "name" => name(da).cmp(&name(db)),
            "price" => {
                let p =
                    |c: &Option<CardDetail>| c.as_ref().and_then(|d| d.default_usd).unwrap_or(0.0);
                p(db)
                    .partial_cmp(&p(da))
                    .unwrap_or(std::cmp::Ordering::Equal)
            }
            _ => {
                let mv = |c: &Option<CardDetail>| c.as_ref().map(|d| d.mv).unwrap_or(0.0);
                mv(da)
                    .partial_cmp(&mv(db))
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then(name(da).cmp(&name(db)))
            }
        }
    });
}

fn ci_var(identity: &[String]) -> String {
    match identity.first().map(String::as_str) {
        Some("W") => "var(--mtg-w)".into(),
        Some("U") => "var(--mtg-u)".into(),
        Some("B") => "var(--mtg-b)".into(),
        Some("R") => "var(--mtg-r)".into(),
        Some("G") => "var(--mtg-g)".into(),
        _ => "var(--mtg-c)".into(),
    }
}

#[component]
pub fn WorkbenchScreen() -> Element {
    let state = use_app_state();
    // Bumped after every mutation so resources refetch.
    let mut rev = use_signal(|| 0u32);
    let view = use_signal(|| "list".to_string());
    let group_by = use_signal(|| "type".to_string());
    let sort_by = use_signal(|| "mv".to_string());
    let mut collapsed = use_signal(HashSet::<String>::new);
    let mut show_create = use_signal(|| false);
    let mut new_name = use_signal(String::new);
    let mut new_commander = use_signal(String::new);

    // The active deck + joined card details (deck_get lean + one batched card_get).
    let deck_data = use_resource(move || {
        let conn = (state.conn)();
        let deck_id = (state.active_deck_id)();
        let _ = rev();
        async move {
            let client = ready_client(&conn)?;
            let deck_id = deck_id?;
            let deck = client.deck_get(&deck_id).await.ok()?.deck;
            let mut ids: Vec<String> = deck.cards.iter().map(|c| c.oracle_id.clone()).collect();
            ids.extend(deck.commanders.iter().cloned());
            let details: HashMap<String, CardDetail> = if ids.is_empty() {
                HashMap::new()
            } else {
                client
                    .card_get(&ids)
                    .await
                    .map(|r| {
                        r.cards
                            .into_iter()
                            .map(|c| (c.oracle_id.clone(), c))
                            .collect()
                    })
                    .unwrap_or_default()
            };
            let validation = client.validate_deck(&deck_id).await.ok();
            Some((deck, details, validation))
        }
    });

    let create_deck = move |_| {
        let conn = (state.conn)();
        let name = new_name().trim().to_string();
        let commander = new_commander().trim().to_string();
        if name.is_empty() {
            return;
        }
        spawn(async move {
            if let Some(client) = ready_client(&conn) {
                let params = DeckCreateParams {
                    name,
                    format: Some("commander".into()),
                    commanders: if commander.is_empty() {
                        Vec::new()
                    } else {
                        vec![commander]
                    },
                    ..Default::default()
                };
                if let Ok(created) = client.deck_create(params).await {
                    let mut ids = state.active_deck_id;
                    ids.set(Some(created.deck_id));
                    let mut names = state.active_deck_name;
                    names.set(Some(
                        created
                            .deck
                            .get("name")
                            .and_then(|v| v.as_str())
                            .unwrap_or("deck")
                            .to_string(),
                    ));
                }
            }
        });
        show_create.set(false);
    };

    rsx! {
        div { style: "flex: 1; display: flex; flex-direction: column; min-width: 0; overflow-y: auto;",
            match &*deck_data.read() {
                Some(Some((deck, details, validation))) => {
                    let mut cards: Vec<DeckCard> = deck.cards.iter().map(|e| DeckCard {
                        oracle_id: e.oracle_id.clone(),
                        qty: e.qty,
                        illegal: e.illegal,
                        detail: details.get(&e.oracle_id).cloned(),
                    }).collect();
                    sort_cards(&mut cards, &sort_by());
                    let mut groups: Vec<(String, Vec<DeckCard>)> = Vec::new();
                    for card in cards {
                        let key = group_key(&card, &group_by());
                        match groups.iter_mut().find(|(k, _)| *k == key) {
                            Some((_, list)) => list.push(card),
                            None => groups.push((key, vec![card])),
                        }
                    }
                    let commander_detail = deck.commanders.first().and_then(|id| details.get(id)).cloned();
                    let errors = validation.as_ref().map(|v| v.errors.len()).unwrap_or(0);
                    rsx! {
                        CommandZone { deck: deck.clone(), commander: commander_detail }
                        DeckToolbar { deck: deck.clone(), errors, view, group_by, sort_by }
                        div { style: "padding: 0 var(--space-4) var(--space-6);",
                            for (key, group_cards) in groups {
                                DeckGroup {
                                    name: key.clone(),
                                    cards: group_cards,
                                    view: view(),
                                    collapsed: collapsed().contains(&key),
                                    on_toggle: move |k: String| {
                                        let mut set = collapsed();
                                        if !set.remove(&k) { set.insert(k); }
                                        collapsed.set(set);
                                    },
                                    on_remove: move |oracle_id: String| {
                                        let conn = (state.conn)();
                                        let deck_id = (state.active_deck_id)();
                                        spawn(async move {
                                            if let (Some(client), Some(deck_id)) = (ready_client(&conn), deck_id) {
                                                let _ = client.deck_remove(&deck_id, &[(oracle_id, 1)]).await;
                                                rev += 1;
                                            }
                                        });
                                    },
                                }
                            }
                            if let Some(v) = validation {
                                ValidationPanel { validation: v.clone() }
                            }
                        }
                    }
                },
                Some(None) => rsx! {
                    div { style: "flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: var(--space-3); color: var(--text-muted);",
                        h2 { style: "font: var(--type-h1); color: var(--text-secondary); margin: 0;", "No deck" }
                        p { style: "font: var(--type-body-sm); margin: 0;", "Create a deck to start building." }
                        Button {
                            variant: "primary".to_string(),
                            onclick: move |_| show_create.set(true),
                            "New deck"
                        }
                    }
                },
                None => rsx! {
                    div { style: "padding: var(--space-6); color: var(--text-muted); font: var(--type-body-sm);", "Loading deck…" }
                },
            }
            if show_create() {
                Dialog {
                    title: Some("New deck".to_string()),
                    description: Some("Choose a commander to set the color identity.".to_string()),
                    on_close: move |_| show_create.set(false),
                    footer: Some(rsx! {
                        Button { variant: "ghost".to_string(), onclick: move |_| show_create.set(false), "Cancel" }
                        Button { variant: "primary".to_string(), onclick: create_deck, "Create" }
                    }),
                    div { style: "display: flex; flex-direction: column; gap: var(--space-3);",
                        div { class: "mb-field",
                            label { class: "mb-field__label", "Deck name" }
                            div { class: "mb-input mb-input--md",
                                input {
                                    r#type: "text",
                                    placeholder: "Atraxa Superfriends",
                                    value: new_name(),
                                    onchange: move |e| new_name.set(e.value()),
                                }
                            }
                        }
                        div { class: "mb-field",
                            label { class: "mb-field__label", "Commander (name or oracle_id)" }
                            div { class: "mb-input mb-input--md",
                                input {
                                    r#type: "text",
                                    placeholder: "Atraxa, Praetors' Voice",
                                    value: new_commander(),
                                    onchange: move |e| new_commander.set(e.value()),
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

#[component]
fn CommandZone(deck: Deck, commander: Option<CardDetail>) -> Element {
    let name = commander.as_ref().map(|c| c.name.clone());
    rsx! {
        div { class: "cz",
            div { class: "cz__base" }
            if let Some(n) = &name {
                img { class: "cz__art loaded", src: scryfall_image(n), alt: "{n}" }
            }
            div { class: "cz__scrim" }
            div { class: "cz__body",
                span { class: "cz__eyebrow",
                    Ico { svg: icons::CROWN }
                    "Command zone"
                }
                div { class: "cz__name",
                    if let Some(c) = &commander { "{c.name}" } else { "No commander" }
                }
                if let Some(c) = &commander {
                    div { class: "cz__type", "{c.type_line}" }
                    div { class: "cz__row",
                        span { class: "cz__mi",
                            span { class: "cz__milbl", "Cost" }
                            ManaCost { cost: c.mana_cost.clone() }
                        }
                        span { class: "cz__div" }
                        span { class: "cz__mi",
                            span { class: "cz__milbl", "Identity" }
                            ColorIdentity { identity: deck.computed_color_identity.clone() }
                        }
                    }
                }
                div { class: "cz__chips",
                    span { class: "cz__chip cz__chip--lead", "v{deck.version}" }
                    span { class: "cz__chip", "{deck.name}" }
                }
            }
        }
    }
}

#[component]
fn DeckToolbar(
    deck: Deck,
    errors: usize,
    view: Signal<String>,
    group_by: Signal<String>,
    sort_by: Signal<String>,
) -> Element {
    let count: u32 = deck.cards.iter().map(|c| c.qty).sum();
    rsx! {
        div { style: "display: flex; align-items: center; gap: var(--space-3); padding: var(--space-3) var(--space-4) 0;",
            span { style: "font: var(--type-h2); color: var(--text-primary);", "The 99" }
            Badge {
                tone: if count + 1 == 100 { "success".to_string() } else { "warning".to_string() },
                mono: true,
                "{count + 1}/100"
            }
            if errors > 0 {
                Badge { tone: "danger".to_string(), dot: true, "{errors} error(s)" }
            } else {
                Badge { tone: "success".to_string(), dot: true, "Legal" }
            }
            div { style: "flex: 1;" }
            SegmentedControl {
                options: vec![
                    SegOption { value: "list", label: "List", icon: Some(icons::LIST) },
                    SegOption { value: "cards", label: "Cards", icon: Some(icons::VIEW_GRID) },
                ],
                value: view(),
                on_change: move |v: String| view.set(v),
            }
        }
        div { class: "deckctl",
            span { class: "deckctl__lbl", "Group" }
            div { class: "deckseg",
                for (value, label) in [("type", "Type"), ("mv", "MV"), ("color", "Color"), ("role", "Role")] {
                    button {
                        class: if group_by() == value { "on" } else { "" },
                        onclick: move |_| group_by.set(value.to_string()),
                        "{label}"
                    }
                }
            }
            div { style: "flex: 1;" }
            span { class: "deckctl__lbl", "Sort" }
            div { class: "deckseg",
                for (value, label) in [("mv", "MV"), ("name", "Name"), ("price", "$")] {
                    button {
                        class: if sort_by() == value { "on" } else { "" },
                        onclick: move |_| sort_by.set(value.to_string()),
                        "{label}"
                    }
                }
            }
        }
    }
}

#[component]
fn DeckGroup(
    name: String,
    cards: Vec<DeckCard>,
    view: String,
    collapsed: bool,
    on_toggle: EventHandler<String>,
    on_remove: EventHandler<String>,
) -> Element {
    let count: u32 = cards.iter().map(|c| c.qty).sum();
    let total: f64 = cards
        .iter()
        .filter_map(|c| c.detail.as_ref().and_then(|d| d.default_usd))
        .sum();
    let key = name.clone();
    rsx! {
        div { class: "deckgroup__hd", onclick: move |_| on_toggle.call(key.clone()),
            span {
                class: if collapsed { "deckgroup__chev collapsed" } else { "deckgroup__chev" },
                Ico { svg: icons::NAV_ARROW_DOWN }
            }
            span { class: "deckgroup__t", "{name}" }
            span { class: "deckgroup__n", "{count}" }
            div { style: "flex: 1;" }
            span { class: "deckgroup__price", "${total:.2}" }
        }
        if !collapsed {
            if view == "cards" {
                div { class: "deckgrid",
                    for card in cards {
                        if let Some(d) = card.detail.clone() {
                            CardTile {
                                name: d.name.clone(),
                                type_line: Some(d.type_line.clone()),
                                identity: d.color_identity.clone(),
                                price_usd: d.default_usd,
                                image: Some(scryfall_image(&d.name)),
                                cost: Some(rsx! { ManaCost { cost: d.mana_cost.clone(), size: 12 } }),
                                footer: Some(rsx! {
                                    Button {
                                        variant: "ghost".to_string(),
                                        size: "sm".to_string(),
                                        full_width: true,
                                        onclick: {
                                            let id = card.oracle_id.clone();
                                            move |_| on_remove.call(id.clone())
                                        },
                                        "Remove"
                                    }
                                }),
                            }
                        }
                    }
                }
            } else {
                div { class: "deckgroup__body", style: "display: flex; flex-direction: column; gap: 2px;",
                    for card in cards {
                        div {
                            class: "deckrow",
                            style: "--ci: {ci_var(card.detail.as_ref().map(|d| d.color_identity.as_slice()).unwrap_or(&[]))};",
                            CardRow {
                                name: card.detail.as_ref().map(|d| d.name.clone()).unwrap_or_else(|| card.oracle_id.clone()),
                                type_line: card.detail.as_ref().map(|d| d.type_line.clone()),
                                identity: card.detail.as_ref().map(|d| d.color_identity.clone()).unwrap_or_default(),
                                price_usd: card.detail.as_ref().and_then(|d| d.default_usd),
                                illegal: card.illegal,
                                cost: card.detail.as_ref().map(|d| rsx! { ManaCost { cost: d.mana_cost.clone(), size: 13 } }),
                                action: Some(rsx! {
                                    IconButton {
                                        label: "Remove".to_string(),
                                        size: "sm".to_string(),
                                        onclick: {
                                            let id = card.oracle_id.clone();
                                            move |_| on_remove.call(id.clone())
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
}

#[component]
fn ValidationPanel(validation: mtg_edh_mcp_client::ValidateDeckResult) -> Element {
    rsx! {
        div { style: "margin-top: var(--space-5); display: flex; flex-direction: column; gap: var(--space-2); max-width: 620px;",
            div { class: "deckctl__lbl", "Validation" }
            if validation.violations.is_empty() {
                Badge { tone: "success".to_string(), dot: true, "Legal — no violations" }
            }
            for v in validation.violations.iter().take(12) {
                ValidationItem {
                    rule: v.get("rule").and_then(|x| x.as_str()).unwrap_or("RULE").to_string(),
                    severity: v.get("severity").and_then(|x| x.as_str()).unwrap_or("error").to_string(),
                    card: v.get("card").and_then(|x| x.as_str()).map(String::from),
                    detail: v.get("detail").and_then(|x| x.as_str()).map(String::from),
                    fix_hint: v.get("fix_hint").and_then(|x| x.as_str()).map(String::from),
                }
            }
        }
    }
}
