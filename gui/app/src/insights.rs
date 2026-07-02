//! The Insights rail — live analysis cards inside the Workbench, per
//! reference/InsightsCards.jsx (chrome in assets/insights.css). Every number
//! comes from the engine's analyze_* / simulate_deck / validate_deck tools.
//! Ghost/what-if overlays are gui-oracle scope.

use crate::browse::ready_client;
use crate::ds::*;
use crate::icons;
use crate::state::use_app_state;
use dioxus::prelude::*;
use mtg_edh_mcp_client::{
    AnalyzeCompositionResult, AnalyzeCurveResult, AnalyzeStatsResult, ManaBaseReport,
    RoleCoverageResult, SimResult, ValidateDeckResult,
};

/// Everything the rail renders, fetched in one pass.
#[derive(Clone, PartialEq)]
struct Analysis {
    curve: AnalyzeCurveResult,
    composition: AnalyzeCompositionResult,
    stats: AnalyzeStatsResult,
    mana: ManaBaseReport,
    coverage: RoleCoverageResult,
    sim: SimResult,
    validation: Option<ValidateDeckResult>,
}

/// The reference's healthParts(): coverage ×0.45, keepable ×0.35, curve ×0.20;
/// curve shape = max(0, 1 − |avg_mv_nonland − 3| / 3).
fn health(a: &Analysis) -> (u32, &'static str, [(&'static str, f64, f64); 3]) {
    let in_band = if a.coverage.gaps.is_empty() {
        0.0
    } else {
        a.coverage.gaps.iter().filter(|g| g.status == "ok").count() as f64
            / a.coverage.gaps.len() as f64
    };
    let keepable = a.sim.keepable_rate;
    let curve = (1.0 - (a.stats.avg_mv_nonland - 3.0).abs() / 3.0).max(0.0);
    let parts = [
        ("Role coverage", in_band, 0.45),
        ("Goldfish keep", keepable, 0.35),
        ("Curve shape", curve, 0.20),
    ];
    let score = (parts.iter().map(|(_, v, w)| v * w).sum::<f64>() * 100.0).round() as u32;
    let label = match score {
        80.. => "Tournament-ready",
        65..=79 => "Solid",
        50..=64 => "Rough edges",
        _ => "Needs work",
    };
    (score, label, parts)
}

const SECTIONS: [(&str, &str, &str); 11] = [
    ("glance", "At a glance", icons::GRAPH_UP),
    ("curve", "Mana curve", icons::STATS_UP_SQUARE),
    ("pips", "Pips — demand vs supply", icons::PERCENTAGE_CIRCLE),
    ("types", "Composition", icons::BOX_ISO),
    ("sources", "Mana sources", icons::FLASK),
    ("roles", "Role coverage", icons::CHECK),
    ("goldfish", "Goldfish", icons::DICE_FIVE),
    ("validation", "Validation", icons::WARNING_TRIANGLE),
    ("bracket", "Power bracket", icons::CROWN),
    ("budget", "Budget", icons::ARCHIVE),
    ("meta", "Meta", icons::SPARKS),
];

