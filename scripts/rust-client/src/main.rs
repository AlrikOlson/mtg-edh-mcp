//! Cross-language acceptance against the built production stdio entrypoint.
use std::{path::Path, process::Stdio, time::Duration};

use anyhow::{Context, Result, bail, ensure};
use rmcp::{
    ServiceExt,
    model::{CallToolRequestParams, CallToolResult},
    service::{RoleClient, RunningService},
};
use serde_json::{Value, json};
use tokio::{
    process::{Child, Command},
    time::{sleep, timeout},
};

const DEADLINE: Duration = Duration::from_secs(15);
const ORACLE_ID: &str = "00000000-0000-4000-8000-000000000001";

struct Server {
    client: RunningService<RoleClient, ()>,
    child: Child,
}

impl Server {
    async fn connect(data_root: &Path) -> Result<Self> {
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
        let checkout = manifest
            .parent()
            .context("scripts directory")?
            .parent()
            .context("checkout")?;
        let entry = checkout.join("dist/main.js");
        ensure!(entry.is_file(), "Build the server first: npm run build");
        let mut child = Command::new(std::env::var_os("NODE").unwrap_or_else(|| "node".into()))
            .arg("--import")
            .arg(manifest.join("offline-scryfall.mjs"))
            .arg(entry)
            .arg("--stdio")
            .current_dir(data_root)
            .env("MCP_DATA_DIR", data_root)
            .env("MCP_TRANSPORT", "stdio")
            .env("MCP_AUTO_REFRESH", "0")
            .env("MCP_WATCH_STDIN", "0")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .context("spawn built Node server")?;
        let stdout = child.stdout.take().context("piped server stdout")?;
        let stdin = child.stdin.take().context("piped server stdin")?;
        // rmcp performs the actual initialization and typed JSON-RPC transport.
        // Keep Child separately so the durability test can kill without a flush.
        let client = timeout(DEADLINE, ().serve((stdout, stdin)))
            .await
            .context("MCP initialize timed out")??;
        let info = client
            .peer_info()
            .context("initialize server information")?;
        ensure!(
            info.server_info
                .as_ref()
                .is_some_and(|server| server.name == "mtg-edh-mcp"),
            "unexpected server: {info:?}"
        );
        println!(
            "rmcp 3.2.0 connected; negotiated MCP {}",
            info.protocol_version
        );
        Ok(Self { client, child })
    }

    async fn raw_call(&self, name: &'static str, args: Value) -> Result<CallToolResult> {
        let request = CallToolRequestParams::new(name)
            .with_arguments(args.as_object().context("object arguments")?.clone());
        timeout(DEADLINE, self.client.call_tool(request))
            .await
            .with_context(|| format!("{name} timed out"))?
            .with_context(|| format!("{name} protocol request failed"))
    }

    async fn call(&self, name: &'static str, args: Value) -> Result<Value> {
        let result = self.raw_call(name, args).await?;
        ensure!(
            result.is_error != Some(true),
            "{name} tool error: {result:?}"
        );
        let value = result
            .structured_content
            .context(format!("{name} structuredContent missing"))?;
        ensure!(
            result.content.iter().any(|block| {
                block.as_text().is_some_and(|text| {
                    serde_json::from_str::<Value>(&text.text).ok().as_ref() == Some(&value)
                })
            }),
            "{name} lacks a JSON text block equivalent to structuredContent"
        );
        Ok(value)
    }

    async fn require_tools(&self, names: &[&str]) -> Result<()> {
        let tools = timeout(DEADLINE, self.client.list_all_tools()).await??;
        for name in names {
            ensure!(
                tools.iter().any(|tool| tool.name == *name),
                "missing tool: {name}"
            );
        }
        Ok(())
    }

    async fn ingest(&self) -> Result<()> {
        let started = self.call("data_ingest", json!({})).await?;
        ensure!(
            started["started"] == true,
            "ingest did not start: {started}"
        );
        timeout(DEADLINE, async {
            loop {
                let status = self.call("data_status", json!({})).await?;
                match status["ingest"]["phase"].as_str() {
                    Some("done") => {
                        ensure!(
                            status["has_index"] == true,
                            "ingestion did not activate index"
                        );
                        return Ok(());
                    }
                    Some("error") => bail!("ingestion failed: {status}"),
                    _ => sleep(Duration::from_millis(20)).await,
                }
            }
        })
        .await
        .context("fixture ingestion timed out")?
    }

