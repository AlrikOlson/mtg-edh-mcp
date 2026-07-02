//! Typed async client over the mtg-edh-mcp engine's streamable-HTTP MCP surface.
//!
//! Wraps [`rmcp`]'s streamable-HTTP client transport. The engine
//! (`src/server/http.ts`) is a **stateless, POST-only** Streamable-HTTP server
//! that scopes all deck/collection state by the `x-mcp-principal` request
//! header (falling back to `"local"`). So we:
//!
//! * build the transport with [`StreamableHttpClientTransportConfig`] and set
//!   `allow_stateless = true` (no session handshake to maintain), and
//! * send the principal via `custom_headers` on every POST — *not* `auth_header`
//!   (rmcp issue #464 drops `auth_header` on the SSE GET, which we never use).
//!
//! ```no_run
//! # async fn demo() -> Result<(), mtg_edh_mcp_client::EngineError> {
//! use mtg_edh_mcp_client::{EngineClient, CardSearchParams};
//! let client = EngineClient::connect("http://127.0.0.1:3000", "local").await?;
//! let hits = client.card_search(CardSearchParams::new("lightning")).await?;
//! println!("{} cards", hits.total);
//! client.shutdown().await?;
//! # Ok(()) }
//! ```

mod error;
mod types;

pub use error::EngineError;
pub use serde_json;
pub use types::{
    AddVerdict, AnalyzeCompositionResult, AnalyzeCurveResult, AnalyzeStatsResult, BracketPushers,
    BracketResult, BudgetPlanResult, BudgetSwap, BudgetSwapsResult, CardDetail, CardGetResult,
    CardPrintingsResult, CardRef, CardSearchParams, CardSearchResult, CollectionView, Combo,
    CombosResult, CostDriver, Deck, DeckAddResult, DeckCardEntry, DeckCreateParams,
    DeckCreateResult, DeckDiffResult, DeckGetResult, DeckListResult, DeckMutateResult,
    DeckSummaryResult, ExportResult, ImportResult, ManaBaseReport, MissingStaplesResult, OwnedCard,
    Printing, Recommendation, RecommendationsResult, ReprintSuggestion, RestoreResult,
    RoleCoverageResult, RoleGap, SetCommanderResult, SimResult, SnapshotResult, SwapCard,
    ValidateDeckResult,
};

#[cfg(not(target_arch = "wasm32"))]
use http::{HeaderName, HeaderValue};
#[cfg(not(target_arch = "wasm32"))]
use rmcp::{
    model::{CallToolRequestParams, ClientCapabilities, ClientInfo, Implementation},
    service::{RoleClient, RunningService},
    transport::{
        streamable_http_client::StreamableHttpClientTransportConfig, StreamableHttpClientTransport,
    },
    ServiceExt,
};
use serde::de::DeserializeOwned;
use serde_json::{Map, Value};

/// Build the common `{ deck_id }` argument map.
fn deck_arg(deck_id: &str) -> Map<String, Value> {
    let mut args = Map::new();
    args.insert("deck_id".into(), Value::String(deck_id.to_string()));
    args
}

/// Build a `{ cards: [...] }` argument map (name-or-id strings).
fn cards_arg(cards: &[String]) -> Map<String, Value> {
    let mut args = Map::new();
    args.insert(
        "cards".into(),
        Value::Array(cards.iter().cloned().map(Value::String).collect()),
    );
    args
}

/// The `x-mcp-principal` header the engine reads to scope decks/collections.
const PRINCIPAL_HEADER: &str = "x-mcp-principal";

/// A connected MCP client to the engine. Native builds own a running rmcp
/// service; wasm builds hold a fetch-backed reqwest client and speak the
/// engine's stateless direct-POST contract (think:140).
pub struct EngineClient {
    #[cfg(not(target_arch = "wasm32"))]
    service: RunningService<RoleClient, ClientInfo>,
    #[cfg(target_arch = "wasm32")]
    url: String,
    #[cfg(target_arch = "wasm32")]
    principal: String,
    #[cfg(target_arch = "wasm32")]
    http: reqwest::Client,
}

