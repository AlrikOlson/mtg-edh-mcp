//! Meta/enrichment cards for the Insights rail: Bracket (handoff-specified),
//! Budget (typed budget_plan), and the EDHREC/Spellbook surfaces
//! (recommendations, missing staples, budget swaps, combos). Each group has
//! its OWN resource so slow/down enrichment never blocks the core analysis
//! cards, and UPSTREAM_UNAVAILABLE renders as a typed advisory callout —
//! the engine's graceful-degradation ethos, surfaced.

use crate::browse::ready_client;
use crate::ds::*;
use crate::icons;
use crate::state::use_app_state;
use dioxus::prelude::*;
use mtg_edh_mcp_client::{
    BracketResult, BudgetPlanResult, BudgetSwapsResult, CombosResult, EngineError, Recommendation,
    RecommendResult,
};

/// A typed enrichment outcome: data, a graceful upstream advisory, or an error.
type Enriched<T> = Result<T, EngineError>;

fn advisory(err: &EngineError) -> Element {
    match err {
        EngineError::UpstreamUnavailable {
            message, reason, ..
        } => rsx! {
            div { class: "ic-callout", "data-degraded": "upstream",
                Ico { svg: icons::INFO_CIRCLE }
                span {
                    b { "Enrichment unavailable. " }
                    "{message}"
                    if let Some(r) = reason {
                        " ({r})"
                    }
                    " Cached data returns once EDHREC/Spellbook are reachable."
                }
            }
        },
        // Known engine codes map to human states — never raw strings with
        // internal deck UUIDs (audit find, think:186).
        EngineError::Engine { code, .. } if code == "INELIGIBLE_COMMANDER" => rsx! {
            div { class: "ic-callout", "data-degraded": "no-commander",
                Ico { svg: icons::INFO_CIRCLE }
                span {
                    b { "No commander set. " }
                    "Pick one in the command zone to unlock EDHREC recommendations, staples, budget swaps, and combos."
                }
            }
        },
        EngineError::Engine { code, .. } => rsx! {
            div { class: "ic-callout", "data-degraded": "error",
                Ico { svg: icons::WARNING_TRIANGLE }
                span { "Enrichment failed ({code})." }
            }
        },
        EngineError::DeckNotFound { .. } => rsx! {
            div { class: "ic-callout", "data-degraded": "error",
                Ico { svg: icons::WARNING_TRIANGLE }
                span { "Enrichment failed — the deck could not be resolved." }
            }
        },
        other => rsx! {
            div { class: "ic-callout", "data-degraded": "error",
                Ico { svg: icons::WARNING_TRIANGLE }
                span { "{other}" }
            }
        },
    }
}

/// Dedupe key so the same failure renders once across the four surfaces.
fn err_key(err: &EngineError) -> String {
    match err {
        EngineError::Engine { code, .. } => code.clone(),
        EngineError::UpstreamUnavailable { .. } => "UPSTREAM_UNAVAILABLE".to_string(),
        EngineError::DeckNotFound { .. } => "DECK_NOT_FOUND".to_string(),
        other => other.to_string(),
    }
}

