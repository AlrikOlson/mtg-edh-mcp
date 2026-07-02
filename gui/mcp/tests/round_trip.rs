//! End-to-end round-trip against the real node engine.
//!
//! This test is `#[ignore]`d so the default `cargo test` never requires a live
//! server. To run it:
//!
//! ```sh
//! # from the repo root, once:
//! npm run build                 # produces dist/main.js
//! # then:
//! cargo test -p mtg-edh-mcp-client -- --ignored
//! ```
//!
//! It spawns `MCP_TRANSPORT=http MCP_HTTP_PORT=<free> node dist/main.js` (cwd =
//! repo root), waits for readiness, then drives the real wire:
//! `connect → card_search → deck_create → deck_add → validate_deck`, and proves
//! the §8 `DECK_NOT_FOUND` mapping. The child is killed on drop. Assertions check
//! the round-trip *shape* (transport + serde + error mapping), not row counts, so
//! the test passes whether or not the card index has been ingested.

use std::net::TcpListener;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use mtg_edh_mcp_client::{CardSearchParams, DeckCreateParams, EngineClient, EngineError};

/// Repo root, resolved from this crate's manifest dir (`gui/mcp` → `../..`).
fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("canonicalize repo root")
}

/// An ephemeral free TCP port (bind to :0, read it back, drop the listener).
fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .expect("bind ephemeral port")
        .local_addr()
        .expect("local_addr")
        .port()
}

#[tokio::test]
#[ignore = "spawns node dist/main.js — run `npm run build` first, then `cargo test -- --ignored`"]
async fn round_trip_against_engine() {
    let root = repo_root();
    let main_js = root.join("dist/main.js");
    assert!(
        main_js.exists(),
        "{} missing — run `npm run build` at the repo root first",
        main_js.display()
    );

    let port = free_port();
    let url = format!("http://127.0.0.1:{port}");

    // kill_on_drop ensures the child dies when `_child` leaves scope, even on panic.
    let _child = tokio::process::Command::new("node")
        .arg("dist/main.js")
        .current_dir(&root)
        .env("MCP_TRANSPORT", "http")
        .env("MCP_HTTP_PORT", port.to_string())
        .env("MCP_HTTP_HOST", "127.0.0.1")
        .kill_on_drop(true)
        .spawn()
        .expect("spawn `node dist/main.js`");

    let client = await_ready(&url, "local").await;

    // card_search — just prove the call + serde round-trips (index may be empty).
    let hits = client
        .card_search(CardSearchParams {
            query: "t:creature".into(),
            limit: Some(5),
            ..Default::default()
        })
        .await
        .expect("card_search");
    assert_eq!(hits.returned as usize, hits.results.len());

    // card_get + card_printings — round-trip the gui-card wrappers when the
    // index has cards (shape-safe when empty).
    if let Some(hit) = hits.results.first() {
        let got = client
            .card_get(std::slice::from_ref(&hit.oracle_id))
            .await
            .expect("card_get");
        assert_eq!(got.cards.len(), 1);
        assert_eq!(got.cards[0].oracle_id, hit.oracle_id);
        let prints = client
            .card_printings(&hit.oracle_id)
            .await
            .expect("card_printings");
        assert_eq!(prints.oracle_id, hit.oracle_id);
    }

    // deck_create — scoped to the "local" principal we connected with.
    let created = client
        .deck_create(DeckCreateParams {
            name: "e2e round-trip".into(),
            format: Some("commander".into()),
            ..Default::default()
        })
        .await
        .expect("deck_create");
    let deck_id = created.deck_id;
    assert!(!deck_id.is_empty());

    // deck_add — use a real oracle_id if the index gave us one, else a stand-in.
    // Either way the engine returns one verdict; we assert the round-trip shape.
    let oracle_id = hits
        .results
        .first()
        .map(|c| c.oracle_id.clone())
        .unwrap_or_else(|| "00000000-0000-0000-0000-000000000000".into());
    let added = client
        .deck_add(&deck_id, &[(oracle_id, 1)])
        .await
        .expect("deck_add");
    assert_eq!(added.deck_id, deck_id);
    assert_eq!(added.verdicts.len(), 1);

    // validate_deck — same session sees the deck we just created.
    let validated = client.validate_deck(&deck_id).await.expect("validate_deck");
    assert_eq!(validated.deck_id, deck_id);

    // gui-collection wrappers: add → get → budget(use_collection) → set([]) round-trip.
    if let Some(hit) = hits.results.first() {
        let added = client
            .collection_add(std::slice::from_ref(&hit.oracle_id))
            .await
            .expect("collection_add");
        assert!(added.owned.contains(&hit.oracle_id));
        assert!(added.unresolved.is_empty());
        let got = client.collection_get().await.expect("collection_get");
        assert_eq!(got.owned_count, added.owned_count);
        let plan = client
            .budget_plan(&deck_id, true)
            .await
            .expect("budget_plan use_collection");
        assert!(plan.is_object());
        let cleared = client.collection_set(&[]).await.expect("collection_set");
        assert_eq!(cleared.owned_count, 0);
    }

    // gui-analysis wrappers: analyze_* + deterministic sim round-trip.
    let curve = client.analyze_curve(&deck_id).await.expect("analyze_curve");
    assert_eq!(curve.deck_id, deck_id);
    let stats = client.analyze_stats(&deck_id).await.expect("analyze_stats");
    assert_eq!(stats.deck_id, deck_id);
    client
        .analyze_composition(&deck_id)
        .await
        .expect("analyze_composition");
    client
        .analyze_mana_base(&deck_id)
        .await
        .expect("analyze_mana_base");
    client
        .analyze_role_coverage(&deck_id)
        .await
        .expect("analyze_role_coverage");
    let sim1 = client
        .simulate_deck(&deck_id, Some(42), Some(200))
        .await
        .expect("simulate_deck");
    let sim2 = client
        .simulate_deck(&deck_id, Some(42), Some(200))
        .await
        .expect("simulate_deck (2)");
    assert_eq!(
        sim1.keepable_rate, sim2.keepable_rate,
        "identical seed must be deterministic"
    );

    // gui-deck wrappers: list → get → remove round-trip.
    let listed = client.deck_list().await.expect("deck_list");
    assert!(listed.decks.iter().any(|d| d.deck_id == deck_id));
    let fetched = client.deck_get(&deck_id).await.expect("deck_get").deck;
    assert_eq!(fetched.deck_id, deck_id);
    if let Some(entry) = fetched.cards.first() {
        let removed = client
            .deck_remove(&deck_id, &[(entry.oracle_id.clone(), 1)])
            .await
            .expect("deck_remove");
        assert_eq!(removed.deck_id, deck_id);
    }

    // §8 mapping: an unknown deck surfaces as the typed DeckNotFound variant.
    let err = client
        .validate_deck("deck-that-does-not-exist")
        .await
        .expect_err("validate_deck on unknown deck should error");
    assert!(
        matches!(err, EngineError::DeckNotFound { .. }),
        "expected DeckNotFound, got {err:?}"
    );

    client.shutdown().await.ok();
}

/// Retry `connect` + a trivial `card_search` until the server answers, up to 30s.
async fn await_ready(url: &str, principal: &str) -> EngineClient {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if let Ok(client) = EngineClient::connect(url, principal).await {
            let ok = client
                .card_search(CardSearchParams {
                    query: "t:creature".into(),
                    limit: Some(1),
                    ..Default::default()
                })
                .await
                .is_ok();
            if ok {
                return client;
            }
            client.shutdown().await.ok();
        }
        assert!(
            Instant::now() < deadline,
            "engine not ready within 30s at {url}"
        );
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}
