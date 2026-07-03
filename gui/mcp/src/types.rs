//! Serde types mirroring the engine's tool `structuredContent` shapes.
//!
//! Only the slice needed for the initial round-trip is modeled strongly;
//! richer payloads (`Deck`, `exemptions`, individual violations) stay as
//! [`serde_json::Value`] and get tightened in the per-object GUI chunks.

use serde::Deserialize;
use serde_json::Value;

/// Lean card reference returned by search/resolve tools (`src/types/card.ts`).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct CardRef {
    pub oracle_id: String,
    pub name: String,
    /// Mana value (converted mana cost).
    pub mv: f64,
    /// Color identity, lean form (`["C"]` for colorless).
    pub ci: Vec<String>,
    /// Primary type line, e.g. `"Legendary Creature — Elf Druid"`.
    #[serde(rename = "type")]
    pub type_line: String,
}

/// `card_search` structuredContent.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct CardSearchResult {
    pub total: u64,
    pub returned: u64,
    pub next_cursor: Option<String>,
    pub results: Vec<CardRef>,
}

/// `deck_create` structuredContent. `deck` kept opaque for now.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct DeckCreateResult {
    pub deck_id: String,
    pub deck: Value,
}

/// One entry of `deck_add`'s `verdicts`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct AddVerdict {
    pub oracle_id: String,
    /// `"ok" | "added_illegal" | "rejected"`.
    pub status: String,
    #[serde(default)]
    pub violations: Vec<Value>,
}

/// `deck_add` structuredContent.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct DeckAddResult {
    pub deck_id: String,
    pub version: u64,
    pub verdicts: Vec<AddVerdict>,
}

/// `validate_deck` structuredContent. Violations kept opaque for now.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct ValidateDeckResult {
    pub deck_id: String,
    pub ok: bool,
    #[serde(default)]
    pub violations: Vec<Value>,
    #[serde(default)]
    pub errors: Vec<Value>,
    #[serde(default)]
    pub warnings: Vec<Value>,
    #[serde(default)]
    pub exemptions: Value,
}

// ---- Ergonomic input params -------------------------------------------------

/// Arguments for [`crate::EngineClient::card_search`].
#[derive(Debug, Clone, Default)]
pub struct CardSearchParams {
    pub query: String,
    /// `"name" | "mv" | "price"`.
    pub order: Option<String>,
    pub limit: Option<u32>,
    pub cursor: Option<String>,
    pub owned_only: Option<bool>,
}

impl CardSearchParams {
    /// Convenience constructor for the common case (just a query).
    pub fn new(query: impl Into<String>) -> Self {
        Self {
            query: query.into(),
            ..Self::default()
        }
    }
}

/// Arguments for [`crate::EngineClient::deck_create`].
#[derive(Debug, Clone, Default)]
pub struct DeckCreateParams {
    pub name: String,
    /// Only `"commander"` is accepted by the engine today.
    pub format: Option<String>,
    pub commanders: Vec<String>,
    /// `"single" | "partner" | "background" | "doctor_companion"`.
    pub command_zone_kind: Option<String>,
}

impl DeckCreateParams {
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            ..Self::default()
        }
    }
}

// ---- card_get / card_printings (gui-card) -----------------------------------

/// One card from `card_get` (lean `Partial<Card>` + computed pricing).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct CardDetail {
    #[serde(default)]
    pub oracle_id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub mana_cost: String,
    #[serde(default)]
    pub mv: f64,
    #[serde(default)]
    pub color_identity: Vec<String>,
    #[serde(default)]
    pub type_line: String,
    #[serde(default)]
    pub oracle_text: String,
    #[serde(default)]
    pub keywords: Vec<String>,
    /// Format → "legal" | "banned" | … (kept loose).
    #[serde(default)]
    pub legalities: Value,
    #[serde(default)]
    pub roles: Vec<String>,
    #[serde(default)]
    pub is_commander_eligible: bool,
    pub default_usd: Option<f64>,
    pub cheapest_usd: Option<f64>,
}

/// `card_get` structuredContent.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct CardGetResult {
    pub cards: Vec<CardDetail>,
    #[serde(default)]
    pub missing: Vec<String>,
}

/// One printing from `card_printings`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Printing {
    #[serde(default)]
    pub scryfall_id: String,
    #[serde(default)]
    pub set: String,
    #[serde(default)]
    pub set_name: String,
    #[serde(default)]
    pub collector_number: String,
    #[serde(default)]
    pub rarity: String,
    /// e.g. { "usd": "2.15", "usd_foil": null }.
    #[serde(default)]
    pub prices: Value,
    #[serde(default)]
    pub released_at: Option<String>,
}

