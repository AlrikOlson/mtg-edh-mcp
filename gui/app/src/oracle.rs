//! The Oracle — the in-app agent (gui-oracle). HONEST v1: a structured-intent
//! brain (recorded decision think:142 — no LLM; the vocabulary is typed intents
//! mapped to REAL engine tool sequences). Captions stream as each real call
//! completes (event-driven signal updates, not the reference's setTimeout
//! theater). Chrome classes (.ask/.chip/.cap/.prow/...) were vendored with
//! deckeditor.css. What-if ghost overlays are gui-oracle-whatif.

use crate::browse::ready_client;
use crate::ds::*;
use crate::icons;
use crate::state::{use_app_state, WhatIf};
use dioxus::prelude::*;
use mtg_edh_mcp_client::{CardSearchParams, EngineClient};
use std::sync::Arc;

#[derive(Clone, Copy, PartialEq)]
enum Phase {
    Idle,
    Thinking,
    Proposing,
}

/// One streamed tool-call caption; `result: None` = live (in flight).
#[derive(Clone, PartialEq)]
struct Cap {
    tool: &'static str,
    args: String,
    result: Option<String>,
}

#[derive(Clone, PartialEq)]
struct ProposedCard {
    oracle_id: String,
    name: String,
    role: String,
    reason: String,
}

#[derive(Clone, PartialEq, Default)]
struct ChangeSet {
    adds: Vec<ProposedCard>,
    cuts: Vec<ProposedCard>,
    summary: String,
}

const CHIPS: [(&str, &str); 3] = [
    ("staples", "Add missing staples"),
    ("fixlegal", "Fix legality errors"),
    ("trim", "Trim the cost drivers"),
];

/// Map free text to an intent id; anything unmatched is a card search.
fn match_intent(input: &str) -> &'static str {
    let q = input.to_lowercase();
    if q.contains("legal") || q.contains("fix") {
        "fixlegal"
    } else if q.contains("staple") || q.contains("consistent") || q.contains("recommend") {
        "staples"
    } else if q.contains("trim")
        || q.contains("expensive")
        || q.contains("budget")
        || q.contains("cut")
    {
        "trim"
    } else {
        "search"
    }
}