#[component]
pub fn InsightsRail(deck_id: String, version: u64) -> Element {
    let state = use_app_state();
    let seed = use_signal(|| 1u32);
    let id_for_fetch = deck_id.clone();
    let data = use_resource(move || {
        let conn = (state.conn)();
        let deck_id = id_for_fetch.clone();
        let seed_now = seed();
        let _ = version;
        let _ = (state.deck_rev)();
        async move {
            let client = ready_client(&conn)?;
            let curve = client.analyze_curve(&deck_id).await.ok()?;
            let composition = client.analyze_composition(&deck_id).await.ok()?;
            let stats = client.analyze_stats(&deck_id).await.ok()?;
            let mana = client.analyze_mana_base(&deck_id).await.ok()?;
            let coverage = client.analyze_role_coverage(&deck_id).await.ok()?;
            let sim = client
                .simulate_deck(&deck_id, Some(seed_now), Some(1000))
                .await
                .ok()?;
            let validation = client.validate_deck(&deck_id).await.ok();
            Some(Analysis {
                curve,
                composition,
                stats,
                mana,
                coverage,
                sim,
                validation,
            })
        }
    });

    rsx! {
        div {
            style: "width: clamp(336px, 36vw, 620px); flex: none; border-left: 1px solid var(--border-subtle); background: var(--surface-base); display: flex; min-height: 0;",
            "data-rail": "insights",
            // Icon subnav — click-to-jump (true scroll-spy deferred to gui-scrutiny findings).
            nav { style: "width: 44px; flex: none; display: flex; flex-direction: column; align-items: center; gap: var(--space-2); padding: var(--space-3) 0; border-right: 1px solid var(--border-faint);",
                for (section_id, label, icon) in SECTIONS {
                    IconButton {
                        label: label.to_string(),
                        size: "sm".to_string(),
                        onclick: move |_| {
                            document::eval(&format!(
                                "document.getElementById('ins-{section_id}')?.scrollIntoView({{behavior:'smooth',block:'start'}})"
                            ));
                        },
                        Ico { svg: icon }
                    }
                }
            }
            div { style: "flex: 1; overflow-y: auto; padding: var(--space-4); min-width: 0;",
                match &*data.read() {
                    Some(Some(a)) => rsx! {
                        RailCards { analysis: a.clone(), seed }
                        crate::meta::MetaCards { deck_id: deck_id.clone(), version }
                    },
                    Some(None) => rsx! {
                        div { style: "color: var(--text-muted); font: var(--type-body-sm);",
                            "Engine offline — insights unavailable."
                        }
                    },
                    None => rsx! {
                        div { style: "color: var(--text-muted); font: var(--type-body-sm);", "Analyzing…" }
                    },
                }
            }
        }
    }
}

#[component]
fn Card(id: &'static str, title: &'static str, icon: &'static str, children: Element) -> Element {
    rsx! {
        section {
            id: "ins-{id}",
            class: "gal__section",
            "data-insight": "{id}",
            style: "margin-bottom: var(--space-4);",
            div { class: "ic-eyebrow",
                Ico { svg: icon }
                "{title}"
            }
            {children}
        }
    }
}

#[component]
fn StatLine(stats: Vec<(String, String, bool)>) -> Element {
    rsx! {
        div { class: "ic-statline", style: "margin-top: var(--space-3);",
            for (k, v, accent) in stats {
                div { class: "ic-stat",
                    span { class: "ic-stat__k", "{k}" }
                    span { class: if accent { "ic-stat__v accent" } else { "ic-stat__v" }, "{v}" }
                }
            }
        }
    }
}