impl EngineClient {
    /// Connect to the engine at `base_url` (e.g. `http://127.0.0.1:3000`),
    /// sending `principal` in the `x-mcp-principal` header.
    #[cfg(not(target_arch = "wasm32"))]
    pub async fn connect(base_url: &str, principal: &str) -> Result<Self, EngineError> {
        let principal_value = HeaderValue::from_str(principal)
            .map_err(|e| EngineError::Transport(format!("invalid principal '{principal}': {e}")))?;
        let mut headers = std::collections::HashMap::new();
        headers.insert(HeaderName::from_static(PRINCIPAL_HEADER), principal_value);

        let mut config =
            StreamableHttpClientTransportConfig::with_uri(base_url).custom_headers(headers);
        // No session handshake to maintain — the engine is stateless POST-only.
        config.allow_stateless = true;
        let transport = StreamableHttpClientTransport::from_config(config);

        let client_info = ClientInfo::new(
            ClientCapabilities::default(),
            Implementation::new("mtg-edh-gui", env!("CARGO_PKG_VERSION")),
        );
        let service = client_info
            .serve(transport)
            .await
            .map_err(|e| EngineError::Transport(format!("connect to {base_url} failed: {e}")))?;
        Ok(Self { service })
    }

    /// wasm connect: no handshake — the engine is stateless, every POST is
    /// self-contained. Reachability is proven by the caller's first probe call.
    #[cfg(target_arch = "wasm32")]
    pub async fn connect(base_url: &str, principal: &str) -> Result<Self, EngineError> {
        Ok(Self {
            url: base_url.to_string(),
            principal: principal.to_string(),
            http: reqwest::Client::new(),
        })
    }

    /// `card_search` — evaluate a Scryfall-grammar query against the index.
    pub async fn card_search(
        &self,
        params: CardSearchParams,
    ) -> Result<CardSearchResult, EngineError> {
        let mut args = Map::new();
        args.insert("query".into(), Value::String(params.query));
        if let Some(order) = params.order {
            args.insert("order".into(), Value::String(order));
        }
        if let Some(limit) = params.limit {
            args.insert("limit".into(), Value::from(limit));
        }
        if let Some(cursor) = params.cursor {
            args.insert("cursor".into(), Value::String(cursor));
        }
        if let Some(owned_only) = params.owned_only {
            args.insert("owned_only".into(), Value::Bool(owned_only));
        }
        self.call("card_search", args).await
    }

    /// `deck_create` — create a new versioned deck, returning its `deck_id`.
    pub async fn deck_create(
        &self,
        params: DeckCreateParams,
    ) -> Result<DeckCreateResult, EngineError> {
        let mut args = Map::new();
        args.insert("name".into(), Value::String(params.name));
        if let Some(format) = params.format {
            args.insert("format".into(), Value::String(format));
        }
        if !params.commanders.is_empty() {
            args.insert(
                "commanders".into(),
                Value::Array(params.commanders.into_iter().map(Value::String).collect()),
            );
        }
        if let Some(kind) = params.command_zone_kind {
            args.insert("command_zone_kind".into(), Value::String(kind));
        }
        self.call("deck_create", args).await
    }

    /// `deck_add` — add `(oracle_id, qty)` cards to a deck (batch, idempotent).
    pub async fn deck_add(
        &self,
        deck_id: &str,
        cards: &[(String, u32)],
    ) -> Result<DeckAddResult, EngineError> {
        let entries: Vec<Value> = cards
            .iter()
            .map(|(oracle_id, qty)| {
                let mut entry = Map::new();
                entry.insert("oracle_id".into(), Value::String(oracle_id.clone()));
                entry.insert("qty".into(), Value::from(*qty));
                Value::Object(entry)
            })
            .collect();
        let mut args = Map::new();
        args.insert("deck_id".into(), Value::String(deck_id.to_string()));
        args.insert("cards".into(), Value::Array(entries));
        self.call("deck_add", args).await
    }

    /// `card_get` — lean card details (oracle text, roles, legality, pricing).
    pub async fn card_get(&self, oracle_ids: &[String]) -> Result<CardGetResult, EngineError> {
        let mut args = Map::new();
        args.insert(
            "oracle_ids".into(),
            Value::Array(oracle_ids.iter().cloned().map(Value::String).collect()),
        );
        self.call("card_get", args).await
    }

