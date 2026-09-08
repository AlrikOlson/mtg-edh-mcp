/**
 * stdio transport (spec §2) — for local/desktop MCP clients.
 */
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer, type CreateServerOptions } from "./createServer.js";

/** Serve both protocol eras; the first exchange pins one server per connection. */
export async function startStdio(options: CreateServerOptions = {}): Promise<void> {
  serveStdio(() => createServer(options));
}
