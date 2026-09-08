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

## 2. Download card data

Choose a writable, persistent directory. Use the **same absolute directory**
for ingestion and for your MCP client's server configuration.

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

Call `data_ingest`, then poll `data_status` until `ingest.phase` is `done` or
`error`. After the **first-ever** ingest, restart the server process so it
opens the new index and registers the full tool catalog. Reconnecting to an
already running HTTP process is not sufficient.

## Configuration

| Variable               | Default      | Purpose                                                                    |
| ---------------------- | ------------ | -------------------------------------------------------------------------- |
| `MCP_DATA_DIR`         | `data/cards` | Card snapshots and `decks.json`; use an absolute path in clients.          |
| `MCP_TRANSPORT`        | `stdio`      | Set to `http` for trusted local HTTP clients.                              |
| `MCP_HTTP_HOST`        | `127.0.0.1`  | HTTP bind address.                                                         |
| `MCP_HTTP_PORT`        | `3000`       | HTTP port.                                                                 |
| `MCP_AUTO_REFRESH`     | enabled      | `0` or `false` disables background refresh.                                |
| `MCP_BULK_INTERVAL_MS` | `43200000`   | Background bulk-data freshness check interval, in milliseconds (12 hours). |

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

## Updates and storage

The background scheduler checks Scryfall freshness at startup and periodically.
Servers that started with an index activate a successfully refreshed index and
its `data_snapshot` together before ingestion reports `done`. In-flight tool
calls finish on their original snapshot; new calls briefly wait during activation.
`data_status` and the scheduler measure the data this process actually serves.
A server with no index still needs a restart after its first successful ingest.

For a manual update, call `data_ingest` through your client. Alternatively,
stop the server and run the ingestion command again with the same data
directory. Add `-- --force` to `npm run ingest` to force another download.
Unchanged upstream data reuses a validated index without downloading or rebuilding it.
An incomplete legacy index causes a fresh version to be built instead.

| Data                          | Location and lifetime                                                                    |
| ----------------------------- | ---------------------------------------------------------------------------------------- |
| Card exports and SQLite index | Versioned directories under `MCP_DATA_DIR`.                                              |
| Decks and snapshots           | `MCP_DATA_DIR/decks.json`; persists across restarts and card updates.                    |
| Owned-card collection         | Process memory; re-import after restarting. Stores membership, not inventory quantities. |

Run **one server process per data directory**. Separate stdio client launches
are separate processes and should use separate directories; use one local
HTTP process if trusted clients need to share live state. Namespace headers
do not coordinate deck writes. Card refreshes now have a cross-process lock,
but deck and collection persistence still require the single-server arrangement.

For a backup, stop the server and copy `decks.json` somewhere safe. Preserve
the whole data directory if you also want the exact card snapshots. Deck writes
are briefly batched, so allow the process to shut down normally. If a deck
file cannot be loaded, it is set aside as `decks.json.corrupt`; inspect the
server's stderr and restore a known-good backup.

To update the source installation, stop the server, pull the desired revision,
run `npm ci` and `npm run build`, then restart it. Back up your decks before
updating a pre-1.0 installation.

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
`current.json.*.tmp` files. Never remove `decks.json` as part of card cleanup.

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
| Missing card tools or `has_index: false`        | Confirm ingestion finished and both processes use the same absolute `MCP_DATA_DIR`; restart the server after its first ingest.             |
| SQLite native-module installation or ABI error  | Use Node 24 and run `npm ci` again after changing Node versions. Install a native build toolchain if your platform has no prebuilt binary. |
| Download failure                                | Check network access, writable storage, and free disk space; retry ingestion and inspect stderr for the upstream error.                    |
| A deck disappears after restarting              | Verify the data-directory path and write permissions. Inspect stderr for persistence errors and look for `decks.json.corrupt`.             |
| Community recommendations or combos unavailable | Check the tool's upstream error. Local search, validation, and analysis remain available.                                                  |
| HTTP port already in use                        | Choose another `MCP_HTTP_PORT` or stop the existing server.                                                                                |

For unresolved issues, include your OS, Node version, project revision,
transport, reproduction steps, and redacted stderr in a
[bug report](https://github.com/AlrikOlson/mtg-edh-mcp/issues/new?template=bug_report.md).
