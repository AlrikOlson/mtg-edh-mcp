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