/// `card_printings` structuredContent.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct CardPrintingsResult {
    pub oracle_id: String,
    pub printings: Vec<Printing>,
}

// ---- deck_get / deck_list / deck_remove / deck_set_commander (gui-deck) ------

/// One entry in a deck's card list.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct DeckCardEntry {
    pub oracle_id: String,
    pub qty: u32,
    /// Present + true only when force-added despite violations.
    #[serde(default)]
    pub illegal: bool,
    /// Present in the lean deck_get projection.
    #[serde(default)]
    pub name: Option<String>,
}

/// The serialized Deck object (src/types/deck.ts).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Deck {
    pub deck_id: String,
    pub name: String,
    #[serde(default)]
    pub commanders: Vec<String>,
    #[serde(default)]
    pub command_zone_kind: Option<String>,
    #[serde(default)]
    pub companion: Option<String>,
    #[serde(default)]
    pub cards: Vec<DeckCardEntry>,
    #[serde(default)]
    pub computed_color_identity: Vec<String>,
    #[serde(default)]
    pub version: u64,
    #[serde(default)]
    pub data_snapshot: Option<String>,
}

/// `deck_get` structuredContent.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct DeckGetResult {
    pub deck: Deck,
}

/// `deck_list` structuredContent.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct DeckListResult {
    pub decks: Vec<Deck>,
}

/// `deck_remove` structuredContent (also carries version-conflict shape).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct DeckMutateResult {
    pub deck_id: String,
    #[serde(default)]
    pub version: u64,
    #[serde(default)]
    pub conflict: bool,
}

/// `deck_set_commander` structuredContent.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct SetCommanderResult {
    #[serde(default)]
    pub ok: bool,
    pub deck_id: String,
    #[serde(default)]
    pub commanders: Vec<String>,
    #[serde(default)]
    pub computed_color_identity: Vec<String>,
    #[serde(default)]
    pub version: u64,
    #[serde(default)]
    pub violations: Vec<Value>,
}

// ---- analyze_* / simulate_deck (gui-analysis) --------------------------------

use std::collections::HashMap;

/// `analyze_curve` structuredContent.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct AnalyzeCurveResult {
    pub deck_id: String,
    /// Keys "0".."6", "7+".
    pub buckets: HashMap<String, u32>,
    pub total: u32,
}

/// `analyze_composition` structuredContent.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct AnalyzeCompositionResult {
    pub deck_id: String,
    pub by_type: HashMap<String, u32>,
    pub by_role: HashMap<String, u32>,
    pub total: u32,
}

/// `analyze_stats` structuredContent.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct AnalyzeStatsResult {
    #[serde(default)]
    pub deck_id: String,
    pub total_cards: u32,
    pub nonland_cards: u32,
    pub avg_mv: f64,
    pub avg_mv_nonland: f64,
    pub color_pips: HashMap<String, u32>,
    #[serde(default)]
    pub total_price_usd: f64,
    #[serde(default)]
    pub min_buy_usd: f64,
}

/// `analyze_mana_base` structuredContent.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct ManaBaseReport {
    pub deck_id: String,
    pub total_lands: u32,
    pub untapped_lands: u32,
    pub tapped_lands: u32,
    pub sources: HashMap<String, u32>,
    pub fixing_sources: u32,
    #[serde(default)]
    pub under_supported: Vec<String>,
}

/// One role's band from `analyze_role_coverage.gaps`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct RoleGap {
    pub role: String,
    pub have: u32,
    pub want_min: u32,
    pub want_max: u32,
    /// "under" | "ok" | "over".
    pub status: String,
}

/// `analyze_role_coverage` structuredContent.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct RoleCoverageResult {
    pub deck_id: String,
    #[serde(default)]
    pub counts: HashMap<String, u32>,
    pub gaps: Vec<RoleGap>,
}

/// `simulate_deck` structuredContent. `lands_by_turn` keys arrive as JSON
/// object keys, i.e. strings ("1".."10").
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct SimResult {
    pub deck_id: String,
    pub trials: u32,
    pub keepable_rate: f64,
    pub mulligan_rate: f64,
    pub dead_on_arrival_rate: f64,
    pub avg_opening_lands: f64,
    pub lands_by_turn: HashMap<String, f64>,
    pub first_spell_rate: f64,
    #[serde(default)]
    pub avg_turn_to_first_spell: Option<f64>,
}

