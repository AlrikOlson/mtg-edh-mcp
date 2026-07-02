//! Signals app-state: the EngineClient handle, connection lifecycle, and the
//! active deck/session. Provided via context from the app root.
//!
//! Connection flow (ADR 0001 "dev" + "sidecar" modes): try the configured URL;
//! if unreachable, optionally spawn the node engine as a sidecar child
//! (`MCP_TRANSPORT=http node dist/main.js`) and retry with backoff. Every
//! failure lands in an explicit Offline state with a Retry affordance —
//! mirroring the engine's graceful-degradation ethos.

use dioxus::prelude::*;
use mtg_edh_mcp_client::{serde_json, EngineClient};
use std::sync::Arc;
#[cfg(not(target_arch = "wasm32"))]
use std::time::Duration;

/// Engine connection lifecycle, surfaced in the top bar. The `Ready` payload
/// is the shared client handle the object screens (gui-card onward) consume.
#[derive(Clone)]
#[allow(dead_code)] // Ready's client handle is consumed by the object screens (gui-card+)
pub enum ConnState {
    Connecting,
    Ready(Arc<EngineClient>),
    Offline(String),
}

/// Engine-computed projection of a pending Oracle change-set (gui-oracle-whatif).
/// Transient by nature — never persisted; cleared on accept/reject/new ask.
#[derive(Clone, PartialEq)]
pub struct WhatIf {
    pub curve: Vec<(String, u32)>,
    pub keepable_rate: f64,
    pub avg_mv_nonland: f64,
    pub total_cards: u32,
}

/// Global app state, provided via context at the root.
#[derive(Clone, Copy)]
pub struct AppState {
    pub conn: Signal<ConnState>,
    /// The x-mcp-principal scoping decks/collection. "local" until profiles exist.
    pub principal: Signal<String>,
    /// The active deck, once one is created/selected (gui-deck).
    pub active_deck_id: Signal<Option<String>>,
    pub active_deck_name: Signal<Option<String>>,
    /// Bumped after ANY deck mutation (from any screen) so every deck-reading
    /// resource refetches — the shared cross-screen refresh signal.
    pub deck_rev: Signal<u32>,
    /// Snapshots taken this session: (snapshot_id, version-at-capture). The
    /// engine has no snapshot-list tool, so the GUI tracks what it took.
    pub snapshots: Signal<Vec<(String, u64)>>,
    /// True once restore_session has run. Saves are gated on this — otherwise
    /// the boot-time save effect would overwrite the stored session with nulls
    /// before restore ever reads it.
    pub hydrated: Signal<bool>,
    /// The pending change-set's projected analysis (ghost overlays in the rail).
    pub whatif: Signal<Option<WhatIf>>,
}

/// Engine base URL: MTG_EDH_MCP_URL overrides; default matches the engine's
/// MCP_HTTP_PORT default.
fn engine_url() -> String {
    #[cfg(not(target_arch = "wasm32"))]
    if let Ok(url) = std::env::var("MTG_EDH_MCP_URL") {
        return url;
    }
    "http://127.0.0.1:3000".to_string()
}

#[cfg(not(target_arch = "wasm32"))]
/// Dev sidecar entrypoint: MTG_EDH_MCP_DIST overrides; falls back to the repo
/// checkout's dist/main.js relative to this crate (compile-time path — dev
/// only; bundled-.app resolution is gui-app-shell's deferred sidecar work).
fn sidecar_dist() -> Option<std::path::PathBuf> {
    if let Ok(p) = std::env::var("MTG_EDH_MCP_DIST") {
        return Some(p.into());
    }
    let dev = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../dist/main.js");
    dev.canonicalize().ok()
}

