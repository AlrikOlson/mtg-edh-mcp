//! Signals app-state: the EngineClient handle, connection lifecycle, and the
//! active deck/session. Provided via context from the app root.
//!
//! Connection flow (ADR 0001 "dev" + "sidecar" modes): try the configured URL;
//! if unreachable, optionally spawn the node engine as a sidecar child
//! (`MCP_TRANSPORT=http node dist/main.js`) and retry with backoff. Every
//! failure lands in an explicit Offline state with a Retry affordance —
//! mirroring the engine's graceful-degradation ethos.

use dioxus::prelude::*;
use mtg_edh_mcp_client::EngineClient;
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
/// Spawn the engine sidecar. Bundled mode first (SEA binary + piped stdin so
/// the engine exits when we die — MCP_WATCH_STDIN); dev-checkout node fallback.
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
    });
    use_effect(move || {
        connect(state);
    });
    state
}

pub fn use_app_state() -> AppState {
    use_context::<AppState>()
}

/// Try to connect; on failure spawn the sidecar once and retry briefly, then
/// settle into Offline with the reason. Re-callable from the Retry button.
pub fn connect(state: AppState) {
    let mut conn = state.conn;
    let principal = (state.principal)();
    conn.set(ConnState::Connecting);
    spawn(async move {
        let url = engine_url();
        // First attempt: an engine may already be running (dev mode).
        if let Ok(client) = EngineClient::connect(&url, &principal).await {
            if probe(&client).await {
                conn.set(ConnState::Ready(Arc::new(client)));
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
