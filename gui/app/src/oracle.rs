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
use mtg_edh_mcp_client::{serde_json, CardSearchParams, EngineClient};
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
    tool: String,
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
                #[cfg(not(target_arch = "wasm32"))]
                let set = if intent == "search" && claude_available() {
                    run_claude_brain(&deck_id, &query, caps).await
                } else if intent == "search" && api_key().is_some() {
                    run_api_brain(&client, &deck_id, &query, oracle_model(), caps).await
                } else {
                    run_intent(&client, &deck_id, intent, &query, caps).await
                };
                #[cfg(target_arch = "wasm32")]
                let set = run_intent(&client, &deck_id, intent, &query, caps).await;
                if set.adds.is_empty() && set.cuts.is_empty() {
                    caps.write().push(Cap {
                        tool: "oracle".to_string(),
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
                        if let Err(e) = client.deck_remove(&deck_id, &cuts).await {
                            crate::state::toast(state, "danger", format!("Cuts failed: {e}"));
                        }
                    }
                    let mut applied: Vec<String> = Vec::new();
                    if !set.adds.is_empty() {
                        let cards: Vec<(String, u32)> =
                            set.adds.iter().map(|c| (c.oracle_id.clone(), 1)).collect();
                        // Verdicts are the engine's pre-check gate; report them
                        // honestly instead of assuming every add landed.
                        match client.deck_add(&deck_id, &cards).await {
                            Ok(r) => {
                                let mut rejected: Vec<String> = Vec::new();
                                for v in &r.verdicts {
                                    let name = set
                                        .adds
                                        .iter()
                                        .find(|c| c.oracle_id == v.oracle_id)
                                        .map(|c| c.name.clone())
                                        .unwrap_or_else(|| v.oracle_id.clone());
                                    if v.status == "rejected" {
                                        rejected.push(name);
                                    } else {
                                        applied.push(name);
                                    }
                                }
                                if !rejected.is_empty() {
                                    crate::state::toast(
                                        state,
                                        "danger",
                                        format!("Rejected: {}", rejected.join(", ")),
                                    );
                                }
                            }
                            Err(e) => {
                                crate::state::toast(state, "danger", format!("Adds failed: {e}"))
                            }
                        }
                    }
                    flash.set(applied);
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
                    placeholder: oracle_placeholder(),
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
        tool: tool.to_string(),
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

    // Apply the change-set transiently. A failed apply must NOT early-return:
    // the restore at the end of this fn is what makes the projection invisible
    // to the real deck, so a failure only skips the analysis.
    let mut apply_ok = true;
    if !set.cuts.is_empty() {
        let cuts: Vec<(String, u32)> = set.cuts.iter().map(|c| (c.oracle_id.clone(), 1)).collect();
        apply_ok &= client.deck_remove(deck_id, &cuts).await.is_ok();
    }
    if apply_ok && !set.adds.is_empty() {
        let adds: Vec<(String, u32)> = set.adds.iter().map(|c| (c.oracle_id.clone(), 1)).collect();
        apply_ok &= client.deck_add(deck_id, &adds).await.is_ok();
    }

    // Analyze the projected deck (fast sim: 300 trials, fixed seed). Skipped
    // when the apply failed — projecting an unchanged deck would lie.
    let (curve, stats, sim) = if apply_ok {
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
        (curve, stats, sim)
    } else {
        (None, None, None)
    };

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

/// The active brain tier, labeled honestly in the ask bar.
fn oracle_placeholder() -> &'static str {
    #[cfg(not(target_arch = "wasm32"))]
    {
        if claude_available() {
            return "Ask the Oracle to refine your deck… (Claude Code)";
        }
        if api_key().is_some() {
            return "Ask the Oracle to refine your deck… (Anthropic API)";
        }
    }
    "Ask the Oracle to refine your deck… (scripted intents)"
}

/// Tier 2 model: haiku by default (cost-appropriate); env-overridable.
#[cfg(not(target_arch = "wasm32"))]
fn oracle_model() -> &'static str {
    use std::sync::OnceLock;
    static MODEL: OnceLock<String> = OnceLock::new();
    MODEL
        .get_or_init(|| {
            std::env::var("MTG_EDH_ORACLE_MODEL").unwrap_or_else(|_| "claude-haiku-4-5".to_string())
        })
        .as_str()
}