#[cfg(not(target_arch = "wasm32"))]
/// The bundled engine binary (Node SEA, built by scripts/package-engine.sh):
/// MTG_EDH_ENGINE_BIN overrides; otherwise a sibling of the app executable
/// (dx bundle external_bin lands in Contents/MacOS next to the app binary).
fn bundled_engine() -> Option<std::path::PathBuf> {
    if let Ok(p) = std::env::var("MTG_EDH_ENGINE_BIN") {
        return Some(p.into());
    }
    let exe = std::env::current_exe().ok()?;
    let sibling = exe.parent()?.join("mtg-edh-engine");
    sibling.exists().then_some(sibling)
}

#[cfg(not(target_arch = "wasm32"))]
/// The bundled card-data snapshot (dx bundle resources → Contents/Resources).
fn bundled_data_dir(engine: &std::path::Path) -> Option<std::path::PathBuf> {
    if let Ok(p) = std::env::var("MCP_DATA_DIR") {
        return Some(p.into());
    }
    let resources = engine.parent()?.parent()?.join("Resources/data/cards");
    resources.exists().then_some(resources)
}

#[cfg(not(target_arch = "wasm32"))]
/// True when the developer explicitly opted into the HTTP transport
/// (`MTG_EDH_DEV_HTTP=1`, or a custom engine URL). The packaged app never sets
/// these, so a default launch owns no TCP listener at all (think:168).
fn dev_http_mode() -> bool {
    std::env::var("MTG_EDH_DEV_HTTP").is_ok() || std::env::var("MTG_EDH_MCP_URL").is_ok()
}

#[cfg(not(target_arch = "wasm32"))]
/// The engine invocation for the stdio channel: bundled SEA binary first,
/// dev-checkout `node dist/main.js` fallback. No `MCP_TRANSPORT` — stdio is
/// the engine's default, and rmcp's `TokioChildProcess` owns the pipes.
fn engine_command() -> Result<tokio::process::Command, String> {
    if let Some(engine) = bundled_engine() {
        let mut cmd = tokio::process::Command::new(&engine);
        if let Some(data) = bundled_data_dir(&engine) {
            cmd.env("MCP_DATA_DIR", data);
        }
        cmd.stderr(std::process::Stdio::null());
        return Ok(cmd);
    }
    let dist =
        sidecar_dist().ok_or("no bundled engine and no dist/main.js (run `npm run build`)")?;
    let root = dist
        .parent()
        .and_then(std::path::Path::parent)
        .ok_or("bad dist path")?
        .to_path_buf();
    let mut cmd = tokio::process::Command::new("node");
    cmd.arg(&dist)
        .current_dir(root)
        .stderr(std::process::Stdio::null());
    Ok(cmd)
}

#[cfg(not(target_arch = "wasm32"))]
/// Spawn the engine sidecar as an HTTP listener — DEV-HTTP MODE ONLY (the
/// stdio channel is the default; see `engine_command`). Bundled mode first
/// (SEA binary + piped stdin so the engine exits when we die —
/// MCP_WATCH_STDIN); dev-checkout node fallback.
fn spawn_sidecar() -> Result<(), String> {
    if let Some(engine) = bundled_engine() {
        let mut cmd = std::process::Command::new(&engine);
        cmd.env("MCP_TRANSPORT", "http")
            .env("MCP_WATCH_STDIN", "1")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        if let Some(data) = bundled_data_dir(&engine) {
            cmd.env("MCP_DATA_DIR", data);
        }
        let child = cmd
            .spawn()
            .map_err(|e| format!("failed to spawn bundled engine: {e}"))?;
        // Leak the child (and its stdin pipe write-end) for our lifetime; the
        // OS closes the pipe when we exit, which is exactly the kill signal.
        std::mem::forget(child);
        return Ok(());
    }
    let dist =
        sidecar_dist().ok_or("no bundled engine and no dist/main.js (run `npm run build`)")?;
    let root = dist
        .parent()
        .and_then(std::path::Path::parent)
        .ok_or("bad dist path")?
        .to_path_buf();
    std::process::Command::new("node")
        .arg(&dist)
        .current_dir(root)
        .env("MCP_TRANSPORT", "http")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("failed to spawn node sidecar: {e}"))
}