    /// `card_printings` — every printing of a card with per-printing prices.
    pub async fn card_printings(
        &self,
        oracle_id: &str,
    ) -> Result<CardPrintingsResult, EngineError> {
        let mut args = Map::new();
        args.insert("oracle_id".into(), Value::String(oracle_id.to_string()));
        self.call("card_printings", args).await
    }

    /// `deck_get` — a deck's lean projection (entries carry name).
    pub async fn deck_get(&self, deck_id: &str) -> Result<DeckGetResult, EngineError> {
        let mut args = Map::new();
        args.insert("deck_id".into(), Value::String(deck_id.to_string()));
        self.call("deck_get", args).await
    }

    /// `deck_list` — all decks for this principal.
    pub async fn deck_list(&self) -> Result<DeckListResult, EngineError> {
        self.call("deck_list", Map::new()).await
    }

    /// `deck_remove` — remove `(oracle_id, qty)` cards from a deck.
    pub async fn deck_remove(
        &self,
        deck_id: &str,
        cards: &[(String, u32)],
    ) -> Result<DeckMutateResult, EngineError> {
        let entries: Vec<Value> = cards
            .iter()
            .map(|(oracle_id, qty)| {
                let mut entry = Map::new();
                entry.insert("oracle_id".into(), Value::String(oracle_id.clone()));
                entry.insert("qty".into(), Value::from(*qty));
                Value::Object(entry)
            })
            .collect();
        let mut args = Map::new();
        args.insert("deck_id".into(), Value::String(deck_id.to_string()));
        args.insert("cards".into(), Value::Array(entries));
        self.call("deck_remove", args).await
    }

    /// `deck_set_commander` — set commander(s) by name or oracle_id.
    pub async fn deck_set_commander(
        &self,
        deck_id: &str,
        commanders: &[String],
    ) -> Result<SetCommanderResult, EngineError> {
        let mut args = Map::new();
        args.insert("deck_id".into(), Value::String(deck_id.to_string()));
        args.insert(
            "commanders".into(),
            Value::Array(commanders.iter().cloned().map(Value::String).collect()),
        );
        self.call("deck_set_commander", args).await
    }

    /// `analyze_curve` — the mana-curve histogram.
    pub async fn analyze_curve(&self, deck_id: &str) -> Result<AnalyzeCurveResult, EngineError> {
        self.call("analyze_curve", deck_arg(deck_id)).await
    }

    /// `analyze_composition` — type + role breakdowns.
    pub async fn analyze_composition(
        &self,
        deck_id: &str,
    ) -> Result<AnalyzeCompositionResult, EngineError> {
        self.call("analyze_composition", deck_arg(deck_id)).await
    }

    /// `analyze_stats` — averages, pips, totals, min-buy.
    pub async fn analyze_stats(&self, deck_id: &str) -> Result<AnalyzeStatsResult, EngineError> {
        self.call("analyze_stats", deck_arg(deck_id)).await
    }

    /// `analyze_mana_base` — per-color sources + under-supported flags.
    pub async fn analyze_mana_base(&self, deck_id: &str) -> Result<ManaBaseReport, EngineError> {
        self.call("analyze_mana_base", deck_arg(deck_id)).await
    }

    /// `analyze_role_coverage` — role counts vs target bands.
    pub async fn analyze_role_coverage(
        &self,
        deck_id: &str,
    ) -> Result<RoleCoverageResult, EngineError> {
        self.call("analyze_role_coverage", deck_arg(deck_id)).await
    }

    /// `simulate_deck` — the deterministic Monte Carlo goldfish.
    pub async fn simulate_deck(
        &self,
        deck_id: &str,
        seed: Option<u32>,
        trials: Option<u32>,
    ) -> Result<SimResult, EngineError> {
        let mut args = deck_arg(deck_id);
        if let Some(seed) = seed {
            args.insert("seed".into(), Value::from(seed));
        }
        if let Some(trials) = trials {
            args.insert("trials".into(), Value::from(trials));
        }
        self.call("simulate_deck", args).await
    }

    /// `collection_get` — the owned-card set (membership-only).
    pub async fn collection_get(&self) -> Result<CollectionView, EngineError> {
        self.call("collection_get", Map::new()).await
    }

    /// `collection_add` — add cards (name or oracle_id); reports unresolved.
    pub async fn collection_add(&self, cards: &[String]) -> Result<CollectionView, EngineError> {
        self.call("collection_add", cards_arg(cards)).await
    }

