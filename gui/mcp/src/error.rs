//! Maps the engine's structured §8 error codes (`src/types/errors.ts`) to a
//! typed Rust enum, so callers match on variants instead of parsing strings.
//!
//! The engine returns errors as a `CallToolResult` with `isError: true` and a
//! `structuredContent` payload of `{ code, message, details? }`.

use crate::types::CardRef;
use serde_json::Value;

/// A typed failure from the engine or the transport.
#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error("unknown card: {message}")]
    UnknownCard { message: String },

    #[error("ambiguous name: {message}")]
    AmbiguousName {
        message: String,
        candidates: Vec<CardRef>,
    },

    #[error("deck not found: {message}")]
    DeckNotFound { message: String },

    #[error("upstream unavailable: {message}")]
    UpstreamUnavailable {
        message: String,
        url: Option<String>,
        status: Option<u16>,
        reason: Option<String>,
    },

    /// Any other structured engine code (INVALID_QUERY, SINGLETON_VIOLATION, …).
    #[error("engine error [{code}]: {message}")]
    Engine { code: String, message: String },

    /// Transport / connection / protocol failure, or a malformed tool result.
    #[error("transport error: {0}")]
    Transport(String),

    /// `structuredContent` did not deserialize into the expected typed shape.
    #[error("decode error: {0}")]
    Decode(#[from] serde_json::Error),
}

/// Build an [`EngineError`] from an engine `{ code, message, details? }` payload.
pub(crate) fn engine_error_from_payload(payload: &Value) -> EngineError {
    let code = payload
        .get("code")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let message = payload
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let details = payload.get("details");

    match code.as_str() {
        "UNKNOWN_CARD" => EngineError::UnknownCard { message },
        "AMBIGUOUS_NAME" => {
            let candidates = details
                .and_then(|d| d.get("candidates"))
                .and_then(|c| serde_json::from_value::<Vec<CardRef>>(c.clone()).ok())
                .unwrap_or_default();
            EngineError::AmbiguousName { message, candidates }
        }
        "DECK_NOT_FOUND" => EngineError::DeckNotFound { message },
        "UPSTREAM_UNAVAILABLE" => EngineError::UpstreamUnavailable {
            message,
            url: details
                .and_then(|d| d.get("url"))
                .and_then(Value::as_str)
                .map(String::from),
            status: details
                .and_then(|d| d.get("status"))
                .and_then(Value::as_u64)
                .map(|n| n as u16),
            reason: details
                .and_then(|d| d.get("reason"))
                .and_then(Value::as_str)
                .map(String::from),
        },
        // Empty/missing code means the payload wasn't the structured shape we
        // expected; surface it as a generic engine error rather than guessing.
        _ => EngineError::Engine { code, message },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn maps_unknown_card() {
        let e = engine_error_from_payload(&json!({
            "code": "UNKNOWN_CARD",
            "message": "no card 'Lightnig Bolt'"
        }));
        match e {
            EngineError::UnknownCard { message } => assert!(message.contains("Lightnig Bolt")),
            other => panic!("expected UnknownCard, got {other:?}"),
        }
    }

    #[test]
    fn maps_ambiguous_name_with_candidates() {
        let e = engine_error_from_payload(&json!({
            "code": "AMBIGUOUS_NAME",
            "message": "matches 2 cards",
            "details": {
                "candidates": [
                    { "oracle_id": "a", "name": "Fire", "mv": 1.0, "ci": ["R"], "type": "Instant" },
                    { "oracle_id": "b", "name": "Fire // Ice", "mv": 2.0, "ci": ["U","R"], "type": "Instant" }
                ]
            }
        }));
        match e {
            EngineError::AmbiguousName { candidates, .. } => {
                assert_eq!(candidates.len(), 2);
                assert_eq!(candidates[0].name, "Fire");
            }
            other => panic!("expected AmbiguousName, got {other:?}"),
        }
    }

    #[test]
    fn maps_deck_not_found() {
        let e = engine_error_from_payload(&json!({
            "code": "DECK_NOT_FOUND",
            "message": "unknown deck 'd1'"
        }));
        assert!(matches!(e, EngineError::DeckNotFound { .. }));
    }

    #[test]
    fn maps_upstream_unavailable_details() {
        let e = engine_error_from_payload(&json!({
            "code": "UPSTREAM_UNAVAILABLE",
            "message": "edhrec down",
            "details": { "url": "https://edhrec.com", "status": 503, "reason": "maintenance" }
        }));
        match e {
            EngineError::UpstreamUnavailable { url, status, reason, .. } => {
                assert_eq!(url.as_deref(), Some("https://edhrec.com"));
                assert_eq!(status, Some(503));
                assert_eq!(reason.as_deref(), Some("maintenance"));
            }
            other => panic!("expected UpstreamUnavailable, got {other:?}"),
        }
    }

    #[test]
    fn maps_other_codes_to_generic_engine() {
        let e = engine_error_from_payload(&json!({
            "code": "SINGLETON_VIOLATION",
            "message": "too many copies"
        }));
        match e {
            EngineError::Engine { code, .. } => assert_eq!(code, "SINGLETON_VIOLATION"),
            other => panic!("expected Engine, got {other:?}"),
        }
    }

    #[test]
    fn missing_code_falls_back_to_generic_engine() {
        let e = engine_error_from_payload(&json!({ "oops": true }));
        assert!(matches!(e, EngineError::Engine { .. }));
    }
}
