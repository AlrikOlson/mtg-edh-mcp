# Install and run

The standalone server connects to a local MCP client over stdio. This repository
contains the MCP server and its development and verification tooling.

## Requirements

- **Node.js 24** is recommended. See [package.json](../package.json) for the
  supported Node version range.
- npm and Git.
- Network access for initial Scryfall ingestion; no API key is required.
- Several GB of free disk space for downloaded exports, the SQLite index, and
  retained versions. Download size and build time vary with the upstream data.

The server uses a native SQLite dependency (`better-sqlite3`). If a prebuilt
binary is unavailable for your Node version and platform, installation needs
Python and a C/C++ build toolchain.

## 1. Build the server

```sh
git clone https://github.com/AlrikOlson/mtg-edh-mcp.git
cd mtg-edh-mcp
npm ci
npm run build
node dist/main.js --help
```

This creates the server executable at `dist/main.js` and the one-shot data
ingestion command at `dist/ingest.js`.

## 2. Set up a data directory

Choose a writable, persistent directory. Use the **same absolute directory**
for setup, ingestion, diagnostics, and your MCP client's server configuration.

macOS / Linux:

```sh
export MCP_DATA_DIR="$HOME/.mtg-edh-mcp/cards"
node dist/main.js setup
node dist/main.js doctor
```

PowerShell:

```powershell
$env:MCP_DATA_DIR = Join-Path $env:USERPROFILE ".mtg-edh-mcp/cards"
node dist/main.js setup
node dist/main.js doctor
```

An installed executable accepts `mtg-edh-mcp setup` and `mtg-edh-mcp doctor`.
Setup initializes local user storage and prints JSON containing a client
configuration with absolute Node, executable, and data paths. Copy that entry
into your client's configuration, preserving its other entries. Setup is safe
to rerun; it preserves saved decks and collections and does not download card
data or edit client configuration files.

Doctor prints read-only JSON diagnostics for the supported Node runtime,
native SQLite, resolved paths, permissions, index readiness, and freshness.
It does not initialize storage, download data, or repair files. Exit codes are
`0` for ready and fresh, `2` for setup/ingestion/refresh needed, and `1` for
a runtime, permission, or damaged-data problem. Follow each reported fix.
On a new directory, exit `2` is expected until card ingestion succeeds.
Database validation uses detached in-memory copies. If SQLite has pending
journal data, doctor asks you to stop the server cleanly and rerun; it never
checkpoints or repairs the live database. Allow enough memory for the index
copy when running these diagnostics.

### Download card data