    /// `collection_set` — replace the owned set (used for removal too).
    pub async fn collection_set(&self, cards: &[String]) -> Result<CollectionView, EngineError> {
        self.call("collection_set", cards_arg(cards)).await
    }

    /// `collection_clear` — empty the collection.
    pub async fn collection_clear(&self) -> Result<CollectionView, EngineError> {
        self.call("collection_clear", Map::new()).await
    }

    /// `budget_plan` — the deck budget report; `use_collection` adds
    /// `acquire_usd` (cost to finish from what you own).
    pub async fn budget_plan(
        &self,
        deck_id: &str,
        use_collection: bool,
    ) -> Result<BudgetPlanResult, EngineError> {
        let mut args = deck_arg(deck_id);
        if use_collection {
            args.insert("use_collection".into(), Value::Bool(true));
        }
        self.call("budget_plan", args).await
    }

    /// `meta_classify_bracket` — the 1–5 power bracket + pushers.
    /// UPSTREAM_UNAVAILABLE on a cold Game Changers cache miss.
    pub async fn meta_classify_bracket(&self, deck_id: &str) -> Result<BracketResult, EngineError> {
        self.call("meta_classify_bracket", deck_arg(deck_id)).await
    }

    /// `meta_deck_summary` — one-call overview; never throws on enrichment
    /// failure (bracket=null + bracket_unavailable instead).
    pub async fn meta_deck_summary(&self, deck_id: &str) -> Result<DeckSummaryResult, EngineError> {
        self.call("meta_deck_summary", deck_arg(deck_id)).await
    }

    /// `meta_recommendations` — EDHREC synergy/inclusion picks.
    pub async fn meta_recommendations(
        &self,
        deck_id: &str,
        limit: Option<u32>,
    ) -> Result<RecommendationsResult, EngineError> {
        let mut args = deck_arg(deck_id);
        if let Some(limit) = limit {
            args.insert("limit".into(), Value::from(limit));
        }
        self.call("meta_recommendations", args).await
    }

    /// `meta_missing_staples` — high-inclusion cards the deck lacks.
    pub async fn meta_missing_staples(
        &self,
        deck_id: &str,
        limit: Option<u32>,
    ) -> Result<MissingStaplesResult, EngineError> {
        let mut args = deck_arg(deck_id);
        if let Some(limit) = limit {
            args.insert("limit".into(), Value::from(limit));
        }
        self.call("meta_missing_staples", args).await
    }

    /// `meta_budget_swaps` — role-matched cheaper replacements.
    pub async fn meta_budget_swaps(
        &self,
        deck_id: &str,
        limit: Option<u32>,
    ) -> Result<BudgetSwapsResult, EngineError> {
        let mut args = deck_arg(deck_id);
        if let Some(limit) = limit {
            args.insert("limit".into(), Value::from(limit));
        }
        self.call("meta_budget_swaps", args).await
    }

    /// `meta_combos` — Commander Spellbook combos in the deck.
    /// UPSTREAM_UNAVAILABLE on a cold Spellbook cache miss.
    pub async fn meta_combos(&self, deck_id: &str) -> Result<CombosResult, EngineError> {
        self.call("meta_combos", deck_arg(deck_id)).await
    }

    /// `deck_snapshot` — capture an immutable copy under a snapshot_id.
    pub async fn deck_snapshot(&self, deck_id: &str) -> Result<SnapshotResult, EngineError> {
        self.call("deck_snapshot", deck_arg(deck_id)).await
    }

    /// `deck_diff` — compare a snapshot against current (or a second snapshot).
    pub async fn deck_diff(
        &self,
        deck_id: &str,
        snapshot_id: &str,
    ) -> Result<DeckDiffResult, EngineError> {
        let mut args = deck_arg(deck_id);
        args.insert("snapshot_id".into(), Value::String(snapshot_id.to_string()));
        self.call("deck_diff", args).await
    }

    /// `deck_restore` — roll back to a snapshot (a version-bumping mutation).
    pub async fn deck_restore(
        &self,
        deck_id: &str,
        snapshot_id: &str,
    ) -> Result<RestoreResult, EngineError> {
        let mut args = deck_arg(deck_id);
        args.insert("snapshot_id".into(), Value::String(snapshot_id.to_string()));
        self.call("deck_restore", args).await
    }