// ---- Tier 1 brain: the user's own Claude Code CLI (oracle-llm-brain) --------
// Headless `claude -p --output-format stream-json` with --strict-mcp-config
// pointing at THIS app's engine and --allowedTools limited to its MCP tools,
// so Claude plans real tool sequences against the live deck. Every observed
// contract below comes from the recorded probe (think:155/156), not docs.
// Native-only: a browser build cannot spawn processes.

#[cfg(not(target_arch = "wasm32"))]
fn claude_available() -> bool {
    use std::sync::OnceLock;
    static AVAILABLE: OnceLock<bool> = OnceLock::new();
    *AVAILABLE.get_or_init(|| {
        std::process::Command::new("claude")
            .arg("--version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    })
}

#[cfg(not(target_arch = "wasm32"))]
fn engine_mcp_config() -> std::io::Result<std::path::PathBuf> {
    let url =
        std::env::var("MTG_EDH_MCP_URL").unwrap_or_else(|_| "http://127.0.0.1:3000".to_string());
    let path = std::env::temp_dir().join("mtg-edh-oracle-mcp.json");
    std::fs::write(
        &path,
        serde_json::json!({ "mcpServers": { "mtg": { "type": "http", "url": url } } }).to_string(),
    )?;
    Ok(path)
}

/// Extract the fenced-JSON change-set from Claude's final text.
#[cfg(not(target_arch = "wasm32"))]
fn parse_change_set(text: &str) -> Option<ChangeSet> {
    let start = text.find("```json").map(|i| i + 7).or_else(|| {
        // Unfenced fallback: first '{'.
        text.find('{')
    })?;
    let rest = &text[start..];
    let end = rest.find("```").unwrap_or(rest.len());
    let value: serde_json::Value = serde_json::from_str(rest[..end].trim()).ok()?;
    let card = |e: &serde_json::Value| -> Option<ProposedCard> {
        Some(ProposedCard {
            oracle_id: e.get("oracle_id")?.as_str()?.to_string(),
            name: e.get("name")?.as_str()?.to_string(),
            role: e
                .get("role")
                .and_then(|v| v.as_str())
                .unwrap_or("suggestion")
                .to_string(),
            reason: e
                .get("reason")
                .and_then(|v| v.as_str())
                .unwrap_or("proposed by Claude")
                .to_string(),
        })
    };
    let list = |key: &str| -> Vec<ProposedCard> {
        value
            .get(key)
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(card).collect())
            .unwrap_or_default()
    };
    Some(ChangeSet {
        adds: list("adds"),
        cuts: list("cuts"),
        summary: value
            .get("summary")
            .and_then(|v| v.as_str())
            .unwrap_or("Claude's proposal")
            .to_string(),
    })
}

/// One stream-json line → an optional caption/final-text event.
#[cfg(not(target_arch = "wasm32"))]
enum StreamEvent {
    ToolUse { tool: String, args: String },
    ToolDone,
    Final(String),
}

#[cfg(not(target_arch = "wasm32"))]
fn parse_stream_line(line: &str) -> Option<StreamEvent> {
    let event: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    match event.get("type").and_then(|v| v.as_str())? {
        "assistant" => {
            let content = event.get("message")?.get("content")?.as_array()?;
            for c in content {
                if c.get("type").and_then(|v| v.as_str()) == Some("tool_use") {
                    let tool = c
                        .get("name")?
                        .as_str()?
                        .trim_start_matches("mcp__mtg__")
                        .to_string();
                    let args = c
                        .get("input")
                        .map(|i| i.to_string())
                        .unwrap_or_default()
                        .chars()
                        .take(60)
                        .collect();
                    return Some(StreamEvent::ToolUse { tool, args });
                }
            }
            None
        }
        "user" => {
            let content = event.get("message")?.get("content")?.as_array()?;
            content
                .iter()
                .any(|c| c.get("type").and_then(|v| v.as_str()) == Some("tool_result"))
                .then_some(StreamEvent::ToolDone)
        }
        "result" => Some(StreamEvent::Final(
            event
                .get("result")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
        )),
        _ => None,
    }
}

#[cfg(not(target_arch = "wasm32"))]
async fn run_claude_brain(deck_id: &str, query: &str, mut caps: Signal<Vec<Cap>>) -> ChangeSet {
    use tokio::io::AsyncBufReadExt;

    let empty = ChangeSet::default();
    let Ok(mcp_config) = engine_mcp_config() else {
        return empty;
    };
    let contract = r#"```json
{"adds":[{"oracle_id":"...","name":"...","role":"...","reason":"..."}],"cuts":[{"oracle_id":"...","name":"...","role":"...","reason":"..."}],"summary":"one sentence"}
```"#;
    let prompt = format!(
        "You are the Oracle, a Commander (EDH) deckbuilding assistant inside a desktop app. \
         The user's active deck has deck_id \"{deck_id}\". Their request: \"{query}\".\n\
         Investigate with the mtg MCP tools (deck_get, card_search, analyze_*, meta_*, \
         validate_deck — read-only; do NOT call deck_add/deck_remove/deck_restore yourself: \
         the app applies changes after the user accepts). Then reply with ONLY one fenced \
         json block of exactly this shape, no prose:\n{contract}\n\
         oracle_id values MUST come from tool results. At most 5 adds and 3 cuts."
    );

    caps.write().push(Cap {
        tool: "claude".to_string(),
        args: "headless · your Claude Code auth".to_string(),
        result: None,
    });

    let child = tokio::process::Command::new("claude")
        .args(["-p", &prompt])
        .args(["--output-format", "stream-json"])
        .arg("--verbose")
        .args(["--mcp-config".as_ref(), mcp_config.as_os_str()])
        .arg("--strict-mcp-config")
        .args(["--allowedTools", "mcp__mtg__*"])
        .args([
            "--disallowedTools",
            "Bash,Agent,WebSearch,WebFetch,Read,Write,Edit,Glob,Grep,TodoWrite,NotebookEdit",
        ])
        .args(["--max-turns", "16"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn();
    let Ok(mut child) = child else {
        finish(&mut caps, "failed to launch claude".to_string());
        return empty;
    };
    let Some(stdout) = child.stdout.take() else {
        finish(&mut caps, "no stdout".to_string());
        return empty;
    };
    finish(&mut caps, "session started".to_string());

    let mut lines = tokio::io::BufReader::new(stdout).lines();
    let mut final_text = String::new();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(240);
    loop {
        let next = tokio::time::timeout_at(deadline, lines.next_line()).await;
        match next {
            Ok(Ok(Some(line))) => match parse_stream_line(&line) {
                Some(StreamEvent::ToolUse { tool, args }) => {
                    caps.write().push(Cap {
                        tool,
                        args,
                        result: None,
                    });
                }
                Some(StreamEvent::ToolDone) => finish(&mut caps, "done".to_string()),
                Some(StreamEvent::Final(text)) => final_text = text,
                None => {}
            },
            Ok(Ok(None)) => break,
            Ok(Err(_)) | Err(_) => {
                let _ = child.kill().await;
                finish(&mut caps, "timed out".to_string());
                break;
            }
        }
    }
    let _ = child.wait().await;

    match parse_change_set(&final_text) {
        Some(set) if !set.adds.is_empty() || !set.cuts.is_empty() => set,
        _ => {
            caps.write().push(Cap {
                tool: "oracle".to_string(),
                args: String::new(),
                result: Some(if final_text.is_empty() {
                    "no reply from claude".to_string()
                } else {
                    "no change-set in the reply".to_string()
                }),
            });
            empty
        }
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod brain_tests {
    use super::*;

    #[test]
    fn stream_line_tool_use() {
        let line = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"mcp__mtg__card_search","input":{"query":"t:goblin","limit":3}}]}}"#;
        match parse_stream_line(line) {
            Some(StreamEvent::ToolUse { tool, .. }) => assert_eq!(tool, "card_search"),
            _ => panic!("expected ToolUse"),
        }
    }

    #[test]
    fn stream_line_result() {
        let line = r#"{"type":"result","subtype":"success","result":"```json\n{\"adds\":[],\"cuts\":[],\"summary\":\"s\"}\n```"}"#;
        match parse_stream_line(line) {
            Some(StreamEvent::Final(text)) => assert!(text.contains("summary")),
            _ => panic!("expected Final"),
        }
    }

    #[test]
    fn change_set_from_fenced_json() {
        let text = r#"```json
{"adds":[{"oracle_id":"abc","name":"Sol Ring","role":"ramp","reason":"fast mana"}],"cuts":[],"summary":"add ramp"}
```"#;
        let set = parse_change_set(text).expect("parse");
        assert_eq!(set.adds.len(), 1);
        assert_eq!(set.adds[0].name, "Sol Ring");
        assert_eq!(set.summary, "add ramp");
    }

    #[test]
    fn change_set_rejects_garbage() {
        assert!(parse_change_set("no json here").is_none());
    }
}

// ---- Tier 2 brain: BYO Anthropic API key (oracle-byo-key) --------------------
// Key lives in the macOS keychain (service mtg-edh-oracle) via the `security`
// CLI — never plaintext on disk; ANTHROPIC_API_KEY env is the non-macOS
// fallback. A REAL tool-use loop over the messages API: a curated tool set
// executed through the existing EngineClient wrappers, each call a caption,
// the final text the same fenced-JSON change-set contract as Tier 1.

#[cfg(not(target_arch = "wasm32"))]
const KEYCHAIN_SERVICE: &str = "mtg-edh-oracle";

#[cfg(not(target_arch = "wasm32"))]
pub fn api_key() -> Option<String> {
    if let Ok(key) = std::env::var("ANTHROPIC_API_KEY") {
        if !key.trim().is_empty() {
            return Some(key);
        }
    }
    let out = std::process::Command::new("security")
        .args(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let key = String::from_utf8(out.stdout).ok()?.trim().to_string();
    (!key.is_empty()).then_some(key)
}

#[cfg(not(target_arch = "wasm32"))]
pub fn store_api_key(key: &str) -> bool {
    std::process::Command::new("security")
        .args([
            "add-generic-password",
            "-U",
            "-s",
            KEYCHAIN_SERVICE,
            "-a",
            "anthropic",
            "-w",
            key,
        ])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// The curated tool schemas the API model may call (executed via EngineClient).
#[cfg(not(target_arch = "wasm32"))]
fn api_tools() -> serde_json::Value {
    let q = |desc: &str| serde_json::json!({"type":"object","properties":{"query":{"type":"string","description":desc},"limit":{"type":"integer"}},"required":["query"]});
    let d = serde_json::json!({"type":"object","properties":{"deck_id":{"type":"string"}},"required":["deck_id"]});
    serde_json::json!([
        {"name":"card_search","description":"Scryfall-grammar card search (t:, c:, o:, name words). Returns oracle_id+name.","input_schema": q("Scryfall-style query")},
        {"name":"deck_get","description":"The deck's current cards (oracle_id, qty, name).","input_schema": d},
        {"name":"analyze_stats","description":"Deck stats: totals, avg mv, pips, prices.","input_schema": d},
        {"name":"meta_missing_staples","description":"High-inclusion EDHREC staples the deck lacks (oracle_id+name).","input_schema": d},
        {"name":"budget_plan","description":"Budget: min-buy, cost drivers, reprints.","input_schema": d},
    ])
}

/// Execute one API-requested tool via the typed wrappers; JSON result string.
#[cfg(not(target_arch = "wasm32"))]
async fn run_api_tool(
    client: &Arc<EngineClient>,
    deck_id: &str,
    name: &str,
    input: &serde_json::Value,
) -> String {
    let trunc = |v: serde_json::Value| {
        let s = v.to_string();
        s.chars().take(4000).collect::<String>()
    };
    match name {
        "card_search" => {
            let query = input
                .get("query")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let limit = input.get("limit").and_then(|v| v.as_u64()).unwrap_or(8) as u32;
            match client
                .card_search(CardSearchParams {
                    query,
                    limit: Some(limit.min(15)),
                    ..Default::default()
                })
                .await
            {
                Ok(r) => trunc(serde_json::json!({"total": r.total, "results": r.results.iter().map(|c| serde_json::json!({"oracle_id": c.oracle_id, "name": c.name, "type": c.type_line, "mv": c.mv})).collect::<Vec<_>>()})),
                Err(e) => format!("error: {e}"),
            }
        }
        "deck_get" => match client.deck_get(deck_id).await {
            Ok(r) => trunc(serde_json::json!({"name": r.deck.name, "cards": r.deck.cards.iter().map(|e| serde_json::json!({"oracle_id": e.oracle_id, "qty": e.qty, "name": e.name})).collect::<Vec<_>>()})),
            Err(e) => format!("error: {e}"),
        },
        "analyze_stats" => match client.analyze_stats(deck_id).await {
            Ok(r) => trunc(serde_json::json!({"total_cards": r.total_cards, "avg_mv_nonland": r.avg_mv_nonland, "min_buy_usd": r.min_buy_usd})),
            Err(e) => format!("error: {e}"),
        },
        "meta_missing_staples" => match client.meta_missing_staples(deck_id, Some(8)).await {
            Ok(r) => trunc(serde_json::json!(r.missing.iter().map(|m| serde_json::json!({"oracle_id": m.oracle_id, "name": m.name, "inclusion": m.inclusion})).collect::<Vec<_>>())),
            Err(e) => format!("error: {e}"),
        },
        "budget_plan" => match client.budget_plan(deck_id, true).await {
            Ok(r) => trunc(serde_json::json!({"min_buy_usd": r.min_buy_usd, "cost_drivers": r.cost_drivers.iter().take(5).map(|d| serde_json::json!({"oracle_id": d.oracle_id, "name": d.name, "usd": d.contribution})).collect::<Vec<_>>()})),
            Err(e) => format!("error: {e}"),
        },
        other => format!("error: unknown tool {other}"),
    }
}

/// The Tier 2 agent loop: messages API with tool_use until end_turn (max 8 rounds).
#[cfg(not(target_arch = "wasm32"))]
async fn run_api_brain(
    client: &Arc<EngineClient>,
    deck_id: &str,
    query: &str,
    model: &str,
    mut caps: Signal<Vec<Cap>>,
) -> ChangeSet {
    let empty = ChangeSet::default();
    let Some(key) = api_key() else { return empty };
    let http = reqwest::Client::new();
    let contract = r#"```json
{"adds":[{"oracle_id":"...","name":"...","role":"...","reason":"..."}],"cuts":[{"oracle_id":"...","name":"...","role":"...","reason":"..."}],"summary":"one sentence"}
```"#;
    let system = format!(
        "You are the Oracle, a Commander (EDH) deckbuilding assistant. The active deck_id is \
         {deck_id}. Investigate with the provided tools, then reply with ONLY one fenced json \
         block of exactly this shape, no prose:\n{contract}\noracle_id values MUST come from \
         tool results. At most 5 adds and 3 cuts."
    );
    let mut messages = vec![serde_json::json!({"role": "user", "content": query})];
    caps.write().push(Cap {
        tool: "anthropic".to_string(),
        args: format!("model {model} · your API key"),
        result: Some("session started".to_string()),
    });

    for _ in 0..8 {
        let body = serde_json::json!({
            "model": model,
            "max_tokens": 1500,
            "system": system,
            "tools": api_tools(),
            "messages": messages,
        });
        let resp = http
            .post("https://api.anthropic.com/v1/messages")
            .header("x-api-key", &key)
            .header("anthropic-version", "2023-06-01")
            .json(&body)
            .send()
            .await;
        let Ok(resp) = resp else {
            finish(&mut caps, "network error".to_string());
            return empty;
        };
        let Ok(reply) = resp.json::<serde_json::Value>().await else {
            finish(&mut caps, "bad reply".to_string());
            return empty;
        };
        if let Some(err) = reply.get("error") {
            caps.write().push(Cap {
                tool: "anthropic".to_string(),
                args: String::new(),
                result: Some(format!(
                    "API error: {}",
                    err.get("message").and_then(|m| m.as_str()).unwrap_or("?")
                )),
            });
            return empty;
        }
        let content = reply
            .get("content")
            .and_then(|c| c.as_array())
            .cloned()
            .unwrap_or_default();
        let stop = reply
            .get("stop_reason")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if stop == "tool_use" {
            let mut results = Vec::new();
            for block in &content {
                if block.get("type").and_then(|v| v.as_str()) == Some("tool_use") {
                    let name = block.get("name").and_then(|v| v.as_str()).unwrap_or("?");
                    let input = block.get("input").cloned().unwrap_or_default();
                    let id = block.get("id").and_then(|v| v.as_str()).unwrap_or("");
                    caps.write().push(Cap {
                        tool: name.to_string(),
                        args: input.to_string().chars().take(60).collect(),
                        result: None,
                    });
                    let out = run_api_tool(client, deck_id, name, &input).await;
                    finish(&mut caps, "done".to_string());
                    results.push(serde_json::json!({"type": "tool_result", "tool_use_id": id, "content": out}));
                }
            }
            messages.push(serde_json::json!({"role": "assistant", "content": content}));
            messages.push(serde_json::json!({"role": "user", "content": results}));
            continue;
        }
        // end_turn: extract text and parse the change-set.
        let text: String = content
            .iter()
            .filter_map(|b| b.get("text").and_then(|v| v.as_str()))
            .collect::<Vec<_>>()
            .join("\n");
        if let Some(set) = parse_change_set(&text) {
            return set;
        }
        caps.write().push(Cap {
            tool: "oracle".to_string(),
            args: String::new(),
            result: Some("no change-set in the reply".to_string()),
        });
        return empty;
    }
    finish(&mut caps, "round limit reached".to_string());
    empty
}