/// Provide the app state and kick off the initial connection attempt.
pub fn use_provide_app_state() -> AppState {
    let state = use_context_provider(|| AppState {
        conn: Signal::new(ConnState::Connecting),
        principal: Signal::new("local".to_string()),
        active_deck_id: Signal::new(None),
        active_deck_name: Signal::new(None),
        deck_rev: Signal::new(0),
        snapshots: Signal::new(Vec::new()),
        hydrated: Signal::new(false),
        whatif: Signal::new(None),
    });
    use_effect(move || {
        connect(state);
    });
    // Persist the session whenever its parts change (reads subscribe this
    // effect). Gated on hydration — see AppState.hydrated.
    use_effect(move || {
        let blob = persist_blob(&state);
        if !(state.hydrated)() {
            return;
        }
        spawn(async move {
            persist_write(blob).await;
        });
    });
    state
}

pub fn use_app_state() -> AppState {
    use_context::<AppState>()
}

// ---- Session persistence (gui-persist) ---------------------------------------
// One JSON blob {deck_id, deck_name, snapshots} — localStorage on web, a
// dotfile in $HOME on desktop. Restore validates via deck_get and falls back
// to deck_list; a vanished stored deck never wedges boot.

#[cfg(target_arch = "wasm32")]
const PERSIST_KEY: &str = "mtg-edh-gui-session";

fn persist_blob(state: &AppState) -> String {
    let snapshots: Vec<serde_json::Value> = (state.snapshots)()
        .into_iter()
        .map(|(id, v)| serde_json::json!([id, v]))
        .collect();
    serde_json::json!({
        "deck_id": (state.active_deck_id)(),
        "deck_name": (state.active_deck_name)(),
        "snapshots": snapshots,
    })
    .to_string()
}

#[cfg(not(target_arch = "wasm32"))]
fn persist_path() -> Option<std::path::PathBuf> {
    std::env::var("HOME")
        .ok()
        .map(|h| std::path::PathBuf::from(h).join(".mtg-edh-gui.json"))
}

#[cfg(not(target_arch = "wasm32"))]
async fn persist_write(blob: String) {
    if let Some(p) = persist_path() {
        let _ = std::fs::write(p, blob);
    }
}

#[cfg(not(target_arch = "wasm32"))]
async fn persist_read() -> Option<String> {
    std::fs::read_to_string(persist_path()?).ok()
}

#[cfg(target_arch = "wasm32")]
async fn persist_write(blob: String) {
    let js = format!(
        "localStorage.setItem('{PERSIST_KEY}', {});",
        serde_json::Value::String(blob)
    );
    let _ = document::eval(&js).await;
}

#[cfg(target_arch = "wasm32")]
async fn persist_read() -> Option<String> {
    let value = document::eval(&format!("return localStorage.getItem('{PERSIST_KEY}');"))
        .await
        .ok()?;
    match value {
        serde_json::Value::String(s) => Some(s),
        _ => None,
    }
}

/// Restore the persisted session once the engine is Ready: validate the stored
/// deck via deck_get; a stale id falls back to the newest deck in deck_list.
async fn restore_session(mut state: AppState, client: Arc<EngineClient>) {
    let stored: Option<serde_json::Value> = match persist_read().await {
        Some(raw) => serde_json::from_str(&raw).ok(),
        None => None,
    };
    if let Some(blob) = &stored {
        if let Some(snaps) = blob.get("snapshots").and_then(|v| v.as_array()) {
            let list: Vec<(String, u64)> = snaps
                .iter()
                .filter_map(|e| {
                    Some((
                        e.get(0)?.as_str()?.to_string(),
                        e.get(1)?.as_u64().unwrap_or(0),
                    ))
                })
                .collect();
            state.snapshots.set(list);
        }
        if let Some(id) = blob.get("deck_id").and_then(|v| v.as_str()) {
            if let Ok(got) = client.deck_get(id).await {
                state.active_deck_id.set(Some(got.deck.deck_id));
                state.active_deck_name.set(Some(got.deck.name));
                state.hydrated.set(true);
                return;
            }
        }
    }
    // Stale or absent: graceful fallback to the newest listed deck.
    if let Ok(listing) = client.deck_list().await {
        if let Some(deck) = listing.decks.last() {
            state.active_deck_id.set(Some(deck.deck_id.clone()));
            state.active_deck_name.set(Some(deck.name.clone()));
        }
    }
    state.hydrated.set(true);
}

