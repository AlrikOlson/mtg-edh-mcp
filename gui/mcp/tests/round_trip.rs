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
        assert_eq!(plan.deck_id, deck_id);
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

    // gui-deck-io wrappers: export → snapshot → mutate → diff → restore.
    let exported = client.deck_export(&deck_id).await.expect("deck_export");
    assert_eq!(exported.deck_id, deck_id);
    let snap = client.deck_snapshot(&deck_id).await.expect("deck_snapshot");
    assert!(!snap.snapshot_id.is_empty());
    if let Some(hit) = hits.results.first() {
        // Mutate (re-add the card removed earlier), then diff vs the snapshot.
        client
            .deck_add(&deck_id, &[(hit.oracle_id.clone(), 1)])
            .await
            .expect("deck_add (io)");
        let diff = client
            .deck_diff(&deck_id, &snap.snapshot_id)
            .await
            .expect("deck_diff");
        assert!(diff.diff.is_object());
        let restored = client
            .deck_restore(&deck_id, &snap.snapshot_id)
            .await
            .expect("deck_restore");
        assert_eq!(restored.restored_from, snap.snapshot_id);
        assert_eq!(restored.deck.deck_id, deck_id);
    }
    // Import into the same deck (plaintext); shape-safe when index is empty.
    let import_text = hits
        .results
        .first()
        .map(|h| format!("1 {}", h.name))
        .unwrap_or_else(|| "1 Definitely Not A Real Card".to_string());
    let imported = client
        .deck_import(&import_text, Some(&deck_id), None)
        .await
        .expect("deck_import");
    assert_eq!(imported.deck_id, deck_id);
    assert_eq!(
        imported.resolved_count as usize + imported.unresolved.len(),
        1
    );

    // gui-oracle-whatif: the projection round-trip must be LEAK-FREE — the
    // deck's card set is identical after snapshot → apply → analyze → restore.
    if let Some(hit) = hits.results.first() {
        let before = client.deck_get(&deck_id).await.expect("deck_get before");
        let mut before_set: Vec<String> = before
            .deck
            .cards
            .iter()
            .map(|e| e.oracle_id.clone())
            .collect();
        before_set.sort();
        let snap = client
            .deck_snapshot(&deck_id)
            .await
            .expect("whatif snapshot");
        client
            .deck_remove(&deck_id, &[(hit.oracle_id.clone(), 1)])
            .await
            .expect("whatif transient remove");
        let projected = client.analyze_curve(&deck_id).await.expect("whatif curve");
        assert!(projected.total <= before.deck.cards.len() as u32 + 100);
        client
            .deck_restore(&deck_id, &snap.snapshot_id)
            .await
            .expect("whatif restore");
        let after = client.deck_get(&deck_id).await.expect("deck_get after");
        let mut after_set: Vec<String> = after
            .deck
            .cards
            .iter()
            .map(|e| e.oracle_id.clone())
            .collect();
        after_set.sort();
        assert_eq!(before_set, after_set, "projection leaked into the deck");
        assert!(
            after.deck.version > before.deck.version,
            "restore bumps version"
        );
    }

    // gui-meta wrappers. deck_summary NEVER throws on enrichment failure
    // (bracket=null + bracket_unavailable). Bracket/combos may legitimately be
    // UpstreamUnavailable in test runs — both outcomes are valid; only the
    // wire+shape contract is asserted.
    let summary = client
        .meta_deck_summary(&deck_id)
        .await
        .expect("meta_deck_summary must not throw");
    assert_eq!(summary.deck_id, deck_id);
    assert!(
        summary.bracket.is_some() || summary.bracket_unavailable || summary.stats.total_cards == 0
    );
    match client.meta_classify_bracket(&deck_id).await {
        Ok(b) => assert!((1..=5).contains(&b.bracket)),
        Err(EngineError::UpstreamUnavailable { .. }) => {}
        Err(other) => panic!("meta_classify_bracket: unexpected error {other:?}"),
    }
    match client.meta_combos(&deck_id).await {
        Ok(c) => assert_eq!(c.deck_id, deck_id),
        Err(EngineError::UpstreamUnavailable { .. }) => {}
        Err(other) => panic!("meta_combos: unexpected error {other:?}"),
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

/// The stdio child-process channel (release-hardening, think:168): spawn the
/// engine over pipes — no TCP listener anywhere — and drive the same core
/// wire: connect → card_search → deck lifecycle → §8 error mapping. The rmcp
/// initialize handshake doubles as the readiness wait (no polling loop).
#[tokio::test]
#[ignore = "spawns node dist/main.js — run `npm run build` first, then `cargo test -- --ignored`"]
async fn round_trip_over_stdio() {
    let root = repo_root();
    let main_js = root.join("dist/main.js");
    assert!(
        main_js.exists(),
        "{} missing — run `npm run build` at the repo root first",
        main_js.display()
    );

    let mut cmd = tokio::process::Command::new("node");
    cmd.arg("dist/main.js").current_dir(&root);
    let client = EngineClient::connect_stdio(cmd)
        .await
        .expect("connect_stdio: spawn + initialize handshake");

    let hits = client
        .card_search(CardSearchParams {
            query: "t:creature".into(),
            limit: Some(5),
            ..Default::default()
        })
        .await
        .expect("card_search over stdio");
    assert_eq!(hits.returned as usize, hits.results.len());

    let created = client
        .deck_create(DeckCreateParams {
            name: "stdio round-trip".into(),
            format: Some("commander".into()),
            ..Default::default()
        })
        .await
        .expect("deck_create over stdio");
    let deck_id = created.deck_id;
    assert!(!deck_id.is_empty());

    let oracle_id = hits
        .results
        .first()
        .map(|c| c.oracle_id.clone())
        .unwrap_or_else(|| "00000000-0000-0000-0000-000000000000".into());
    let added = client
        .deck_add(&deck_id, &[(oracle_id, 1)])
        .await
        .expect("deck_add over stdio");
    assert_eq!(added.verdicts.len(), 1);

    // The stdio server is one long-lived process — the single "local" session
    // must see the deck across calls (no per-request store resets).
    let validated = client.validate_deck(&deck_id).await.expect("validate_deck");
    assert_eq!(validated.deck_id, deck_id);
    let listed = client.deck_list().await.expect("deck_list");
    assert!(listed.decks.iter().any(|d| d.deck_id == deck_id));

    // §8 mapping survives the transport swap.
    let err = client
        .validate_deck("deck-that-does-not-exist")
        .await
        .expect_err("validate_deck on unknown deck should error");
    assert!(
        matches!(err, EngineError::DeckNotFound { .. }),
        "expected DeckNotFound, got {err:?}"
    );

    // data_* wrappers (release-first-run): this dev checkout HAS an index; the
    // ingest state is idle and no run is started here (it would hit Scryfall).
    let ds = client.data_status().await.expect("data_status");
    assert!(ds.has_index, "dev checkout should serve an index");
    assert!(!ds.ingest.running);
    assert_eq!(ds.ingest.phase, "idle");
    assert!(ds.data_snapshot.is_some(), "stamped snapshot date expected");

    client.shutdown().await.ok();
}

/// Cold-start contract (release-first-run): with an EMPTY data dir the engine
/// still boots over stdio, reports has_index=false, and ping works — the state
/// the GUI onboarding dialog keys on.
#[tokio::test]
#[ignore = "spawns node dist/main.js — run `npm run build` first, then `cargo test -- --ignored`"]
async fn cold_start_without_data_dir() {
    let root = repo_root();
    assert!(root.join("dist/main.js").exists());
    let empty = std::env::temp_dir().join(format!("mtg-edh-cold-{}", std::process::id()));
    std::fs::create_dir_all(&empty).expect("mk empty data dir");

    let mut cmd = tokio::process::Command::new("node");
    cmd.arg("dist/main.js")
        .current_dir(&root)
        .env("MCP_DATA_DIR", &empty);
    let client = EngineClient::connect_stdio(cmd)
        .await
        .expect("cold engine must handshake without an index");

    let ds = client.data_status().await.expect("data_status (cold)");
    assert!(!ds.has_index, "empty data dir must report has_index=false");
    assert_eq!(ds.ingest.phase, "idle");

    // Card tools are absent without an index — the error is a clean tool-level
    // failure, not a hang or transport death.
    let err = client
        .card_search(CardSearchParams::new("t:creature"))
        .await
        .expect_err("card_search must fail cleanly with no index");
    drop(err);

    client.shutdown().await.ok();
    std::fs::remove_dir_all(&empty).ok();
}

/// Deck durability (release-deck-persistence): a deck created in one engine
/// process must be served by the NEXT engine process from the same data dir —
/// the exact restart the update-card-data reconnect performs.
#[tokio::test]
#[ignore = "spawns node dist/main.js — run `npm run build` first, then `cargo test -- --ignored`"]
async fn deck_survives_engine_restart() {
    let root = repo_root();
    assert!(root.join("dist/main.js").exists());
    let data = std::env::temp_dir().join(format!("mtg-edh-persist-{}", std::process::id()));
    std::fs::create_dir_all(&data).expect("mk data dir");

    let spawn = |root: &std::path::Path, data: &std::path::Path| {
        let mut cmd = tokio::process::Command::new("node");
        cmd.arg("dist/main.js").current_dir(root).env("MCP_DATA_DIR", data);
        cmd
    };

    // First life: create a deck, then shut down cleanly.
    let client = EngineClient::connect_stdio(spawn(&root, &data))
        .await
        .expect("first engine life");
    let created = client
        .deck_create(DeckCreateParams {
            name: "persisted across lives".into(),
            format: Some("commander".into()),
            ..Default::default()
        })
        .await
        .expect("deck_create");
    let deck_id = created.deck_id;
    client.shutdown().await.ok();

    // Second life: a brand-new child on the same data dir must serve the deck.
    let client = EngineClient::connect_stdio(spawn(&root, &data))
        .await
        .expect("second engine life");
    let fetched = client.deck_get(&deck_id).await.expect("deck_get after restart");
    assert_eq!(fetched.deck.deck_id, deck_id);
    assert_eq!(fetched.deck.name, "persisted across lives");
    let listed = client.deck_list().await.expect("deck_list after restart");
    assert!(listed.decks.iter().any(|d| d.deck_id == deck_id));
    client.shutdown().await.ok();

    std::fs::remove_dir_all(&data).ok();
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