#[component]
pub fn MetaCards(deck_id: String, version: u64) -> Element {
    let state = use_app_state();

    // Bracket + budget: local/cached-fast, one resource.
    let id_a = deck_id.clone();
    let core = use_resource(move || {
        let conn = (state.conn)();
        let deck_id = id_a.clone();
        let _ = version;
        let _ = (state.deck_rev)();
        async move {
            let client = ready_client(&conn)?;
            let bracket: Enriched<BracketResult> = client.meta_classify_bracket(&deck_id).await;
            let budget: Enriched<BudgetPlanResult> = client.budget_plan(&deck_id, true).await;
            Some((bracket, budget))
        }
    });

    // EDHREC/Spellbook surfaces: potentially slow — isolated resource.
    let id_b = deck_id.clone();
    let enrich = use_resource(move || {
        let conn = (state.conn)();
        let deck_id = id_b.clone();
        let _ = version;
        let _ = (state.deck_rev)();
        async move {
            let client = ready_client(&conn)?;
            let recs: Enriched<RecommendResult> =
                client.meta_recommend(&deck_id, "synergy", Some(5)).await;
            let staples: Enriched<RecommendResult> =
                client.meta_recommend(&deck_id, "inclusion", Some(5)).await;
            let swaps: Enriched<BudgetSwapsResult> =
                client.meta_budget_swaps(&deck_id, Some(5)).await;
            let combos: Enriched<CombosResult> = client.meta_combos(&deck_id).await;
            Some((recs, staples, swaps, combos))
        }
    });

    rsx! {
        // ---- Bracket (handoff-specified) --------------------------------
        section { id: "ins-bracket", class: "gal__section", "data-insight": "bracket",
            style: "margin-bottom: var(--space-4);",
            div { class: "ic-eyebrow",
                Ico { svg: icons::CROWN }
                "Power bracket"
            }
            match &*core.read() {
                Some(Some((Ok(b), _))) => rsx! {
                    BracketMeter { bracket: b.bracket }
                    if !b.rationale.is_empty() {
                        div { class: "ic-callout", style: "margin-top: var(--space-3);",
                            Ico { svg: icons::INFO_CIRCLE }
                            span { "{b.rationale}" }
                        }
                    }
                    div { style: "margin-top: var(--space-3);",
                        for (label, cards) in [
                            ("Game changers", b.pushers.game_changers.clone()),
                            ("Fast mana", b.pushers.fast_mana.clone()),
                            ("Tutors", b.pushers.tutors.clone()),
                            ("Mass land denial", b.pushers.mld.clone()),
                            ("Two-card combos", b.pushers.combos.clone()),
                            ("Extra turns", b.pushers.extra_turns.clone()),
                        ] {
                            div { class: "ic-push",
                                span { class: "ic-push__k", "{label}" }
                                span { class: "ic-push__v",
                                    if cards.is_empty() {
                                        em { "none" }
                                    } else {
                                        "{cards.join(\", \")}"
                                    }
                                }
                            }
                        }
                    }
                },
                Some(Some((Err(e), _))) => advisory(e),
                Some(None) => rsx! {
                    div { class: "ic-callout", "Engine offline." }
                },
                None => rsx! {
                    div { style: "color: var(--text-muted); font: var(--type-body-sm);", "Classifying…" }
                },
            }
        }

        // ---- Budget (typed budget_plan) ----------------------------------
        section { id: "ins-budget", class: "gal__section", "data-insight": "budget",
            style: "margin-bottom: var(--space-4);",
            div { class: "ic-eyebrow",
                Ico { svg: icons::ARCHIVE }
                "Budget"
            }
            match &*core.read() {
                Some(Some((_, Ok(plan)))) => rsx! {
                    div { class: "ic-statline",
                        for (k, v, accent) in [
                            ("Default".to_string(), format!("${:.0}", plan.default_total_usd), false),
                            ("Min buy".to_string(), format!("${:.0}", plan.min_buy_usd), true),
                            ("Reprint savings".to_string(), format!("${:.0}", plan.reprint_savings_usd), false),
                            ("To acquire".to_string(), plan.acquire_usd.map_or("—".to_string(), |a| format!("${a:.0}")), false),
                            ("Owned value".to_string(), plan.owned_value_usd.map_or("—".to_string(), |o| format!("${o:.0}")), false),
                        ] {
                            div { class: "ic-stat",
                                span { class: "ic-stat__k", "{k}" }
                                span { class: if accent { "ic-stat__v accent" } else { "ic-stat__v" }, "{v}" }
                            }
                        }
                    }
                    if !plan.cost_drivers.is_empty() {
                        div { class: "ic-h", style: "margin-top: var(--space-4);",
                            "Cost drivers"
                            span { class: "ic-h__c", "{plan.cost_drivers.len()}" }
                        }
                        div { class: "ic-rows",
                            for driver in plan.cost_drivers.iter().take(5).cloned() {
                                div { class: "ic-row",
                                    span { class: "ic-row__k", "${driver.contribution:.0}" }
                                    span { class: "ic-row__names", "{driver.name}" }
                                    span { class: "ic-row__n", "×{driver.qty}" }
                                }
                            }
                        }
                    }
                    if !plan.reprint_suggestions.is_empty() {
                        div { class: "ic-callout", style: "margin-top: var(--space-3);",
                            Ico { svg: icons::COPY }
                            span {
                                b { "{plan.reprint_suggestions.len()} reprint swaps" }
                                " save ${plan.reprint_savings_usd:.0} with no deck change."
                            }
                        }
                    }
                },
                Some(Some((_, Err(e)))) => advisory(e),
                Some(None) => rsx! {
                    div { class: "ic-callout", "Engine offline." }
                },
                None => rsx! {
                    div { style: "color: var(--text-muted); font: var(--type-body-sm);", "Planning…" }
                },
            }
        }

        // ---- EDHREC / Spellbook surfaces ---------------------------------
        section { id: "ins-meta", class: "gal__section", "data-insight": "meta",
            style: "margin-bottom: var(--space-4);",
            div { class: "ic-eyebrow",
                Ico { svg: icons::SPARKS }
                "Meta — EDHREC & Spellbook"
            }
            match &*enrich.read() {
                Some(Some((recs, staples, swaps, combos))) => rsx! {
                    // One advisory per unique failure — the same error must not
                    // render four times down the rail (think:186).
                    {
                        let mut seen: Vec<String> = Vec::new();
                        let advisories: Vec<Element> = [
                            recs.as_ref().err(),
                            staples.as_ref().err(),
                            swaps.as_ref().err(),
                            combos.as_ref().err(),
                        ]
                        .into_iter()
                        .flatten()
                        .filter(|e| {
                            let k = err_key(e);
                            if seen.contains(&k) {
                                false
                            } else {
                                seen.push(k);
                                true
                            }
                        })
                        .map(advisory)
                        .collect();
                        rsx! {
                            for a in advisories {
                                {a}
                            }
                        }
                    }
                    if let Ok(r) = recs {
                        RecList { title: "Recommendations", items: r.suggestions.clone(), deck_id: deck_id.clone() }
                    }
                    if let Ok(s) = staples {
                        RecList { title: "Missing staples", items: s.suggestions.clone(), deck_id: deck_id.clone() }
                    }
                    if let Ok(s) = swaps {
                        if !s.swaps.is_empty() {
                            div { class: "ic-h", style: "margin-top: var(--space-4);",
                                "Budget swaps"
                                span { class: "ic-h__c",
                                    "min-buy ${s.current_min_buy_usd:.0} → ${s.projected_min_buy_usd:.0}"
                                }
                            }
                            div { class: "ic-rows",
                                for swap in s.swaps.iter().take(5).cloned() {
                                    div { class: "ic-row",
                                        span { class: "ic-row__k", "−${swap.savings:.0}" }
                                        span { class: "ic-row__names",
                                            "{swap.out.name} → {swap.replacement.name}"
                                        }
                                        span { class: "ic-row__n", "{swap.roles_matched.join(\", \")}" }
                                    }
                                }
                            }
                        }
                    }
                    if let Ok(c) = combos {
                        div { class: "ic-h", style: "margin-top: var(--space-4);",
                            "Combos"
                            span { class: "ic-h__c", "{c.included_count} in deck · {c.almost_count} almost" }
                        }
                        if c.combos.is_empty() {
                            div { style: "font: var(--type-body-sm); color: var(--text-muted);",
                                "No known two-card combos."
                            }
                        }
                        for combo in c.combos.iter().take(5).cloned() {
                            div { class: "ic-push",
                                span { class: "ic-push__k",
                                    if combo.confidence.as_deref() == Some("almost") { "almost" } else { "in deck" }
                                }
                                span { class: "ic-push__v",
                                    "{combo.pieces.join(\" + \")} "
                                    em { "→ {combo.produces.join(\", \")}" }
                                }
                            }
                        }
                    }
                },
                Some(None) => rsx! {
                    div { class: "ic-callout", "Engine offline." }
                },
                None => rsx! {
                    div { style: "color: var(--text-muted); font: var(--type-body-sm);", "Consulting the meta…" }
                },
            }
        }
    }
}