/// Try to connect, then settle into Offline with the reason on failure.
/// Re-callable from the Retry button.
///
/// Native default: spawn the engine as a child and speak MCP over its
/// stdin/stdout (no TCP listener exists — think:168). The rmcp initialize
/// handshake doubles as the readiness wait, and dropping the client kills
/// the child. Dev-HTTP mode (`MTG_EDH_DEV_HTTP` / `MTG_EDH_MCP_URL`) keeps
/// the old attach-or-spawn HTTP flow; wasm is HTTP-only (a browser can't
/// spawn processes).
pub fn connect(state: AppState) {
    let mut conn = state.conn;
    let principal = (state.principal)();
    conn.set(ConnState::Connecting);
    spawn(async move {
        #[cfg(not(target_arch = "wasm32"))]
        if !dev_http_mode() {
            match stdio_client().await {
                Ok(client) => {
                    let client = Arc::new(client);
                    conn.set(ConnState::Ready(client.clone()));
                    restore_session(state, client).await;
                }
                Err(reason) => conn.set(ConnState::Offline(reason)),
            }
            return;
        }
        let url = engine_url();
        // First attempt: an engine may already be running (dev mode).
        if let Ok(client) = EngineClient::connect(&url, &principal).await {
            if probe(&client).await {
                let client = Arc::new(client);
                conn.set(ConnState::Ready(client.clone()));
                restore_session(state, client).await;
                return;
            }
            client.shutdown().await.ok();
        }
        // Sidecar: spawn the node engine, then retry with backoff (native only —
        // a browser build cannot spawn processes; it needs the engine already up).
        #[cfg(not(target_arch = "wasm32"))]
        {
            let spawned = spawn_sidecar();
            if spawned.is_ok() {
                for _ in 0..20 {
                    tokio::time::sleep(Duration::from_millis(300)).await;
                    if let Ok(client) = EngineClient::connect(&url, &principal).await {
                        if probe(&client).await {
                            conn.set(ConnState::Ready(Arc::new(client)));
                            return;
                        }
                        client.shutdown().await.ok();
                    }
                }
            }
            let reason = match spawned {
                Ok(()) => format!("engine did not answer at {url} after sidecar spawn"),
                Err(e) => format!("engine unreachable at {url}; {e}"),
            };
            conn.set(ConnState::Offline(reason));
        }
        #[cfg(target_arch = "wasm32")]
        conn.set(ConnState::Offline(format!(
            "engine unreachable at {url} — start it with MCP_TRANSPORT=http node dist/main.js"
        )));
    });
}

#[cfg(not(target_arch = "wasm32"))]
/// Spawn-and-handshake over stdio, with the probe round-trip as final proof.
async fn stdio_client() -> Result<EngineClient, String> {
    let cmd = engine_command()?;
    let client = EngineClient::connect_stdio(cmd)
        .await
        .map_err(|e| format!("engine failed to start over stdio: {e}"))?;
    if !probe(&client).await {
        client.shutdown().await.ok();
        return Err("engine started but the stdio probe round-trip failed".to_string());
    }
    Ok(client)
}

/// A cheap round-trip proving the wire actually works (POST + structured reply).
async fn probe(client: &EngineClient) -> bool {
    use mtg_edh_mcp_client::CardSearchParams;
    client
        .card_search(CardSearchParams {
            query: "t:creature".into(),
            limit: Some(1),
            ..Default::default()
        })
        .await
        .is_ok()
}