#[component]
pub fn OracleBar(deck_id: String) -> Element {
    let state = use_app_state();
    let mut phase = use_signal(|| Phase::Idle);
    let mut input = use_signal(String::new);
    let mut caps = use_signal(Vec::<Cap>::new);
    let mut proposal = use_signal(ChangeSet::default);
    let mut flash = use_signal(Vec::<String>::new);

    // ⌘K focuses the ask input (shell button shows the same hint).
    use_effect(move || {
        document::eval(
            r#"document.addEventListener('keydown', (e) => {
                if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
                    e.preventDefault();
                    document.querySelector('.ask__in')?.focus();
                }
            });"#,
        );
    });

    let run = {
        let deck_id = deck_id.clone();
        move |query: String| {
            let conn = (state.conn)();
            let deck_id = deck_id.clone();
            phase.set(Phase::Thinking);
            caps.set(Vec::new());
            proposal.set(ChangeSet::default());
            spawn(async move {
                let Some(client) = ready_client(&conn) else {
                    phase.set(Phase::Idle);
                    return;
                };
                let intent = match_intent(&query);
                let set = run_intent(&client, &deck_id, intent, &query, caps).await;
                if set.adds.is_empty() && set.cuts.is_empty() {
                    caps.write().push(Cap {
                        tool: "oracle",
                        args: String::new(),
                        result: Some("nothing to propose".into()),
                    });
                    phase.set(Phase::Idle);
                } else {
                    // What-if projection BEFORE Proposing: the deck is mutated
                    // transiently here, so Accept/Reject cannot race it — they
                    // only become possible once the restore has completed.
                    let projected = project_whatif(&client, &deck_id, &set, caps).await;
                    let mut whatif = state.whatif;
                    whatif.set(projected);
                    proposal.set(set);
                    phase.set(Phase::Proposing);
                }
            });
        }
    };

    let accept = {
        let deck_id = deck_id.clone();
        move || {
            let conn = (state.conn)();
            let deck_id = deck_id.clone();
            let set = proposal();
            let mut rev = state.deck_rev;
            spawn(async move {
                if let Some(client) = ready_client(&conn) {
                    if !set.cuts.is_empty() {
                        let cuts: Vec<(String, u32)> =
                            set.cuts.iter().map(|c| (c.oracle_id.clone(), 1)).collect();
                        let _ = client.deck_remove(&deck_id, &cuts).await;
                    }
                    if !set.adds.is_empty() {
                        let cards: Vec<(String, u32)> =
                            set.adds.iter().map(|c| (c.oracle_id.clone(), 1)).collect();
                        // Verdicts are the engine's pre-check gate; illegal adds
                        // are rejected server-side, never silently forced.
                        let _ = client.deck_add(&deck_id, &cards).await;
                    }
                    flash.set(set.adds.iter().map(|c| c.name.clone()).collect());
                    rev += 1;
                }
            });
            proposal.set(ChangeSet::default());
            caps.set(Vec::new());
            let mut whatif = state.whatif;
            whatif.set(None);
            phase.set(Phase::Idle);
        }
    };
    let reject = move || {
        proposal.set(ChangeSet::default());
        caps.set(Vec::new());
        let mut whatif = state.whatif;
        whatif.set(None);
        phase.set(Phase::Idle);
    };

    rsx! {
        div { "data-oracle": "bar",
            div { class: if phase() == Phase::Thinking { "ask ask--active" } else { "ask" },
                span { class: if phase() == Phase::Thinking { "orb orb--think" } else { "orb" },
                    img { src: crate::logo_url(), alt: "" }
                }
                input {
                    class: "ask__in",
                    r#type: "text",
                    placeholder: "Ask the Oracle to refine your deck… (scripted intents v1)",
                    value: input(),
                    onchange: move |e| input.set(e.value()),
                    onkeydown: {
                        let mut run = run.clone();
                        let mut accept = accept.clone();
                        let mut reject = reject;
                        move |e: KeyboardEvent| match e.key() {
                            Key::Enter => {
                                if phase() == Phase::Proposing {
                                    accept();
                                } else if phase() == Phase::Idle && !input().trim().is_empty() {
                                    run(input());
                                }
                            }
                            Key::Escape if phase() == Phase::Proposing => reject(),
                            _ => {}
                        }
                    },
                }
                if phase() == Phase::Thinking {
                    span { style: "font: var(--type-label-sm); color: var(--accent-text);", "Working…" }
                } else {
                    span { class: "ask__kbd", "⌘K" }
                }
            }
            if phase() == Phase::Idle {
                div { class: "chips",
                    for (id, label) in CHIPS {
                        button {
                            class: "chip",
                            "data-intent": "{id}",
                            onclick: {
                                let mut run = run.clone();
                                move |_| run(label.to_string())
                            },
                            Ico { svg: icons::SPARKS }
                            "{label}"
                        }
                    }
                }
            }
            if !caps().is_empty() {
                div { class: "stream",
                    for cap in caps() {
                        div { class: if cap.result.is_none() { "cap cap--live" } else { "cap" },
                            span { class: "cap__tick",
                                if cap.result.is_none() {
                                    Ico { svg: icons::NAV_ARROW_RIGHT }
                                } else {
                                    Ico { svg: icons::CHECK }
                                }
                            }
                            span { class: "cap__tool mb-mono", "{cap.tool}" }
                            span { class: "cap__args mb-mono", "{cap.args}" }
                            span { class: "cap__res mb-mono",
                                match &cap.result {
                                    Some(r) => format!("→ {r}"),
                                    None => "…".to_string(),
                                }
                            }
                        }
                    }
                }
            }
            if phase() == Phase::Proposing {
                {
                    let set = proposal();
                    rsx! {
                        div { style: "margin: 0 var(--space-4);",
                            div { class: "ghosthead",
                                Ico { svg: icons::SPARKS }
                                span { class: "ghosthead__t",
                                    "Oracle proposes · {set.adds.len()} adds · {set.cuts.len()} cuts"
                                }
                            }
                            for card in set.adds.iter() {
                                div { class: "prow prow--add",
                                    div { style: "padding: var(--space-2) var(--space-2_5) 0; font: var(--type-body-sm); color: var(--text-primary);",
                                        "{card.name}"
                                    }
                                    div { class: "prow__reason",
                                        b { "{card.role}" }
                                        " · {card.reason}"
                                    }
                                }
                            }
                            for card in set.cuts.iter() {
                                div { class: "prow prow--cut",
                                    div { style: "padding: var(--space-2) var(--space-2_5) 0; font: var(--type-body-sm); color: var(--text-primary); opacity: 0.6; text-decoration: line-through;",
                                        "{card.name}"
                                    }
                                    div { class: "prow__reason",
                                        b { "{card.role}" }
                                        " · {card.reason}"
                                    }
                                }
                            }
                            div { class: "actionbar",
                                span { class: "actionbar__sum", "{set.summary}" }
                                Button {
                                    variant: "ghost".to_string(),
                                    size: "sm".to_string(),
                                    onclick: { let mut reject = reject; move |_| reject() },
                                    "Reject (Esc)"
                                }
                                Button {
                                    variant: "primary".to_string(),
                                    size: "sm".to_string(),
                                    onclick: { let mut accept = accept.clone(); move |_| accept() },
                                    "Accept (Enter)"
                                }
                            }
                        }
                    }
                }
            }
            if !flash().is_empty() {
                div { class: "flash", style: "margin: 0 var(--space-4); padding: var(--space-2); font: var(--type-label-sm); color: var(--accent-text);",
                    "Applied: {flash().join(\", \")}"
                }
            }
        }
    }
}