/// A compact EDHREC list: rank-style inclusion% + name + synergy.
#[component]
fn RecList(title: &'static str, items: Vec<Recommendation>, deck_id: String) -> Element {
    let state = use_app_state();
    rsx! {
        div { class: "ic-h", style: "margin-top: var(--space-2);",
            "{title}"
            span { class: "ic-h__c", "EDHREC" }
        }
        if items.is_empty() {
            div { style: "font: var(--type-body-sm); color: var(--text-muted);", "Nothing to suggest." }
        }
        div { class: "ic-rows",
            // EDHREC `inclusion` is a DECK COUNT, not a rate (scrutiny finding,
            // think:141); `synergy` is a fraction.
            for item in items {
                div { class: "ic-row",
                    span { class: "ic-row__k", "{item.inclusion:.0} decks" }
                    span { class: "ic-row__names", "{item.name}" }
                    span { class: "ic-row__n", "syn {item.synergy * 100.0:+.0}%" }
                    IconButton {
                        label: "Add to deck".to_string(),
                        size: "sm".to_string(),
                        onclick: {
                            let id = item.oracle_id.clone();
                            let name = item.name.clone();
                            let deck_id = deck_id.clone();
                            move |_| {
                                let conn = (state.conn)();
                                let (id, name, deck_id) = (id.clone(), name.clone(), deck_id.clone());
                                let mut rev = state.deck_rev;
                                spawn(async move {
                                    if let Some(client) = ready_client(&conn) {
                                        // The engine's pre-check verdict gates it —
                                        // and the outcome is toasted, never silent.
                                        let res = client.deck_add(&deck_id, &[(id, 1)]).await;
                                        crate::state::toast_add_outcome(state, &name, &res);
                                        rev += 1;
                                    }
                                });
                            }
                        },
                        Ico { svg: icons::PLUS }
                    }
                }
            }
        }
    }
}
