/**
 * stdio transport (spec §2) — for local/desktop MCP clients.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, type CreateServerOptions } from "./createServer.js";

/** Create a server and connect it to stdio. Resolves once connected. */
export async function startStdio(options: CreateServerOptions = {}): Promise<void> {
  const server = createServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