    async fn kill(mut self) -> Result<()> {
        // Child::kill sends SIGKILL on Unix / TerminateProcess on Windows and
        // waits for exit; it never asks the MCP server to save on shutdown.
        timeout(DEADLINE, self.child.kill())
            .await
            .context("server kill timed out")??;
        timeout(DEADLINE, self.client.waiting())
            .await
            .context("rmcp did not observe killed server")??;
        Ok(())
    }

    async fn close(mut self) -> Result<()> {
        timeout(DEADLINE, self.client.cancel())
            .await
            .context("MCP close timed out")??;
        let status = timeout(DEADLINE, self.child.wait())
            .await
            .context("server exit timed out")??;
        ensure!(status.success(), "server failed on normal close: {status}");
        Ok(())
    }
}

async fn acceptance() -> Result<()> {
    let root = tempfile::tempdir().context("empty data directory")?;
    ensure!(
        root.path().read_dir()?.next().is_none(),
        "first run must start empty"
    );
    let first = Server::connect(root.path()).await?;
    first
        .require_tools(&[
            "ping",
            "data_status",
            "data_ingest",
            "deck_create",
            "deck_get",
        ])
        .await?;
    first.call("ping", json!({})).await?;
    let status = first.call("data_status", json!({})).await?;
    ensure!(
        status["has_index"] == false,
        "first run already had an index"
    );
    let created = first
        .call("deck_create", json!({"name": "Rust durable deck"}))
        .await?;
    let deck_id = created["deck_id"]
        .as_str()
        .context("created deck id")?
        .to_owned();

    first.ingest().await?;
    first
        .require_tools(&[
            "card_search",
            "deck_add",
            "collection_add",
            "collection_get",
        ])
        .await?;
    first
        .call(
            "deck_add",
            json!({"deck_id": deck_id, "cards": "Rust Acceptance Artifact"}),
        )
        .await?;
    let deck = first.call("deck_get", json!({"deck_id": deck_id})).await?;
    ensure!(
        deck["deck"]["cards"][0]["oracle_id"] == ORACLE_ID,
        "deck add was not applied: {deck}"
    );
    let version = deck["deck"]["version"].as_u64().context("deck version")?;
    let owned = first
        .call(
            "collection_add",
            json!({"cards": "Rust Acceptance Artifact"}),
        )
        .await?;
    ensure!(
        owned["total"] == 1 && owned["owned"] == json!([ORACLE_ID]),
        "collection add was not applied: {owned}"
    );
    ensure!(
        owned["unresolved"] == json!([]),
        "fixture card did not resolve"
    );
    first.kill().await?;

    let restarted = Server::connect(root.path()).await?;
    let restored = restarted
        .call("deck_get", json!({"deck_id": deck_id}))
        .await?;
    ensure!(
        restored["deck"] == deck["deck"],
        "acknowledged deck changed after immediate kill"
    );
    let restored_owned = restarted.call("collection_get", json!({})).await?;
    ensure!(
        restored_owned["total"] == 1 && restored_owned["owned"] == json!([ORACLE_ID]),
        "acknowledged collection changed after immediate kill: {restored_owned}"
    );
    let conflict = restarted
        .call(
            "deck_rename",
            json!({
                "deck_id": deck_id, "name": "Must not persist", "expected_version": version + 1
            }),
        )
        .await?;
    ensure!(
        conflict["conflict"] == true,
        "stale mutation was accepted: {conflict}"
    );
    ensure!(
        restarted
            .call("deck_get", json!({"deck_id": deck_id}))
            .await?["deck"]
            == deck["deck"],
        "conflicting mutation changed saved deck"
    );
    restarted.close().await?;

    // Stdio always uses the local principal; a separate MCP_DATA_DIR is its
    // isolation boundary. Verify both a known deck ID and collection membership.
    let other_root = tempfile::tempdir()?;
    let isolated = Server::connect(other_root.path()).await?;
    ensure!(
        isolated.call("deck_list", json!({})).await?["total"] == 0,
        "decks leaked across data directories"
    );
    let missing = isolated
        .raw_call("deck_get", json!({"deck_id": deck_id}))
        .await?;
    ensure!(
        missing.is_error == Some(true),
        "another data directory can read saved deck"
    );
    isolated.ingest().await?;
    ensure!(
        isolated.call("collection_get", json!({})).await?["total"] == 0,
        "collection leaked across data directories"
    );
    isolated.close().await?;
    println!(
        "PASS: rmcp initialize/discovery/calls, offline first-run ingest, structured/text parity, acknowledged deck+collection durability after kill/reconnect, version conflict, data-directory isolation"
    );
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    timeout(Duration::from_secs(90), acceptance())
        .await
        .context("Rust acceptance exceeded 90 seconds")?
}
