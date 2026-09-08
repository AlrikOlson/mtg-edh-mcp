/** Parse startup configuration before touching disk, networking, or background timers. */
export type CliOptions =
  | { mode: "help" }
  | { mode: "version" }
  | { mode: "setup" }
  | { mode: "doctor" }
  | { mode: "restore-user-data"; backupPath: string }
  | { mode: "serve"; transport: "stdio" | "http"; port: number; host: string };

export function parseCli(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): CliOptions {
  if (argv.includes("--help") || argv.includes("-h")) return { mode: "help" };
  if (argv.includes("--version") || argv.includes("-v")) return { mode: "version" };
  if (argv[0] === "setup" || argv[0] === "doctor") {
    if (argv.length !== 1) throw new Error(`Usage: mtg-edh-mcp ${argv[0]}`);
    if (env.MCP_DATA_DIR !== undefined && env.MCP_DATA_DIR.trim() === "") {
      throw new Error("MCP_DATA_DIR must be a non-empty directory path.");
    }
    return { mode: argv[0] };
  }
  if (argv[0] === "restore-user-data") {
    if (argv.length !== 2 || !argv[1]?.trim() || argv[1].startsWith("-")) {
      throw new Error(
        "Usage: mtg-edh-mcp restore-user-data <backup-path>. Stop all servers first.",
      );
    }
    if (env.MCP_DATA_DIR !== undefined && env.MCP_DATA_DIR.trim() === "") {
      throw new Error("MCP_DATA_DIR must be a non-empty directory path.");
    }
    return { mode: "restore-user-data", backupPath: argv[1] };
  }
  for (const arg of argv) {
    if (arg !== "--http" && arg !== "--stdio") {
      throw new Error(`Unknown argument: ${arg}. Run mtg-edh-mcp --help for usage.`);
    }
  }
  if (argv.includes("--http") && argv.includes("--stdio")) {
    throw new Error("Choose either --http or --stdio.");
  }
  const transport = argv.includes("--http")
    ? "http"
    : argv.includes("--stdio")
      ? "stdio"
      : (env.MCP_TRANSPORT ?? "stdio");
  if (transport !== "http" && transport !== "stdio") {
    throw new Error("MCP_TRANSPORT must be stdio or http.");
  }
  if (env.MCP_DATA_DIR !== undefined && env.MCP_DATA_DIR.trim() === "") {
    throw new Error("MCP_DATA_DIR must be a non-empty directory path.");
  }
  let port = 3000;
  let host = "127.0.0.1";
  if (transport === "http") {
    const rawPort = env.MCP_HTTP_PORT ?? "3000";
    if (!/^\d+$/.test(rawPort) || Number(rawPort) > 65535) {
      throw new Error("MCP_HTTP_PORT must be an integer between 0 and 65535.");
    }
    port = Number(rawPort);
    host = env.MCP_HTTP_HOST ?? host;
    if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
      throw new Error("MCP_HTTP_HOST must be a loopback address (localhost, 127.0.0.1, or ::1).");
    }
  }
  return { mode: "serve", transport, port, host };
}

export const CLI_HELP = `mtg-edh-mcp — Commander deckbuilding for MCP clients

Usage: mtg-edh-mcp [--stdio | --http]
       mtg-edh-mcp --help
       mtg-edh-mcp --version
       mtg-edh-mcp setup
       mtg-edh-mcp doctor
       mtg-edh-mcp restore-user-data <backup-path>

Options:
  --stdio       Serve MCP on stdin/stdout (default)
  --http        Serve Streamable HTTP locally at /mcp
  -h, --help    Show this help and exit
  -v, --version Show the package version and exit

Environment:
  MCP_DATA_DIR           Card database, decks and collections (default: data/cards)
                         Use the same absolute path for ingestion and serving.
  MCP_TRANSPORT          stdio or http; command-line flags take precedence
  MCP_HTTP_HOST          Loopback host (default: 127.0.0.1)
  MCP_HTTP_PORT          HTTP port (default: 3000; 0 chooses a free port)
  MCP_AUTO_REFRESH       Set to 0 to disable automatic bulk refresh

Recovery:
  Stop all servers using MCP_DATA_DIR, then run restore-user-data with an explicit
  backup from its backups directory. Replaces user data and preserves the old DB.
  See the guide for backup age, migration and recovery details.

First run:
  npm ci
  npm run build
  MCP_DATA_DIR=/absolute/path/to/data node dist/main.js setup
  Add the emitted clientConfig to your MCP client, then call data_ingest.
  Alternatively: MCP_DATA_DIR=/absolute/path/to/data npm run ingest

Diagnostics:
  setup initializes durable storage without downloading card data and prints
  client configuration JSON. Existing data and client settings are preserved.
  doctor prints a read-only JSON report; it never downloads, migrates or repairs.
  Doctor exit codes: 0 ready, 2 action needed (setup/ingest/refresh), 1 broken.

Start this process from your MCP client's configuration. Server diagnostics go
to stderr; stdout is reserved for MCP messages. HTTP is unauthenticated and
intended for trusted local clients.

Guide: https://github.com/AlrikOlson/mtg-edh-mcp/blob/main/docs/INSTALL.md
`;
