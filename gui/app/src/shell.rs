//! The Manabase app shell — faithful port of reference/app.jsx: icon nav rail
//! (spring gold indicator, tooltip flyouts), top bar (deck identity, badges,
//! ⌘K affordance, Snapshot), and the signal-keyed screen router. The reference
//! routes with ONE state value (no URLs), so a signal — not dioxus-router —
//! is the faithful mechanism.

use crate::ds::*;
use crate::icons;
use crate::state::{connect, use_provide_app_state, ConnState};
use dioxus::prelude::*;

#[derive(Clone, Copy, PartialEq)]
pub enum Screen {
    Browse,
    Workbench,
    Collection,
    Gallery,
}

/// Rail order — index drives the spring indicator's `top`.
const SCREENS: [(Screen, &str, &str); 4] = [
    (Screen::Browse, "Browse", icons::SEARCH),
    (Screen::Workbench, "Workbench", icons::BOOKMARK_BOOK),
    (Screen::Collection, "Collection", icons::ARCHIVE),
    (Screen::Gallery, "Gallery", icons::FLASK),
];

#[component]
pub fn AppShell() -> Element {
    let state = use_provide_app_state();
    let active = use_signal(|| Screen::Workbench);
    let light = use_signal(|| false);
    use_effect(move || {
        let script = if light() {
            "document.documentElement.dataset.theme = 'light'"
        } else {
            "delete document.documentElement.dataset.theme"
        };
        document::eval(script);
    });

    rsx! {
        div { style: "display: flex; height: 100vh; width: 100%; background: var(--surface-canvas); overflow: hidden;",
            NavRail { active, light }
            div { style: "flex: 1; display: flex; flex-direction: column; min-width: 0;",
                TopBar {}
                match active() {
                    Screen::Gallery => rsx! {
                        div { style: "flex: 1; overflow-y: auto;", crate::gallery::Gallery {} }
                    },
                    Screen::Browse => rsx! {
                        crate::browse::BrowseScreen {}
                    },
                    Screen::Workbench => rsx! {
                        crate::workbench::WorkbenchScreen {}
                    },
                    Screen::Collection => rsx! {
                        crate::collection::CollectionScreen {}
                    },
                }
            }
        }
        // Engine-offline banner with retry, per the graceful-degradation ethos.
        if let ConnState::Offline(reason) = (state.conn)() {
            div { style: "position: fixed; bottom: var(--space-4); left: 50%; transform: translateX(-50%); z-index: 40; display: flex; align-items: center; gap: var(--space-3); background: var(--surface-overlay); border: 1px solid var(--border-strong); border-radius: var(--radius-md); box-shadow: var(--shadow-3); padding: var(--space-2_5) var(--space-4);",
                "data-conn": "offline",
                Badge { tone: "danger".to_string(), dot: true, "Engine offline" }
                span { style: "font: var(--type-body-sm); color: var(--text-secondary); max-width: 480px;",
                    "{reason}"
                }
                Button {
                    variant: "secondary".to_string(),
                    size: "sm".to_string(),
                    onclick: move |_| connect(state),
                    "Retry"
                }
            }
        }
    }
}

#[component]
fn NavRail(active: Signal<Screen>, light: Signal<bool>) -> Element {
    // 42px item + var(--space-2) (8px) gap — drives the indicator like the
    // reference's offsetTop measurement.
    let idx = SCREENS
        .iter()
        .position(|(s, _, _)| *s == active())
        .unwrap_or(0);
    let ind_top = idx * 50;
    rsx! {
        div { style: "width: var(--rail-nav); flex: none; border-right: 1px solid var(--border-subtle); background: var(--surface-base); display: flex; flex-direction: column; align-items: center; padding: var(--space-3) 0; gap: var(--space-3);",
            img {
                src: crate::logo_url(),
                alt: "Manabase",
                style: "width: 32px; height: 32px; margin-bottom: var(--space-1);",
            }
            nav { class: "mb-nav",
                div { class: "mb-nav__ind", style: "top: {ind_top}px;" }
                for (screen, label, icon) in SCREENS {
                    button {
                        class: if active() == screen { "mb-nav__item mb-nav__item--active" } else { "mb-nav__item" },
                        "data-label": "{label}",
                        aria_label: "{label}",
                        aria_current: if active() == screen { "page" } else { "false" },
                        onclick: move |_| active.set(screen),
                        Ico { svg: icon }
                    }
                }
            }
            div { style: "flex: 1;" }
            Tooltip {
                content: if light() { "Dark theme".to_string() } else { "Light theme".to_string() },
                IconButton {
                    label: "Toggle theme".to_string(),
                    onclick: move |_| light.toggle(),
                    Ico { svg: if light() { icons::HALF_MOON } else { icons::SUN_LIGHT } }
                }
            }
            Tooltip { content: "Settings".to_string(),
                IconButton { label: "Settings".to_string(), Ico { svg: icons::SETTINGS } }
            }
        }
    }
}