#[component]
fn RailCards(analysis: Analysis, seed: Signal<u32>) -> Element {
    let a = analysis;
    let (score, label, parts) = health(&a);
    // HealthRing: r=50 circle, circumference 2πr ≈ 314.16.
    let dash = 314.16;
    let offset = dash * (1.0 - f64::from(score) / 100.0);

    // Curve buckets in canonical order.
    let bucket_order = ["0", "1", "2", "3", "4", "5", "6", "7+"];
    let buckets: Vec<(String, u32)> = bucket_order
        .iter()
        .map(|k| (k.to_string(), a.curve.buckets.get(*k).copied().unwrap_or(0)))
        .collect();
    let wubrg = ["W", "U", "B", "R", "G"];
    let pips: Vec<(String, u32)> = wubrg
        .iter()
        .map(|c| {
            (
                c.to_string(),
                a.stats.color_pips.get(*c).copied().unwrap_or(0),
            )
        })
        .collect();
    let sources: Vec<(String, u32)> = wubrg
        .iter()
        .map(|c| (c.to_string(), a.mana.sources.get(*c).copied().unwrap_or(0)))
        .collect();
    let max_dd = pips
        .iter()
        .map(|(_, n)| *n)
        .chain(sources.iter().map(|(_, n)| *n))
        .max()
        .unwrap_or(1)
        .max(1);
    let gaps: Vec<CoverageGap> = a
        .coverage
        .gaps
        .iter()
        .map(|g| CoverageGap {
            role: Box::leak(g.role.clone().into_boxed_str()),
            have: g.have,
            want_min: g.want_min,
            want_max: g.want_max,
            status: match g.status.as_str() {
                "under" => "under",
                "over" => "over",
                _ => "ok",
            },
        })
        .collect();
    let mut lands: Vec<(u32, f64)> = a
        .sim
        .lands_by_turn
        .iter()
        .filter_map(|(k, v)| k.parse::<u32>().ok().map(|t| (t, *v)))
        .collect();
    lands.sort_by_key(|(t, _)| *t);
    let mut comp: Vec<(String, u32)> = a.composition.by_type.clone().into_iter().collect();
    comp.sort_by_key(|(_, n)| std::cmp::Reverse(*n));
    let comp_max = comp.iter().map(|(_, n)| *n).max().unwrap_or(1).max(1);

    rsx! {
        Card { id: "glance", title: "At a glance", icon: icons::GRAPH_UP,
            div { style: "display: flex; align-items: center; gap: var(--space-4);",
                svg { width: "112", height: "112", view_box: "0 0 112 112",
                    circle { cx: "56", cy: "56", r: "50", fill: "none", stroke: "var(--viz-track)", stroke_width: "8" }
                    circle {
                        cx: "56", cy: "56", r: "50", fill: "none",
                        stroke: "var(--accent)", stroke_width: "8", stroke_linecap: "round",
                        stroke_dasharray: "{dash}", stroke_dashoffset: "{offset}",
                        transform: "rotate(-90 56 56)",
                    }
                    text {
                        x: "56", y: "60", text_anchor: "middle",
                        style: "font: var(--type-data-xl); fill: var(--text-primary);",
                        "{score}"
                    }
                }
                div { style: "flex: 1; min-width: 0;",
                    div { style: "font: var(--type-h3); color: var(--text-primary); margin-bottom: var(--space-2);", "{label}" }
                    for (name, value, weight) in parts {
                        div { class: "ic-driver",
                            span { class: "ic-driver__k", "{name}" }
                            span { class: "ic-driver__track",
                                span { class: "ic-driver__fill", style: "width: {value * 100.0}%;" }
                            }
                            span { class: "ic-driver__w", "×{weight:.2}" }
                        }
                    }
                }
            }
            StatLine { stats: vec![
                ("Cards".into(), format!("{}", a.stats.total_cards), false),
                ("Lands".into(), format!("{}", a.mana.total_lands), false),
                ("Avg MV".into(), format!("{:.2}", a.stats.avg_mv_nonland), true),
                ("Keepable".into(), format!("{:.1}%", a.sim.keepable_rate * 100.0), false),
                ("Min buy".into(), format!("${:.0}", a.stats.min_buy_usd), false),
            ] }
        }
        Card { id: "curve", title: "Mana curve", icon: icons::STATS_UP_SQUARE,
            CurveChart { buckets: buckets.clone() }
            StatLine { stats: vec![
                ("Avg MV".into(), format!("{:.2}", a.stats.avg_mv), false),
                ("Nonland".into(), format!("{}", a.stats.nonland_cards), false),
                ("Total".into(), format!("{}", a.curve.total), false),
            ] }
        }
        Card { id: "pips", title: "Pips — demand vs supply", icon: icons::PERCENTAGE_CIRCLE,
            div { class: "ic-dd",
                for (color, demand) in pips.clone() {
                    {
                        let supply = sources.iter().find(|(c, _)| *c == color).map(|(_, n)| *n).unwrap_or(0);
                        let under = a.mana.under_supported.contains(&color);
                        rsx! {
                            div { class: "ic-dd__row",
                                span { ManaPip { symbol: color.clone(), size: 14 } }
                                span { class: "ic-dd__bars",
                                    span { class: "ic-dd__bar",
                                        span { class: "ic-dd__fill ic-dd__fill--demand", style: "width: {demand * 100 / max_dd}%;" }
                                    }
                                    span { class: "ic-dd__bar",
                                        span { class: "mb-pips__fill mb-pips__fill--{color}", style: "display:block; height:100%; width: {supply * 100 / max_dd}%;" }
                                    }
                                }
                                span { class: "ic-dd__meta",
                                    b { "{demand}" }
                                    " / {supply} "
                                    if under {
                                        span { class: "warn", "tight" }
                                    } else {
                                        span { class: "ok", "ok" }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            div { class: "ic-legend",
                span { i { style: "background: color-mix(in oklab, var(--text-primary) 42%, transparent);" } "Demand (pips)" }
                span { i { style: "background: var(--accent);" } "Supply (sources)" }
            }
        }
        Card { id: "types", title: "Composition", icon: icons::BOX_ISO,
            div { class: "ic-rows",
                for (type_name, count) in comp {
                    div { class: "ic-row",
                        span { class: "ic-row__k", "{count}" }
                        span { class: "ic-row__names",
                            span { class: "ic-row__bar", style: "display:block;",
                                span { class: "ic-row__fill", style: "width: {count * 100 / comp_max}%;" }
                            }
                        }
                        span { class: "ic-row__n", "{type_name}" }
                    }
                }
            }
        }
        Card { id: "sources", title: "Mana sources", icon: icons::FLASK,
            ManaSourceBars {
                sources: sources.clone(),
                threshold: 10,
                under_supported: a.mana.under_supported.clone(),
            }
            StatLine { stats: vec![
                ("Lands".into(), format!("{}", a.mana.total_lands), false),
                ("Untapped".into(), format!("{}", a.mana.untapped_lands), false),
                ("Fixing".into(), format!("{}", a.mana.fixing_sources), true),
                ("Under".into(), format!("{}", a.mana.under_supported.len()), false),
            ] }
        }
        Card { id: "roles", title: "Role coverage", icon: icons::CHECK,
            RoleCoverageBars { gaps: gaps.clone() }
            div { style: "margin-top: var(--space-3);",
                for gap in a.coverage.gaps.iter().filter(|g| g.status != "ok").cloned() {
                    div { class: "ic-role",
                        div { class: "ic-role__head",
                            RoleChip { role: gap.role.clone() }
                            span { class: "ic-status ic-status--{gap.status}", "{gap.status}" }
                            span { class: "ic-role__band",
                                b { "{gap.have}" }
                                " / {gap.want_min}–{gap.want_max}"
                            }
                        }
                        div { class: "ic-role__fix",
                            Ico { svg: icons::NAV_ARROW_RIGHT }
                            if gap.status == "under" {
                                "Add {gap.want_min.saturating_sub(gap.have)} more"
                            } else {
                                "Trim {gap.have.saturating_sub(gap.want_max)}"
                            }
                        }
                    }
                }
            }
        }
        Card { id: "goldfish", title: "Goldfish", icon: icons::DICE_FIVE,
            SimReadout {
                keepable_rate: a.sim.keepable_rate,
                mulligan_rate: a.sim.mulligan_rate,
                dead_on_arrival_rate: a.sim.dead_on_arrival_rate,
                lands_by_turn: lands,
            }
            StatLine { stats: vec![
                ("Keepable".into(), format!("{:.1}%", a.sim.keepable_rate * 100.0), true),
                ("Open lands".into(), format!("{:.1}", a.sim.avg_opening_lands), false),
                ("1st spell".into(), format!("{:.0}%", a.sim.first_spell_rate * 100.0), false),
                ("T→spell".into(), a.sim.avg_turn_to_first_spell.map_or("—".into(), |t| format!("T{t:.1}")), false),
                ("Trials".into(), format!("{}", a.sim.trials), false),
            ] }
            div { style: "display: flex; align-items: center; gap: var(--space-2); margin-top: var(--space-3);",
                span { class: "ic-stat__k", "Seed" }
                div { class: "mb-input mb-input--md mb-input--mono", style: "max-width: 110px;",
                    input {
                        r#type: "text",
                        value: "{seed()}",
                        aria_label: "Simulation seed",
                        onchange: move |e| {
                            if let Ok(v) = e.value().trim().parse::<u32>() {
                                seed.set(v);
                            }
                        },
                    }
                }
            }
        }
        Card { id: "validation", title: "Validation", icon: icons::WARNING_TRIANGLE,
            if let Some(v) = &a.validation {
                if v.violations.is_empty() {
                    Badge { tone: "success".to_string(), dot: true, "Legal — no violations" }
                }
                for viol in v.violations.iter().take(10) {
                    ValidationItem {
                        rule: viol.get("rule").and_then(|x| x.as_str()).unwrap_or("RULE").to_string(),
                        severity: viol.get("severity").and_then(|x| x.as_str()).unwrap_or("error").to_string(),
                        card: viol.get("card").and_then(|x| x.as_str()).map(String::from),
                        detail: viol.get("detail").and_then(|x| x.as_str()).map(String::from),
                        fix_hint: viol.get("fix_hint").and_then(|x| x.as_str()).map(String::from),
                    }
                }
            }
        }
    }
}