// ---- collection_* (gui-collection) -------------------------------------------

/// One owned card in the collection view.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct OwnedCard {
    pub oracle_id: String,
    #[serde(default)]
    pub name: Option<String>,
}

/// The shared collection view returned by collection_set/add/get/clear
/// (+ `unresolved` on mutations). Membership-only — no quantities.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct CollectionView {
    pub owned_count: u32,
    #[serde(default)]
    pub owned: Vec<String>,
    #[serde(default)]
    pub cards: Vec<OwnedCard>,
    #[serde(default)]
    pub unresolved: Vec<String>,
}

// ---- meta_* / budget_plan (gui-meta) -----------------------------------------

/// Bracket pushers — card-name lists per category (combos formatted "A + B").
#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
pub struct BracketPushers {
    #[serde(default)]
    pub game_changers: Vec<String>,
    #[serde(default)]
    pub fast_mana: Vec<String>,
    #[serde(default)]
    pub tutors: Vec<String>,
    #[serde(default)]
    pub mld: Vec<String>,
    #[serde(default)]
    pub combos: Vec<String>,
    #[serde(default)]
    pub extra_turns: Vec<String>,
}

/// `meta_classify_bracket` structuredContent (also embedded in deck_summary).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct BracketResult {
    #[serde(default)]
    pub deck_id: String,
    pub bracket: u8,
    #[serde(default)]
    pub pushers: BracketPushers,
    #[serde(default)]
    pub rationale: String,
}

/// `meta_deck_summary` structuredContent — never throws; bracket may be null
/// with bracket_unavailable=true when enrichment is down.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct DeckSummaryResult {
    pub deck_id: String,
    #[serde(default)]
    pub commander_count: u32,
    pub stats: AnalyzeStatsResult,
    #[serde(default)]
    pub bracket: Option<BracketResult>,
    #[serde(default)]
    pub bracket_unavailable: bool,
}

/// One EDHREC-backed recommendation / missing staple.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Recommendation {
    pub oracle_id: String,
    pub name: String,
    #[serde(default)]
    pub synergy: f64,
    #[serde(default)]
    pub inclusion: f64,
    #[serde(default)]
    pub category: String,
}

/// `meta_recommendations` structuredContent.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct RecommendationsResult {
    pub deck_id: String,
    #[serde(default)]
    pub commander: String,
    #[serde(default)]
    pub recommendations: Vec<Recommendation>,
    #[serde(default)]
    pub unresolved: Vec<Value>,
}

/// `meta_missing_staples` structuredContent.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct MissingStaplesResult {
    pub deck_id: String,
    #[serde(default)]
    pub commander: String,
    #[serde(default)]
    pub missing: Vec<Recommendation>,
    #[serde(default)]
    pub unresolved: Vec<Value>,
}

/// One side of a budget swap.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct SwapCard {
    pub oracle_id: String,
    pub name: String,
    #[serde(default)]
    pub cheapest_usd: f64,
    #[serde(default)]
    pub qty: u32,
}

/// One budget swap (`in` is a Rust keyword — renamed).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct BudgetSwap {
    pub out: SwapCard,
    #[serde(rename = "in")]
    pub replacement: SwapCard,
    #[serde(default)]
    pub roles_matched: Vec<String>,
    #[serde(default)]
    pub savings: f64,
}

/// `meta_budget_swaps` structuredContent.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct BudgetSwapsResult {
    pub deck_id: String,
    #[serde(default)]
    pub commander: String,
    #[serde(default)]
    pub swaps: Vec<BudgetSwap>,
    #[serde(default)]
    pub current_min_buy_usd: f64,
    #[serde(default)]
    pub projected_min_buy_usd: f64,
    #[serde(default)]
    pub target_usd: Option<f64>,
}

/// One Commander Spellbook combo.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Combo {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub pieces: Vec<String>,
    #[serde(default)]
    pub produces: Vec<String>,
    #[serde(default)]
    pub steps: Option<String>,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub confidence: Option<String>,
}

/// `meta_combos` structuredContent.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct CombosResult {
    pub deck_id: String,
    #[serde(default)]
    pub combos: Vec<Combo>,
    #[serde(default)]
    pub included_count: u32,
    #[serde(default)]
    pub almost_count: u32,
}

