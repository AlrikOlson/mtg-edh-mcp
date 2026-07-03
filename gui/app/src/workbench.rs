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

/// card_search-backed name suggestions (the collection.rs whole-word-fallback
/// pattern), with an optional grammar prefix like "is:commander" so the engine
/// pre-filters eligibility. An unmatched trailing partial word yields nothing,
/// so retry on the completed head words.
fn use_card_suggestions(input: Signal<String>, prefix: &'static str) -> impl Fn() -> Vec<String> {
    let state = use_app_state();
    let suggestions = use_resource(move || {
        let conn = (state.conn)();
        let frag = input().trim().to_string();
        async move {
            if frag.len() < 3 {
                return Vec::new();
            }
            let Some(client) = ready_client(&conn) else {
                return Vec::new();
            };
            let search = |q: String| {
                let client = client.clone();
                async move {
                    let query = if prefix.is_empty() { q } else { format!("{prefix} {q}") };
                    client
                        .card_search(mtg_edh_mcp_client::CardSearchParams {
                            query,
                            limit: Some(6),
                            ..Default::default()
                        })
                        .await
                        .map(|r| r.results.into_iter().map(|c| c.name).collect::<Vec<_>>())
                        .unwrap_or_default()
                }
            };
            let full = search(frag.clone()).await;
            if !full.is_empty() {
                return full;
            }
            match frag.rsplit_once(' ') {
                Some((head, _)) if head.len() >= 3 => search(head.to_string()).await,
                _ => Vec::new(),
            }
        }
    });
    move || suggestions.read().clone().unwrap_or_default()
}

