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
#[derive(Debug, Clone, Deserialize)]
pub struct CardSearchResult {
    pub total: u64,
    pub returned: u64,
    pub next_cursor: Option<String>,
    pub results: Vec<CardRef>,
}

/// `deck_create` structuredContent. `deck` kept opaque for now.
#[derive(Debug, Clone, Deserialize)]
pub struct DeckCreateResult {
    pub deck_id: String,
    pub deck: Value,
}

/// One entry of `deck_add`'s `verdicts`.
#[derive(Debug, Clone, Deserialize)]
pub struct AddVerdict {
    pub oracle_id: String,
    /// `"ok" | "added_illegal" | "rejected"`.
    pub status: String,
    #[serde(default)]
    pub violations: Vec<Value>,
}

/// `deck_add` structuredContent.
#[derive(Debug, Clone, Deserialize)]
pub struct DeckAddResult {
    pub deck_id: String,
    pub version: u64,
    pub verdicts: Vec<AddVerdict>,
}

/// `validate_deck` structuredContent. Violations kept opaque for now.
#[derive(Debug, Clone, Deserialize)]
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