    /// `deck_import` — parse a decklist; adds to `deck_id` or creates a deck.
    pub async fn deck_import(
        &self,
        text: &str,
        deck_id: Option<&str>,
        name: Option<&str>,
    ) -> Result<ImportResult, EngineError> {
        let mut args = Map::new();
        args.insert("text".into(), Value::String(text.to_string()));
        if let Some(id) = deck_id {
            args.insert("deck_id".into(), Value::String(id.to_string()));
        }
        if let Some(n) = name {
            args.insert("name".into(), Value::String(n.to_string()));
        }
        self.call("deck_import", args).await
    }

    /// `deck_export` — plaintext "<qty> <name>" decklist.
    pub async fn deck_export(&self, deck_id: &str) -> Result<ExportResult, EngineError> {
        self.call("deck_export", deck_arg(deck_id)).await
    }

    /// `validate_deck` — run the authoritative legality gate.
    pub async fn validate_deck(&self, deck_id: &str) -> Result<ValidateDeckResult, EngineError> {
        let mut args = Map::new();
        args.insert("deck_id".into(), Value::String(deck_id.to_string()));
        self.call("validate_deck", args).await
    }

    /// Gracefully close the connection.
    #[cfg(not(target_arch = "wasm32"))]
    pub async fn shutdown(self) -> Result<(), EngineError> {
        self.service
            .cancel()
            .await
            .map_err(|e| EngineError::Transport(format!("shutdown failed: {e}")))?;
        Ok(())
    }

    /// Call a tool, route errors through the §8 mapper, and decode the
    /// `structuredContent` into `T`.
    #[cfg(not(target_arch = "wasm32"))]
    async fn call<T: DeserializeOwned>(
        &self,
        name: &'static str,
        args: Map<String, Value>,
    ) -> Result<T, EngineError> {
        let result = self
            .service
            .call_tool(CallToolRequestParams::new(name).with_arguments(args))
            .await
            .map_err(|e| EngineError::Transport(format!("call_tool {name} failed: {e}")))?;

        let structured = result.structured_content.unwrap_or(Value::Null);
        decode_structured(name, structured, result.is_error.unwrap_or(false))
    }

    /// wasm call: direct stateless JSON-RPC POST; the reply is SSE-framed
    /// (`event: message` / `data: {...}`) — parse the first data: line.
    #[cfg(target_arch = "wasm32")]
    async fn call<T: DeserializeOwned>(
        &self,
        name: &'static str,
        args: Map<String, Value>,
    ) -> Result<T, EngineError> {
        let body = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": { "name": name, "arguments": Value::Object(args) },
        });
        let text = self
            .http
            .post(&self.url)
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream")
            .header(PRINCIPAL_HEADER, &self.principal)
            .json(&body)
            .send()
            .await
            .map_err(|e| EngineError::Transport(format!("POST {name} failed: {e}")))?
            .text()
            .await
            .map_err(|e| EngineError::Transport(format!("read {name} reply failed: {e}")))?;
        let data = text
            .lines()
            .find_map(|l| l.strip_prefix("data: "))
            .unwrap_or(text.trim());
        let rpc: Value = serde_json::from_str(data)?;
        if let Some(err) = rpc.get("error") {
            return Err(EngineError::Transport(format!("{name} rpc error: {err}")));
        }
        let result = rpc.get("result").cloned().unwrap_or(Value::Null);
        let is_error = result
            .get("isError")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let structured = result
            .get("structuredContent")
            .cloned()
            .unwrap_or(Value::Null);
        decode_structured(name, structured, is_error)
    }

    /// wasm shutdown: nothing to tear down (no long-lived service).
    #[cfg(target_arch = "wasm32")]
    pub async fn shutdown(self) -> Result<(), EngineError> {
        Ok(())
    }
}

/// Shared tail of every tool call: engine error mapping + typed decode.
fn decode_structured<T: DeserializeOwned>(
    name: &'static str,
    structured: Value,
    is_error: bool,
) -> Result<T, EngineError> {
    if is_error {
        return Err(error::engine_error_from_payload(&structured));
    }
    if structured.is_null() {
        return Err(EngineError::Transport(format!(
            "{name} returned no structuredContent"
        )));
    }
    Ok(serde_json::from_value(structured)?)
}