use crate::state::{toast, toast_add_outcome, violation_text};

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
    // Shared cross-screen mutation counter (state.deck_rev).
    let mut rev = state.deck_rev;
    let mut filter99 = use_signal(String::new);
    let view = use_signal(|| "list".to_string());
    let group_by = use_signal(|| "type".to_string());
    let sort_by = use_signal(|| "mv".to_string());
    let mut collapsed = use_signal(HashSet::<String>::new);
    let mut show_create = use_signal(|| false);
    let mut new_name = use_signal(String::new);
    let mut new_commander = use_signal(String::new);
    let create_suggest = use_card_suggestions(new_commander, "is:commander");

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
            ids.extend(deck.companion.iter().cloned());
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
                    let partner_detail = deck.commanders.get(1).and_then(|id| details.get(id)).cloned();
                    let companion_detail = deck.companion.as_ref().and_then(|id| details.get(id)).cloned();
                    let errors = validation.as_ref().map(|v| v.errors.len()).unwrap_or(0);
                    let rail_deck_id = deck.deck_id.clone();
                    let rail_version = deck.version;
                    rsx! {
                        div { style: "flex: 1; display: flex; min-height: 0;",
                            div { style: "flex: 1; min-width: 400px; overflow-y: auto; display: flex; flex-direction: column;",
                        CommandZone {
                            deck: deck.clone(),
                            commander: commander_detail,
                            partner: partner_detail,
                            companion: companion_detail,
                        }
                            crate::oracle::OracleBar { deck_id: deck.deck_id.clone() }
                        DeckToolbar { deck: deck.clone(), errors, view, group_by, sort_by }
                        div { style: "padding: 0 var(--space-4) var(--space-2);",
                            div { class: "mb-input mb-input--sm", style: "max-width: 260px;",
                                input {
                                    r#type: "text",
                                    "data-filter": "the-99",
                                    placeholder: "Filter the 99…",
                                    value: filter99(),
                                    oninput: move |e| filter99.set(e.value()),
                                }
                            }
                        }
                        div { style: "padding: 0 var(--space-4) var(--space-6);",
                            for (key, group_cards) in groups.into_iter().filter_map(|(k, cards)| {
                                let q = filter99().trim().to_lowercase();
                                if q.is_empty() {
                                    return Some((k, cards));
                                }
                                let kept: Vec<_> = cards
                                    .into_iter()
                                    .filter(|c| {
                                        c.detail
                                            .as_ref()
                                            .map(|d| d.name.to_lowercase().contains(&q))
                                            .unwrap_or(false)
                                    })
                                    .collect();
                                (!kept.is_empty()).then_some((k, kept))
                            }) {
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
                                                if let Err(e) = client.deck_remove(&deck_id, &[(oracle_id, 1)]).await {
                                                    toast(state, "danger", format!("Remove failed: {e}"));
                                                }
                                                rev += 1;
                                            }
                                        });
                                    },
                                    on_add: {
                                        let details = details.clone();
                                        move |oracle_id: String| {
                                            let conn = (state.conn)();
                                            let deck_id = (state.active_deck_id)();
                                            let name = details
                                                .get(&oracle_id)
                                                .map(|d| d.name.clone())
                                                .unwrap_or_else(|| oracle_id.clone());
                                            spawn(async move {
                                                if let (Some(client), Some(deck_id)) = (ready_client(&conn), deck_id) {
                                                    let res = client.deck_add(&deck_id, &[(oracle_id, 1)]).await;
                                                    toast_add_outcome(state, &name, &res);
                                                    rev += 1;
                                                }
                                            });
                                        }
                                    },
                                }
                            }
                            if let Some(v) = validation {
                                ValidationPanel { validation: v.clone() }
                            }
                            IoPanel { deck_id: deck.deck_id.clone() }
                        }
                            }
                            crate::insights::InsightsRail { deck_id: rail_deck_id, version: rail_version }
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
                                    list: "create-cmdr-suggest",
                                    value: new_commander(),
                                    oninput: move |e| new_commander.set(e.value()),
                                }
                            }
                            datalist { id: "create-cmdr-suggest",
                                for name in create_suggest() {
                                    option { value: "{name}" }
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
fn CommandZone(
    deck: Deck,
    commander: Option<CardDetail>,
    partner: Option<CardDetail>,
    companion: Option<CardDetail>,
) -> Element {
    let state = use_app_state();
    let name = commander.as_ref().map(|c| c.name.clone());
    let mut editing = use_signal(|| false);
    let mut primary = use_signal(String::new);
    let mut second = use_signal(String::new);
    let mut kind = use_signal(|| "single".to_string());
    let mut companion_input = use_signal(String::new);
    // Engine verdict from the last rejected mutation; cleared on success.
    let mut verdict = use_signal(|| Option::<String>::None);
    let primary_suggest = use_card_suggestions(primary, "is:commander");
    // Backgrounds/Doctor's-companions aren't themselves `is:commander`; the
    // engine validates the pairing, so the second slot suggests by name only.
    let second_suggest = use_card_suggestions(second, "");
    let companion_suggest = use_card_suggestions(companion_input, "");

    let deck_id = deck.deck_id.clone();
    let set_commanders = move |_| {
        let conn = (state.conn)();
        let deck_id = deck_id.clone();
        let lead = primary().trim().to_string();
        let mate = second().trim().to_string();
        let zone_kind = kind();
        if lead.is_empty() {
            return;
        }
        spawn(async move {
            let Some(client) = ready_client(&conn) else {
                return;
            };
            let mut commanders = vec![lead];
            if zone_kind != "single" && !mate.is_empty() {
                commanders.push(mate);
            }
            match client
                .deck_set_commander(&deck_id, &commanders, Some(&zone_kind))
                .await
            {
                Ok(res) if res.ok => {
                    verdict.set(None);
                    editing.set(false);
                    primary.set(String::new());
                    second.set(String::new());
                    let mut rev = state.deck_rev;
                    rev += 1;
                }
                Ok(res) => {
                    let lines: Vec<String> = res.violations.iter().map(violation_text).collect();
                    verdict.set(Some(if lines.is_empty() {
                        "the engine rejected this command zone".to_string()
                    } else {
                        lines.join(" · ")
                    }));
                }
                Err(e) => verdict.set(Some(format!("{e}"))),
            }
        });
    };

    let deck_id_comp = deck.deck_id.clone();
    let has_companion = companion.is_some();
    let set_companion = move |_| {
        let conn = (state.conn)();
        let deck_id = deck_id_comp.clone();
        let raw = companion_input().trim().to_string();
        // Empty input with an existing companion = clear it.
        let request = if raw.is_empty() {
            if !has_companion {
                return;
            }
            None
        } else {
            Some(raw)
        };
        spawn(async move {
            let Some(client) = ready_client(&conn) else {
                return;
            };
            match client.deck_set_companion(&deck_id, request.as_deref()).await {
                Ok(res) if res.ok => {
                    verdict.set(None);
                    companion_input.set(String::new());
                    let mut rev = state.deck_rev;
                    rev += 1;
                }
                Ok(res) => {
                    let mut lines: Vec<String> = res.violations.iter().map(violation_text).collect();
                    if let Some(d) = res.detail {
                        lines.insert(0, d);
                    }
                    verdict.set(Some(lines.join(" · ")));
                }
                Err(e) => verdict.set(Some(format!("{e}"))),
            }
        });
    };

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
                    span { "data-cz": "edit",
                        Button {
                            variant: "ghost".to_string(),
                            size: "sm".to_string(),
                            onclick: move |_| {
                                verdict.set(None);
                                editing.toggle();
                            },
                            if editing() { "Cancel" } else if name.is_some() { "Change" } else { "Set commander" }
                        }
                    }
                }
                if !editing() {
                    div { class: "cz__name",
                        if let Some(c) = &commander { "{c.name}" } else { "No commander" }
                        if let Some(p) = &partner { " // {p.name}" }
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
                } else {
                    div { style: "display: flex; flex-direction: column; gap: var(--space-2); max-width: 460px;",
                        "data-cz": "editor",
                        div { style: "display: flex; gap: var(--space-2);",
                            div { class: "mb-input mb-input--sm", style: "flex: 1;",
                                input {
                                    r#type: "text",
                                    placeholder: "Commander…",
                                    list: "cz-suggest-primary",
                                    value: primary(),
                                    oninput: move |e| primary.set(e.value()),
                                }
                            }
                            datalist { id: "cz-suggest-primary",
                                for name in primary_suggest() {
                                    option { value: "{name}" }
                                }
                            }
                            select {
                                class: "mb-input mb-input--sm",
                                value: kind(),
                                onchange: move |e| kind.set(e.value()),
                                option { value: "single", "Single" }
                                option { value: "partner", "Partner" }
                                option { value: "background", "Background" }
                                option { value: "doctor_companion", "Doctor + companion" }
                            }
                        }
                        if kind() != "single" {
                            div { class: "mb-input mb-input--sm",
                                input {
                                    r#type: "text",
                                    placeholder: if kind() == "background" { "Background…" } else { "Second commander…" },
                                    list: "cz-suggest-second",
                                    value: second(),
                                    oninput: move |e| second.set(e.value()),
                                }
                            }
                            datalist { id: "cz-suggest-second",
                                for name in second_suggest() {
                                    option { value: "{name}" }
                                }
                            }
                        }
                        span { "data-cz": "apply",
                            Button {
                                variant: "primary".to_string(),
                                size: "sm".to_string(),
                                onclick: set_commanders,
                                "Set command zone"
                            }
                        }
                    }
                }
                // Companion — outside the 100, validated by the engine on set.
                div { style: "display: flex; align-items: center; gap: var(--space-2); margin-top: var(--space-2);",
                    "data-cz": "companion",
                    span { class: "cz__milbl", "Companion" }
                    if let Some(c) = &companion {
                        span { style: "font: var(--type-body-sm); color: var(--text-primary);", "{c.name}" }
                    }
                    div { class: "mb-input mb-input--sm", style: "width: 200px;",
                        input {
                            r#type: "text",
                            placeholder: if companion.is_some() { "Replace (empty = clear)…" } else { "None — set one…" },
                            list: "cz-suggest-companion",
                            value: companion_input(),
                            oninput: move |e| companion_input.set(e.value()),
                        }
                    }
                    datalist { id: "cz-suggest-companion",
                        for name in companion_suggest() {
                            option { value: "{name}" }
                        }
                    }
                    Button {
                        variant: "ghost".to_string(),
                        size: "sm".to_string(),
                        onclick: set_companion,
                        if companion.is_some() && companion_input().trim().is_empty() { "Clear" } else { "Set" }
                    }
                }
                if let Some(v) = verdict() {
                    div { "data-cz": "verdict",
                        Badge { tone: "danger".to_string(), dot: true, "{v}" }
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
    let state = use_app_state();
    let count: u32 = deck.cards.iter().map(|c| c.qty).sum();
    let mut renaming = use_signal(|| false);
    let mut rename_input = use_signal(String::new);
    // Two-step destructive delete: first click arms, second confirms.
    let mut confirm_delete = use_signal(|| false);

    let deck_id_rename = deck.deck_id.clone();
    let commit_rename = move |_| {
        let conn = (state.conn)();
        let deck_id = deck_id_rename.clone();
        let name = rename_input().trim().to_string();
        if name.is_empty() {
            renaming.set(false);
            return;
        }
        spawn(async move {
            let Some(client) = ready_client(&conn) else {
                return;
            };
            if let Ok(res) = client.deck_rename(&deck_id, &name).await {
                if res.ok {
                    let mut dname = state.active_deck_name;
                    dname.set(Some(res.name));
                    let mut rev = state.deck_rev;
                    rev += 1;
                }
            }
            renaming.set(false);
        });
    };

    let deck_id_delete = deck.deck_id.clone();
    let delete_deck = move |_| {
        if !confirm_delete() {
            confirm_delete.set(true);
            return;
        }
        let conn = (state.conn)();
        let deck_id = deck_id_delete.clone();
        spawn(async move {
            let Some(client) = ready_client(&conn) else {
                return;
            };
            if client.deck_delete(&deck_id).await.is_ok() {
                // Fall back like restore_session: newest remaining deck, or none.
                let mut did = state.active_deck_id;
                let mut dname = state.active_deck_name;
                match client.deck_list().await.ok().and_then(|l| l.decks.into_iter().next_back()) {
                    Some(next) => {
                        did.set(Some(next.deck_id));
                        dname.set(Some(next.name));
                    }
                    None => {
                        did.set(None);
                        dname.set(None);
                    }
                }
                let mut rev = state.deck_rev;
                rev += 1;
            }
            confirm_delete.set(false);
        });
    };

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
            if renaming() {
                div { class: "mb-input mb-input--sm", style: "width: 200px;", "data-deck": "rename",
                    input {
                        r#type: "text",
                        placeholder: "New deck name…",
                        value: rename_input(),
                        oninput: move |e| rename_input.set(e.value()),
                        onkeydown: move |e| {
                            if e.key() == Key::Escape {
                                renaming.set(false);
                            }
                        },
                    }
                }
                span {
                    Button {
                        variant: "secondary".to_string(),
                        size: "sm".to_string(),
                        onclick: commit_rename,
                        "Save"
                    }
                }
            } else {
                span { "data-deck": "rename-toggle",
                    Button {
                        variant: "ghost".to_string(),
                        size: "sm".to_string(),
                        onclick: {
                            let current = deck.name.clone();
                            move |_| {
                                rename_input.set(current.clone());
                                renaming.set(true);
                            }
                        },
                        "Rename"
                    }
                }
            }
            span { "data-deck": "delete",
                Button {
                    variant: if confirm_delete() { "danger".to_string() } else { "ghost".to_string() },
                    size: "sm".to_string(),
                    onclick: delete_deck,
                    if confirm_delete() { "Really delete?" } else { "Delete" }
                }
            }
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
    on_add: EventHandler<String>,
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
                                    div { style: "display: flex; align-items: center; gap: var(--space-1_5); width: 100%;",
                                        if card.qty > 1 {
                                            span { "data-qty": "{card.qty}", style: "font: var(--type-data-sm); color: var(--accent-text);", "×{card.qty}" }
                                        }
                                        IconButton {
                                            label: "Add one".to_string(),
                                            size: "sm".to_string(),
                                            onclick: {
                                                let id = card.oracle_id.clone();
                                                move |_| on_add.call(id.clone())
                                            },
                                            Ico { svg: icons::PLUS }
                                        }
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
                                qty: Some(card.qty),
                                illegal: card.illegal,
                                cost: card.detail.as_ref().map(|d| rsx! { ManaCost { cost: d.mana_cost.clone(), size: 13 } }),
                                action: Some(rsx! {
                                    IconButton {
                                        label: "Add one".to_string(),
                                        size: "sm".to_string(),
                                        onclick: {
                                            let id = card.oracle_id.clone();
                                            move |_| on_add.call(id.clone())
                                        },
                                        Ico { svg: icons::PLUS }
                                    }
                                    IconButton {
                                        label: "Remove one".to_string(),
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

/// Deck IO — import/export dialogs + the session's snapshot list with
/// diff/restore (gui-deck-io). The engine has no snapshot-list tool, so the
/// list is what this session captured (state.snapshots).
#[component]
fn IoPanel(deck_id: String) -> Element {
    let state = use_app_state();
    let mut show_import = use_signal(|| false);
    let mut show_export = use_signal(|| false);
    let mut import_text = use_signal(String::new);
    let mut import_report = use_signal(|| Option::<(u32, usize)>::None);
    let mut export_text = use_signal(String::new);
    let mut diff_view = use_signal(|| Option::<(String, Vec<String>)>::None);

    let import_id = deck_id.clone();
    let export_id = deck_id.clone();
    let snap_deck = deck_id.clone();

    rsx! {
        div { style: "margin-top: var(--space-5); display: flex; flex-direction: column; gap: var(--space-3); max-width: 620px;",
            "data-panel": "deck-io",
            div { style: "display: flex; align-items: center; gap: var(--space-2);",
                span { class: "deckctl__lbl", "Deck IO" }
                div { style: "flex: 1;" }
                Button {
                    variant: "secondary".to_string(),
                    size: "sm".to_string(),
                    onclick: move |_| show_import.set(true),
                    "Import"
                }
                Button {
                    variant: "secondary".to_string(),
                    size: "sm".to_string(),
                    onclick: {
                        let id = export_id.clone();
                        move |_| {
                            let conn = (state.conn)();
                            let id = id.clone();
                            spawn(async move {
                                if let Some(client) = crate::browse::ready_client(&conn) {
                                    if let Ok(out) = client.deck_export(&id).await {
                                        export_text.set(out.text);
                                        show_export.set(true);
                                    }
                                }
                            });
                        }
                    },
                    "Export"
                }
            }
            // Session snapshots (taken via the TopBar Snapshot button).
            if (state.snapshots)().is_empty() {
                div { style: "font: var(--type-body-sm); color: var(--text-muted);",
                    "No snapshots yet — use the Snapshot button in the top bar."
                }
            }
            for (snapshot_id, at_version) in (state.snapshots)() {
                div { style: "display: flex; align-items: center; gap: var(--space-2); font: var(--type-data-sm); color: var(--text-secondary);",
                    "data-snapshot": "{snapshot_id}",
                    span { "{snapshot_id}" }
                    span { style: "color: var(--text-faint);", "v{at_version}" }
                    div { style: "flex: 1;" }
                    Button {
                        variant: "ghost".to_string(),
                        size: "sm".to_string(),
                        onclick: {
                            let id = snap_deck.clone();
                            let sid = snapshot_id.clone();
                            move |_| {
                                let conn = (state.conn)();
                                let (id, sid) = (id.clone(), sid.clone());
                                spawn(async move {
                                    if let Some(client) = crate::browse::ready_client(&conn) {
                                        if let Ok(d) = client.deck_diff(&id, &sid).await {
                                            diff_view.set(Some((sid.clone(), diff_lines(&d.diff))));
                                        }
                                    }
                                });
                            }
                        },
                        "Diff"
                    }
                    Button {
                        variant: "ghost".to_string(),
                        size: "sm".to_string(),
                        onclick: {
                            let id = snap_deck.clone();
                            let sid = snapshot_id.clone();
                            move |_| {
                                let conn = (state.conn)();
                                let (id, sid) = (id.clone(), sid.clone());
                                let mut rev = state.deck_rev;
                                let mut snapshots = state.snapshots;
                                spawn(async move {
                                    if let Some(client) = crate::browse::ready_client(&conn) {
                                        if client.deck_restore(&id, &sid).await.is_ok() {
                                            rev += 1;
                                        } else {
                                            // Stale id (engine restarted) — prune it.
                                            let list: Vec<_> = snapshots()
                                                .into_iter()
                                                .filter(|(s, _)| *s != sid)
                                                .collect();
                                            snapshots.set(list);
                                        }
                                    }
                                });
                            }
                        },
                        "Restore"
                    }
                }
            }
            if let Some((sid, lines)) = diff_view() {
                div { class: "ic-callout", "data-diff": "{sid}",
                    Ico { svg: icons::GIT_COMPARE }
                    span {
                        b { "Diff vs {sid}" }
                        if lines.is_empty() {
                            " — no changes"
                        }
                        for line in lines {
                            div { style: "font: var(--type-data-sm);", "{line}" }
                        }
                    }
                }
            }
        }
        if show_import() {
            Dialog {
                title: Some("Import decklist".to_string()),
                description: Some("Moxfield / Archidekt / MTGO / Arena / plaintext. Unresolved lines are reported, never dropped.".to_string()),
                on_close: move |_| show_import.set(false),
                footer: Some(rsx! {
                    Button { variant: "ghost".to_string(), onclick: move |_| show_import.set(false), "Cancel" }
                    Button {
                        variant: "primary".to_string(),
                        onclick: {
                            let id = import_id.clone();
                            move |_| {
                                let conn = (state.conn)();
                                let text = import_text();
                                let id = id.clone();
                                let mut rev = state.deck_rev;
                                spawn(async move {
                                    if let Some(client) = crate::browse::ready_client(&conn) {
                                        if let Ok(result) =
                                            client.deck_import(&text, Some(&id), None).await
                                        {
                                            import_report.set(Some((
                                                result.resolved_count,
                                                result.unresolved.len(),
                                            )));
                                            rev += 1;
                                        }
                                    }
                                });
                            }
                        },
                        "Import"
                    }
                }),
                textarea {
                    style: "width: 100%; min-height: 180px; font: var(--type-data-sm); background: var(--surface-input); color: var(--text-primary); border: 1px solid var(--border-default); border-radius: var(--radius-sm); padding: var(--space-2);",
                    placeholder: "1 Sol Ring\n1 Arcane Signet\n…",
                    onchange: move |e| import_text.set(e.value()),
                    "{import_text()}"
                }
                if let Some((resolved, unresolved)) = import_report() {
                    div { style: "margin-top: var(--space-2);",
                        Badge {
                            tone: if unresolved == 0 { "success".to_string() } else { "warning".to_string() },
                            dot: true,
                            "{resolved} resolved · {unresolved} unresolved"
                        }
                    }
                }
            }
        }
        if show_export() {
            Dialog {
                title: Some("Export decklist".to_string()),
                on_close: move |_| show_export.set(false),
                footer: Some(rsx! {
                    Button { variant: "ghost".to_string(), onclick: move |_| show_export.set(false), "Close" }
                }),
                textarea {
                    readonly: true,
                    style: "width: 100%; min-height: 220px; font: var(--type-data-sm); background: var(--surface-input); color: var(--text-primary); border: 1px solid var(--border-default); border-radius: var(--radius-sm); padding: var(--space-2);",
                    "{export_text()}"
                }
            }
        }
    }
}

/// Row-level lines from the deck_diff payload (kept loose engine-side):
/// one "+/−/±  name-or-id" line per entry across the three change arrays.
fn diff_lines(diff: &mtg_edh_mcp_client::serde_json::Value) -> Vec<String> {
    let mut lines = Vec::new();
    let name_of = |e: &mtg_edh_mcp_client::serde_json::Value| {
        e.get("name")
            .or_else(|| e.get("oracle_id"))
            .and_then(|v| v.as_str())
            .unwrap_or("?")
            .to_string()
    };
    for (key, sign) in [("added", "+"), ("removed", "−"), ("qty_changed", "±")] {
        if let Some(entries) = diff.get(key).and_then(|v| v.as_array()) {
            for e in entries {
                lines.push(format!("{sign} {}", name_of(e)));
            }
        }
    }
    lines
}