/// Push a live caption, run the future, then complete the caption with its
/// result string — the stream is real, one entry per engine call.
async fn step<T, F>(
    caps: &mut Signal<Vec<Cap>>,
    tool: &'static str,
    args: String,
    fut: F,
) -> Option<T>
where
    F: std::future::Future<Output = Result<T, mtg_edh_mcp_client::EngineError>>,
{
    caps.write().push(Cap {
        tool,
        args,
        result: None,
    });
    let out = fut.await;
    let idx = caps.read().len() - 1;
    match out {
        Ok(v) => Some(v),
        Err(e) => {
            caps.write()[idx].result = Some(format!("error: {e}"));
            None
        }
    }
}

fn finish(caps: &mut Signal<Vec<Cap>>, result: String) {
    if let Some(last) = caps.write().last_mut() {
        if last.result.is_none() {
            last.result = Some(result);
        }
    }
}

/// The structured-intent v1 brain: each intent is a typed plan of REAL engine
/// calls whose outputs become the change-set.
async fn run_intent(
    client: &Arc<EngineClient>,
    deck_id: &str,
    intent: &'static str,
    query: &str,
    mut caps: Signal<Vec<Cap>>,
) -> ChangeSet {
    let mut set = ChangeSet::default();
    match intent {
        "staples" => {
            let staples = step(
                &mut caps,
                "meta_missing_staples",
                format!("deck:{deck_id} limit:4"),
                client.meta_missing_staples(deck_id, Some(4)),
            )
            .await;
            match staples {
                Some(s) => {
                    finish(&mut caps, format!("{} candidates", s.missing.len()));
                    set.adds = s
                        .missing
                        .into_iter()
                        .map(|m| ProposedCard {
                            oracle_id: m.oracle_id,
                            name: m.name,
                            role: m.category,
                            reason: format!(
                                "{:.0} EDHREC decks · syn {:+.0}%",
                                m.inclusion,
                                m.synergy * 100.0
                            ),
                        })
                        .collect();
                    set.summary = format!(
                        "+{} high-inclusion staples the deck lacks (EDHREC).",
                        set.adds.len()
                    );
                }
                None => return set,
            }
        }
        "fixlegal" => {
            let validation = step(
                &mut caps,
                "validate_deck",
                format!("deck:{deck_id}"),
                client.validate_deck(deck_id),
            )
            .await;
            let Some(v) = validation else { return set };
            finish(&mut caps, format!("{} violations", v.violations.len()));
            let deck = step(
                &mut caps,
                "deck_get",
                format!("deck:{deck_id}"),
                client.deck_get(deck_id),
            )
            .await;
            let Some(d) = deck else { return set };
            let cuts: Vec<ProposedCard> = d
                .deck
                .cards
                .iter()
                .filter(|e| e.illegal)
                .map(|e| ProposedCard {
                    oracle_id: e.oracle_id.clone(),
                    name: e.name.clone().unwrap_or_else(|| e.oracle_id.clone()),
                    role: "illegal".to_string(),
                    reason: "flagged illegal by the engine's pre-check".to_string(),
                })
                .collect();
            finish(&mut caps, format!("{} illegal entries", cuts.len()));
            set.summary = if cuts.is_empty() {
                format!("{} violations, but no force-added illegal cards to cut — see the Validation panel.", v.violations.len())
            } else {
                format!(
                    "Cut {} illegal card(s); re-validate after applying.",
                    cuts.len()
                )
            };
            set.cuts = cuts;
        }
        "trim" => {
            let plan = step(
                &mut caps,
                "budget_plan",
                format!("deck:{deck_id}"),
                client.budget_plan(deck_id, true),
            )
            .await;
            let Some(p) = plan else { return set };
            finish(&mut caps, format!("min-buy ${:.0}", p.min_buy_usd));
            set.cuts = p
                .cost_drivers
                .into_iter()
                .take(3)
                .map(|d| ProposedCard {
                    oracle_id: d.oracle_id,
                    name: d.name,
                    role: d
                        .roles
                        .first()
                        .cloned()
                        .unwrap_or_else(|| "cost driver".to_string()),
                    reason: format!("${:.0} of the deck's price (×{})", d.contribution, d.qty),
                })
                .collect();
            set.summary = format!(
                "Cut the top {} cost drivers to lower the buy-in.",
                set.cuts.len()
            );
        }
        _ => {
            // Free text = a real grammar search; top hits become proposed adds.
            let hits = step(
                &mut caps,
                "card_search",
                format!("q:{query} limit:4"),
                client.card_search(CardSearchParams {
                    query: query.to_string(),
                    limit: Some(4),
                    ..Default::default()
                }),
            )
            .await;
            let Some(h) = hits else { return set };
            finish(&mut caps, format!("{} of {} cards", h.returned, h.total));
            set.adds = h
                .results
                .into_iter()
                .map(|c| ProposedCard {
                    oracle_id: c.oracle_id,
                    name: c.name,
                    role: c.type_line.split(' ').next().unwrap_or("card").to_string(),
                    reason: format!("top match for \"{query}\""),
                })
                .collect();
            set.summary = format!(
                "+{} top matches; adds run the engine's legality pre-check.",
                set.adds.len()
            );
        }
    }
    set
}

