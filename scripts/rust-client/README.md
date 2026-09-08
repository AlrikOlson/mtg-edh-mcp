# Rust MCP acceptance client

From the repository root, run:

```sh
npm run test:rust
```

This builds the production server, then runs the locked Rust client against
`dist/main.js --stdio`. It requires the project's supported Node.js version and
Rust/Cargo 1.88 or newer. Cargo downloads dependencies on the first run; the MCP
scenario itself makes no external requests. Set `NODE` to an alternate Node
executable if needed.

The client pins the official [`rmcp` 3.2.0 SDK](https://docs.rs/rmcp/3.2.0/rmcp/)
and commits `Cargo.lock`. It uses rmcp's supported
[`(AsyncRead, AsyncWrite)` transport](https://docs.rs/rmcp/3.2.0/rmcp/#transports)
over a real child process's stdout/stdin. The Rust client performs initialization,
tool discovery, every tool call, result decoding, and assertions. It prints the
negotiated protocol version so an SDK fallback is visible.

The executable verifies:

- Initialization and tool discovery from an empty temporary `MCP_DATA_DIR`.
- Successful calls with equivalent structured and JSON text result bodies.
- First-run ingestion and activation of indexed tools on the same connection.
- Deck creation, card addition, and owned collection updates through MCP.
- Immediate process termination after acknowledged writes, followed by a new
  process and rmcp connection that recover the same deck and collection.
- Rejection of a conflicting deck version without changing persisted contents.
- Isolation of both the known deck ID and collection in a second data directory.

`offline-scryfall.mjs` is a test-only Node preload replacing upstream `fetch`
responses with one synthetic card. It does not replace the MCP transport,
production bootstrap, ingestion pipeline, index, or transactional user store.
Unexpected HTTP requests fail. Stdio's isolation check covers independent data
directories; principal isolation on HTTP is covered by the server tests.

For an already-built server, the direct command is:

```sh
cargo run --locked --manifest-path scripts/rust-client/Cargo.toml
```

Each operation has a deadline, the scenario has a 90-second deadline, and child
processes are killed on early failure. Successful runs close their children and
remove temporary data directories. Rust formatting can be checked with
`cargo fmt --manifest-path scripts/rust-client/Cargo.toml --check`.