/// One reprint suggestion in `budget_plan`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct ReprintSuggestion {
    pub oracle_id: String,
    pub name: String,
    #[serde(default)]
    pub qty: u32,
    #[serde(default)]
    pub default_usd: f64,
    #[serde(default)]
    pub cheapest_usd: f64,
    #[serde(default)]
    pub savings: f64,
}

/// One cost driver in `budget_plan`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct CostDriver {
    pub oracle_id: String,
    pub name: String,
    #[serde(default)]
    pub qty: u32,
    #[serde(default)]
    pub cheapest_usd: f64,
    #[serde(default)]
    pub contribution: f64,
    #[serde(default)]
    pub roles: Vec<String>,
}

/// `budget_plan` structuredContent — fully typed (was raw Value).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct BudgetPlanResult {
    pub deck_id: String,
    #[serde(default)]
    pub default_total_usd: f64,
    #[serde(default)]
    pub min_buy_usd: f64,
    #[serde(default)]
    pub reprint_savings_usd: f64,
    #[serde(default)]
    pub reprint_suggestions: Vec<ReprintSuggestion>,
    #[serde(default)]
    pub cost_drivers: Vec<CostDriver>,
    #[serde(default)]
    pub target_usd: Option<f64>,
    #[serde(default)]
    pub over_min_buy_by_usd: Option<f64>,
    #[serde(default)]
    pub acquire_usd: Option<f64>,
    #[serde(default)]
    pub owned_value_usd: Option<f64>,
    #[serde(default)]
    pub over_acquire_by_usd: Option<f64>,
}

// ---- deck IO: import/export/snapshot/diff/restore (gui-deck-io) ---------------

/// `deck_snapshot` structuredContent.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct SnapshotResult {
    pub snapshot_id: String,
    pub version: u64,
}

/// `deck_diff` structuredContent — the diff payload kept loose (added/removed/
/// qty-changed/metadata lists rendered generically).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct DeckDiffResult {
    pub diff: Value,
}

/// `deck_restore` structuredContent.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct RestoreResult {
    pub deck_id: String,
    pub restored_from: String,
    pub deck: Deck,
}

/// `deck_import` structuredContent — unresolved lines are never dropped.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct ImportResult {
    pub deck_id: String,
    #[serde(default)]
    pub resolved_count: u32,
    #[serde(default)]
    pub unresolved: Vec<Value>,
}

/// `deck_export` structuredContent.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct ExportResult {
    pub deck_id: String,
    #[serde(default)]
    pub format: String,
    #[serde(default)]
    pub text: String,
}

// ---- data_* (release-first-run) -----------------------------------------------

/// One ingest run's pollable state (`data_status.ingest`).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct IngestStatus {
    pub running: bool,
    /// "idle" | "download" | "build" | "done" | "error".
    #[serde(default)]
    pub phase: String,
    #[serde(default)]
    pub started_at: Option<String>,
    #[serde(default)]
    pub finished_at: Option<String>,
    /// Fresh data_snapshot date, present when phase == "done".
    #[serde(default)]
    pub snapshot: Option<String>,
    #[serde(default)]
    pub cards: Option<u32>,
    #[serde(default)]
    pub skipped: Option<bool>,
    #[serde(default)]
    pub error: Option<String>,
}

/// `data_status` structuredContent. `data_snapshot` rides the universal stamp
/// and is the date of the index the RUNNING server serves.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct DataStatusResult {
    pub has_index: bool,
    pub ingest: IngestStatus,
    #[serde(default)]
    pub data_snapshot: Option<String>,
}

/// `data_ingest` structuredContent.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct DataIngestResult {
    pub started: bool,
    #[serde(default)]
    pub already_running: bool,
}

/// The companion as resolved by `deck_set_companion`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct CompanionRef {
    pub oracle_id: String,
    #[serde(default)]
    pub name: String,
}

/// `deck_set_companion` structuredContent. `companion` is the resolved card
/// when set, null when cleared; `detail` explains an ok=false; `condition_met`
/// is the advisory deckbuilding-condition check.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct SetCompanionResult {
    #[serde(default)]
    pub ok: bool,
    pub deck_id: String,
    #[serde(default)]
    pub companion: Option<CompanionRef>,
    #[serde(default)]
    pub condition_met: Option<bool>,
    #[serde(default)]
    pub detail: Option<String>,
    #[serde(default)]
    pub violations: Vec<Value>,
    #[serde(default)]
    pub version: u64,
}