#[component]
fn TopBar() -> Element {
    let state = crate::state::use_app_state();
    let conn = (state.conn)();
    rsx! {
        div { style: "height: var(--topbar-h); flex: none; border-bottom: 1px solid var(--border-subtle); background: var(--surface-panel); display: flex; align-items: center; gap: var(--space-3); padding: 0 var(--space-4); min-width: 0; overflow: hidden;",
            div { style: "font: var(--type-h2); display: flex; align-items: center; gap: var(--space-2); white-space: nowrap; min-width: 0; flex: 0 1 auto;",
                span { style: "color: var(--accent-text); display: inline-flex; font-size: 18px;",
                    Ico { svg: icons::CROWN }
                }
                span { class: "mb-tb__name",
                    if let Some(name) = (state.active_deck_name)() {
                        "{name}"
                    } else {
                        "No deck"
                    }
                }
                DeckSwitcher {}
            }
            span { class: "mb-tb__div" }
            ColorIdentity { identity: vec![], size: 15 }
            // Connection status — the shell's live state, styled per the badge grammar.
            match conn {
                ConnState::Connecting => rsx! {
                    span { "data-conn": "connecting", style: "display: contents;",
                        Badge { tone: "warning".to_string(), dot: true, "Connecting" }
                    }
                },
                ConnState::Ready(_) => rsx! {
                    span { "data-conn": "ready", style: "display: contents;",
                        Badge { tone: "success".to_string(), dot: true, "Engine ready" }
                    }
                },
                ConnState::Offline(_) => rsx! {
                    span { "data-conn": "offline", style: "display: contents;",
                        Badge { tone: "danger".to_string(), dot: true, "Engine offline" }
                    }
                },
            }
            div { style: "flex: 1;" }
            span { class: "mb-cmdk", role: "button", tabindex: "0",
                Ico { svg: icons::SEARCH }
                span { class: "mb-cmdk__lbl", " Search the universe " }
                span { class: "mb-cmdk__kbd", "⌘K" }
            }
            span { class: "mb-tb__div mb-tb__hide-lg" }
            Button {
                variant: "primary".to_string(),
                size: "sm".to_string(),
                disabled: (state.active_deck_id)().is_none(),
                leading_icon: Some(rsx! {
                    Ico { svg: icons::FLOPPY_DISK }
                }),
                onclick: move |_| {
                    let conn = (state.conn)();
                    let deck_id = (state.active_deck_id)();
                    let mut snapshots = state.snapshots;
                    spawn(async move {
                        if let (Some(client), Some(deck_id)) =
                            (crate::browse::ready_client(&conn), deck_id)
                        {
                            if let Ok(snap) = client.deck_snapshot(&deck_id).await {
                                let mut list = snapshots();
                                list.push((snap.snapshot_id, snap.version));
                                snapshots.set(list);
                            }
                        }
                    });
                },
                "Snapshot"
            }
        }
    }
}

#[component]
fn Placeholder(title: &'static str, note: &'static str) -> Element {
    rsx! {
        div { style: "flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: var(--space-2); color: var(--text-muted);",
            h2 { style: "font: var(--type-h1); color: var(--text-secondary); margin: 0;", "{title}" }
            p { style: "font: var(--type-body-sm); margin: 0;", "{note}" }
        }
    }
}

/// The deck switcher (gui-persist): deck_list behind a native select, mapping
/// the chosen deck_id into the shared active-deck signals. Doubles as the
/// visible surface of the restore-on-boot fallback listing.
#[component]
fn DeckSwitcher() -> Element {
    let state = crate::state::use_app_state();
    let decks = use_resource(move || {
        let conn = (state.conn)();
        let _ = (state.deck_rev)();
        async move {
            match conn {
                ConnState::Ready(client) => client.deck_list().await.ok().map(|l| {
                    l.decks
                        .into_iter()
                        .map(|d| (d.deck_id, d.name))
                        .collect::<Vec<_>>()
                }),
                _ => None,
            }
        }
    });
    let list = decks.read().clone().flatten().unwrap_or_default();
    if list.len() < 2 {
        return rsx! {};
    }
    let active = (state.active_deck_id)();
    rsx! {
        select {
            class: "mb-select mb-select--sm",
            "data-switcher": "deck",
            style: "max-width: 160px;",
            onchange: move |e| {
                let id = e.value();
                if let Some(Some(all)) = &*decks.read() {
                    if let Some((deck_id, name)) = all.iter().find(|(d, _)| *d == id) {
                        let mut did = state.active_deck_id;
                        let mut dname = state.active_deck_name;
                        did.set(Some(deck_id.clone()));
                        dname.set(Some(name.clone()));
                    }
                }
            },
            for (deck_id, name) in list {
                option {
                    value: "{deck_id}",
                    selected: Some(deck_id.clone()) == active,
                    "{name}"
                }
            }
        }
    }
}
