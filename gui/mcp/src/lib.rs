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
pub use types::{
    AddVerdict, CardDetail, CardGetResult, CardPrintingsResult, CardRef, CardSearchParams,
    CardSearchResult, Deck, DeckAddResult, DeckCardEntry, DeckCreateParams, DeckCreateResult,
    DeckGetResult, DeckListResult, DeckMutateResult, Printing, SetCommanderResult,
    ValidateDeckResult,
};

use http::{HeaderName, HeaderValue};
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

/// The `x-mcp-principal` header the engine reads to scope decks/collections.
const PRINCIPAL_HEADER: &str = "x-mcp-principal";

/// A connected MCP client to the engine. Owns the running rmcp service.
pub struct EngineClient {
    service: RunningService<RoleClient, ClientInfo>,
}

impl EngineClient {
    /// Connect to the engine at `base_url` (e.g. `http://127.0.0.1:3000`),
    /// sending `principal` in the `x-mcp-principal` header.
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

    /// `validate_deck` — run the authoritative legality gate.
    pub async fn validate_deck(&self, deck_id: &str) -> Result<ValidateDeckResult, EngineError> {
        let mut args = Map::new();
        args.insert("deck_id".into(), Value::String(deck_id.to_string()));
        self.call("validate_deck", args).await
    }

    /// Gracefully close the connection.
    pub async fn shutdown(self) -> Result<(), EngineError> {
        self.service
            .cancel()
            .await
            .map_err(|e| EngineError::Transport(format!("shutdown failed: {e}")))?;
        Ok(())
    }

    /// Call a tool, route errors through the §8 mapper, and decode the
    /// `structuredContent` into `T`.
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
        if result.is_error.unwrap_or(false) {
            return Err(error::engine_error_from_payload(&structured));
        }
        if structured.is_null() {
            return Err(EngineError::Transport(format!(
                "{name} returned no structuredContent"
            )));
        }
        Ok(serde_json::from_value(structured)?)
    }
}