/// The what-if projection (gui-oracle-whatif): REAL engine analysis of the
/// proposed deck via snapshot → apply → analyze → restore, streamed as
/// captions like every other Oracle step. The restore ALWAYS runs; analysis
/// failures just yield no overlay (honest absence, never a local heuristic).
async fn project_whatif(
    client: &Arc<EngineClient>,
    deck_id: &str,
    set: &ChangeSet,
    mut caps: Signal<Vec<Cap>>,
) -> Option<WhatIf> {
    let snap = step(
        &mut caps,
        "deck_snapshot",
        format!("deck:{deck_id}"),
        client.deck_snapshot(deck_id),
    )
    .await?;
    finish(&mut caps, format!("{} (what-if)", snap.snapshot_id));

    // Apply the change-set transiently.
    if !set.cuts.is_empty() {
        let cuts: Vec<(String, u32)> = set.cuts.iter().map(|c| (c.oracle_id.clone(), 1)).collect();
        let _ = client.deck_remove(deck_id, &cuts).await;
    }
    if !set.adds.is_empty() {
        let adds: Vec<(String, u32)> = set.adds.iter().map(|c| (c.oracle_id.clone(), 1)).collect();
        let _ = client.deck_add(deck_id, &adds).await;
    }

    // Analyze the projected deck (fast sim: 300 trials, fixed seed).
    let curve = step(
        &mut caps,
        "analyze_curve",
        "projected".to_string(),
        client.analyze_curve(deck_id),
    )
    .await;
    if let Some(c) = &curve {
        finish(&mut caps, format!("{} cards", c.total));
    }
    let stats = client.analyze_stats(deck_id).await.ok();
    let sim = step(
        &mut caps,
        "simulate_deck",
        "projected seed:42 trials:300".to_string(),
        client.simulate_deck(deck_id, Some(42), Some(300)),
    )
    .await;
    if let Some(s) = &sim {
        finish(
            &mut caps,
            format!("keepable {:.1}%", s.keepable_rate * 100.0),
        );
    }

    // ALWAYS restore — the projection must be invisible to the real deck.
    let restored = step(
        &mut caps,
        "deck_restore",
        format!("from:{}", snap.snapshot_id),
        client.deck_restore(deck_id, &snap.snapshot_id),
    )
    .await;
    finish(
        &mut caps,
        if restored.is_some() {
            "deck unchanged".to_string()
        } else {
            "RESTORE FAILED — check the deck".to_string()
        },
    );

    let (curve, stats, sim) = (curve?, stats?, sim?);
    let mut buckets: Vec<(String, u32)> = curve.buckets.into_iter().collect();
    buckets.sort_by(|a, b| {
        let key = |s: &str| s.trim_end_matches('+').parse::<u32>().unwrap_or(99);
        key(&a.0).cmp(&key(&b.0))
    });
    Some(WhatIf {
        curve: buckets,
        keepable_rate: sim.keepable_rate,
        avg_mv_nonland: stats.avg_mv_nonland,
        total_cards: stats.total_cards,
    })
}