You can connect a client immediately and use the
[first-run flow](#starting-without-an-index), or download from the terminal:

macOS / Linux:

```sh
MCP_DATA_DIR="$HOME/.mtg-edh-mcp/cards" npm run ingest
```

PowerShell:

```powershell
$env:MCP_DATA_DIR = Join-Path $env:USERPROFILE ".mtg-edh-mcp/cards"
npm run ingest
```

Wait for the command to print `Done:` with the card and printing counts. It
downloads Scryfall's Oracle and default-card exports, then builds a local
SQLite index. Progress is reported by phase; the build may be quiet while
processing data.

To keep data inside your checkout instead, `npm run ingest` without an
override uses `data/cards/` relative to the current working directory. That
relative default is convenient in a terminal but can resolve somewhere else
when a desktop client starts the server.

## 3. Connect an MCP client

For clients using an `mcpServers` JSON configuration, add:

```json
{
  "mcpServers": {
    "mtg-edh": {
      "command": "node",
      "args": ["/absolute/path/to/mtg-edh-mcp/dist/main.js"],
      "env": {
        "MCP_DATA_DIR": "/absolute/path/to/your/home/.mtg-edh-mcp/cards"
      }
    }
  }
}
```

For Windows, use absolute Windows paths with escaped backslashes, for example
`"C:\\Users\\you\\Code\\mtg-edh-mcp\\dist\\main.js"`.

Replace the example paths with your actual paths. JSON values do not expand
`~`, `$HOME`, or `$env:USERPROFILE`. Keep any existing server entries in your
client configuration. Restart the client after saving.

The process speaks MCP on stdout and writes diagnostics to stderr. It is
normal for `node dist/main.js` to sit waiting in a terminal; it expects an MCP
client, not interactive commands. Avoid wrappers that print banners to stdout.

## 4. Verify the connection

Ask your assistant to:

1. Call `ping`, then `data_status`. Expect `has_index: true`.
2. Call `card_get` with `{"cards":"Sol Ring"}`.
3. Create a deck, set its commander, and call `deck_status`.
4. Restart the server and use `deck_list` to confirm the deck persists.

When the index is loaded, `tools/list` includes 41 tools and `prompts/list`
includes `build_commander_deck`, `tune_deck`, and `fit_budget`.

### Starting without an index

The server can start without card data, but card search, validation, analysis,
collection tools, and workflow prompts will be unavailable. `data_status` and
`data_ingest` remain available for onboarding.

Call `data_ingest`, then poll `data_status`. Progress reports download/build
phases rather than a percentage. When `ingest.phase` is `done` and
`has_index: true`, call `tools/list` again and use `card_search`. The same
stdio connection or running HTTP server now serves the index, full tool catalog,
card and collection resources, and workflow prompts. No restart or reconnect
is required. stdio clients receive catalog-change notifications; stateless
HTTP clients discover the new catalog by requesting it again.

If `ingest.phase` is `error`, follow the reported fix and call `data_ingest`
again. An interrupted first download is also retryable after restarting the
terminated process: incomplete attempts are retained, and each retry uses a
new staging directory. No manual lock or partial-file cleanup is needed.

## Configuration

| Variable               | Default      | Purpose                                                                        |
| ---------------------- | ------------ | ------------------------------------------------------------------------------ |
| `MCP_DATA_DIR`         | `data/cards` | Card snapshots, user-data SQLite and backups; use an absolute path in clients. |
| `MCP_TRANSPORT`        | `stdio`      | Set to `http` for trusted local HTTP clients.                                  |
| `MCP_HTTP_HOST`        | `127.0.0.1`  | HTTP bind address.                                                             |
| `MCP_HTTP_PORT`        | `3000`       | HTTP port.                                                                     |
| `MCP_AUTO_REFRESH`     | enabled      | `0` or `false` disables background refresh.                                    |
| `MCP_BULK_INTERVAL_MS` | `43200000`   | Background bulk-data freshness check interval, in milliseconds (12 hours).     |

`MCP_PRICE_INTERVAL_MS` is accepted by the freshness configuration, but does
not schedule a separate price refresh. Normal bulk updates refresh pricing
along with card data.

For a predictable offline session, ingest first and set `MCP_AUTO_REFRESH=0`.
Use the local tools; `data_ingest` and community enrichment still make network
requests when called.

### Local Streamable HTTP

```sh
MCP_DATA_DIR="$HOME/.mtg-edh-mcp/cards" node dist/main.js --http
```

Connect an MCP Streamable HTTP client to `http://127.0.0.1:3000/mcp`. This is
a stateless POST transport; it does not provide a long-lived GET event stream.

HTTP has **no authentication**. Keep it on loopback for trusted clients. The
optional `x-mcp-principal` header selects a deck and collection namespace and
can be supplied by any caller. It is not an authorization mechanism. Public
hosting requires a separately designed authentication and authorization
boundary; see [Security](../SECURITY.md).

### Protocol compatibility

The server uses the stable [TypeScript SDK v2.0.0](https://ts.sdk.modelcontextprotocol.io/v2/).
Both stdio and HTTP accept the **2026-07-28** protocol and legacy initialization.
Regression checks include 2024-11-05 clients and an actual Rust rmcp 3.2.0 client
negotiating 2025-11-25. Your existing launch configuration is unchanged.

The indexed catalog remains 41 tools and three prompts. Tool results carry
`structuredContent` and an equivalent JSON text block for clients that consume
only text. Tools continue to omit advertised `outputSchema` to preserve the
existing catalog contract; this migration does not re-enable previously removed
output declarations.

Persistent stdio can deliver catalog and deck-resource notifications. Local
HTTP does not advertise change notifications or subscriptions; re-list tools
and re-read resources to see changes. An HTTP `subscriptions/listen` request
is rejected rather than opening a stream that cannot receive updates.

SDK client authors must [opt into modern negotiation](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions.html),
using automatic negotiation or a 2026-07-28 pin. Merely upgrading the SDK retains
its legacy default. The server selects the protocol from the client's opening
exchange. Protocol tests are automated; separate model-driven host evaluation
remains a release acceptance step.

## Updates and storage

The background scheduler checks Scryfall freshness at startup and periodically.
Servers activate the first successful index and later refreshes together with
their `data_snapshot` before ingestion reports `done`. In-flight tool
calls finish on their original snapshot; new calls briefly wait during activation.
`data_status` and the scheduler measure the data this process actually serves.

For a manual update, call `data_ingest` through your client. Alternatively,
stop the server and run the ingestion command again with the same data
directory. Add `-- --force` to `npm run ingest` to force another download.
Unchanged upstream data reuses a validated index without downloading or rebuilding it.
An incomplete legacy index causes a fresh version to be built instead.

| Data                                | Location and lifetime                                                                   |
| ----------------------------------- | --------------------------------------------------------------------------------------- |
| Card exports and SQLite index       | Versioned directories under `MCP_DATA_DIR`.                                             |
| Decks, snapshots and role overrides | `MCP_DATA_DIR/user-data.sqlite`; committed before successful mutation responses.        |
| Owned-card collections              | The same user-data database, scoped by principal; membership, not inventory quantities. |
| User-data backups                   | `MCP_DATA_DIR/backups/`; automatic snapshots taken before mutations.                    |

Multiple local processes running this version can share one data directory.
Each mutation reads the latest committed state and writes in one SQLite
transaction. Deck tools check `expected_version` inside that transaction;
a stale version returns `conflict: true` without changing data. Reads in other
processes see committed changes. Resource notifications remain local to the
process that made the change; another client can re-read to see changes.

stdio uses the `local` namespace; HTTP uses `x-mcp-principal` (or `local`
when omitted). Use the same directory and namespace to recover your data.
These namespaces are isolation boundaries for trusted local clients, not
authentication. Embedded library callers must pass the persistent
`UserDataStore.deckStore` and `.collection`; default in-memory stores remain
available for tests and ephemeral use.

Stop **all older server versions** before upgrading. The first new startup
validates and imports `decks.json` exactly once, including snapshots and their
session keys. It preserves the original file and an exact copy at
`decks.json.migrated`.
An invalid legacy file stops startup with recovery guidance; it is never
quietly discarded. After migration, SQLite is authoritative: editing the old
JSON file does not update the database. Do not run old and new versions against
the same directory.

Successful deck, snapshot and collection mutations need no shutdown flush.
A storage or backup failure returns `STORAGE_ERROR` and rolls back the call;
check available disk space, permissions and lock contention before retrying.
If the connection dies before a response arrives, the commit may already have
completed. Re-read state before retrying non-idempotent operations.
The stored optional per-deck `role_overrides` payload survives snapshots and
restarts; role-correction tools and analysis behavior are delivered separately.

### User-data backup and restore

Before a transaction first changes user data, the server writes a complete
backup of the previous committed state. It keeps the five newest automatic
backups. A failed backup prevents the mutation. **The latest backup can be one
successful mutation behind the live database.** A restore deliberately returns
all principals' decks, snapshots and collections to the selected backup's
state; it is not a merge or a guarantee of recovering later changes.

Copy backups to another device for protection against disk loss. For a backup
of the exact current state, stop all servers and copy the whole data directory,
including any SQLite journal files. Automatic user-data backups do not contain
card exports or indexes. Retained card generations follow the separate policy
below.

Corrupted user storage stops startup. To restore a known backup:

1. Stop every server using that data directory, including client-launched stdio
   processes. Keep a copy of the damaged directory.
2. Choose the explicit backup you want from `backups/`. Run, replacing both
   paths with your actual paths:

   ```sh
   MCP_DATA_DIR="/absolute/path/to/data" node dist/main.js restore-user-data "/absolute/path/to/data/backups/user-data-<timestamp>-<uuid>.sqlite"
   ```

   In PowerShell, set `$env:MCP_DATA_DIR` first, then run the same `node` command.
   An installed executable also accepts `mtg-edh-mcp restore-user-data <backup-path>`.

3. The command validates the backup, refuses to replace data while a server
   holds the storage lock, and preserves the replaced database for inspection.
   It prints the restored and preserved paths; an error exits nonzero.
4. Restart and verify `deck_list`, `deck_get`, snapshot history, and
   `collection_get` in each relevant namespace. Keep the damaged copy until
   you have checked the restored state.

Keep `user-data.initialized`: it prevents a missing database from being
mistaken for a first run. Never delete `user-data-lock.sqlite` to bypass a live
server's lock. Keep both files when copying the data directory. Use a
local filesystem with working SQLite locks and atomic rename. Tests exercise
real process kills, concurrent writers, injected failures and corruption
recovery. They do not establish power-loss or network-filesystem guarantees.

To update the source installation, stop the servers, preserve a backup, pull
the desired revision, run `npm ci` and `npm run build`, then restart.

### Card refresh recovery

Each refresh stages both Scryfall exports, a manifest, and `index.sqlite` under
a new `versions/<timestamp>-<uuid>/` directory. Only after export sizes, SQLite
integrity, query statements, and nonempty cards/printings validate does an atomic
rename publish `current.json`. The pointer records `version` and the last
validated `previous` version. Downloads and manifests are flushed before
publication. A failed download, build, or activation preparation keeps the
previous pointer and served index intact.

A separate `.refresh-lock.sqlite` serializes the entire operation, including
CLI and server refreshes. A competing run reports an error in `data_status`;
retry after the owner finishes. Process termination releases the lock
automatically. **Do not delete the lock database to unlock a running refresh.**

On restart, the server validates the version named by the pointer and pairs it
with that version's manifest. If it is unusable, the server tries only the
explicit `previous` version. It never promotes an abandoned directory based
on its timestamp. When neither version is usable, card tools remain unavailable;
retry ingestion to build a fresh snapshot.

Old and interrupted directories are intentionally retained. A retry uses a new
directory and needs no manual cleanup. Allow enough disk space for the old
snapshot, replacement exports/index, and retained attempts. To reclaim space,
stop **all** processes using the directory, back up `current.json` and both
versions it references, then remove only other version directories and abandoned
`current.json.*.tmp` files. Never remove user-data databases, `user-data.initialized`, lock/journal files, legacy JSON or backups as part of card cleanup.

For a manual rollback, stop all processes, back up the full data directory, and
replace `current.json` with `{"version":"<known-good-version-id>"}` naming a
complete retained version. Restart with `MCP_AUTO_REFRESH=0` and verify
`data_status`, `card_search`, and the response's `data_snapshot` before
enabling refresh again. Keep the backup until verification succeeds.

Use a local filesystem that supports SQLite locking and atomic same-directory
rename. Tests kill real refresh processes after download, during a build,
before publication, and after publication, then verify complete startup reads
and unchanged previous files. These checks establish process-crash recovery;
they do not establish power-loss guarantees on every filesystem or network drive.
There is no automatic garbage collection or coordination with older server
versions that still use the old publication path; stop those before upgrading.

## Troubleshooting

| Symptom                                         | Check                                                                                                                                      |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `node` not found in the client                  | Use an absolute Node executable path. On macOS / Linux, `command -v node` prints it. GUI applications may not inherit your shell's PATH.   |
| Missing card tools or `has_index: false`        | Run `doctor`, confirm `data_status` reports readiness and the same absolute `MCP_DATA_DIR`, then request `tools/list` again.               |
| SQLite native-module installation or ABI error  | Use Node 24 and run `npm ci` again after changing Node versions. Install a native build toolchain if your platform has no prebuilt binary. |
| Download failure                                | Check network access, writable storage, and free disk space; retry ingestion and inspect stderr for the upstream error.                    |
| A deck disappears after restarting              | Verify the data directory and principal namespace; inspect `STORAGE_ERROR` guidance and the user-data restore procedure above.             |
| Community recommendations or combos unavailable | Check the tool's upstream error. Local search, validation, and analysis remain available.                                                  |
| HTTP port already in use                        | Choose another `MCP_HTTP_PORT` or stop the existing server.                                                                                |

For unresolved issues, include your OS, Node version, project revision,
transport, reproduction steps, and redacted stderr in a
[bug report](https://github.com/AlrikOlson/mtg-edh-mcp/issues/new?template=bug_report.md).
