/**
 * Streamable HTTP transport (spec §2) — for hosted MCP clients.
 *
 * Stateless mode (`sessionIdGenerator: undefined`): a fresh server + transport
 * is created per POST, so there is no cross-request session state. Per-principal
 * deck-session scoping is a separate concern handled in p7-multitenancy; bulk
 * card data is shared and read-only (§2/§11).
 */
import http from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, type CreateServerOptions } from "./createServer.js";

export interface HttpServerOptions extends CreateServerOptions {
  /** Port to bind; 0 (default) picks an ephemeral free port. */
  port?: number;
  /** Host/interface to bind; defaults to loopback. */
  host?: string;
}

export interface RunningHttpServer {
  server: http.Server;
  /** The actually-bound port (resolved even when port 0 was requested). */
  port: number;
  close: () => Promise<void>;
}

function jsonRpcError(
  res: http.ServerResponse,
  status: number,
  code: number,
  message: string,
): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    ...(status === 405 ? { Allow: "POST" } : {}),
  });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw.length === 0 ? undefined : JSON.parse(raw);
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: CreateServerOptions,
): Promise<void> {
  // Stateless: only POST carries JSON-RPC. A 405 on GET tells the client there
  // is no long-lived SSE stream, which the SDK client tolerates gracefully.
  if (req.method !== "POST") {
    jsonRpcError(res, 405, -32000, "Method Not Allowed");
    return;
  }

  const server = createServer(options);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    const body = await readJsonBody(req);
    await transport.handleRequest(req, res, body);
  } catch {
    if (!res.headersSent) {
      jsonRpcError(res, 500, -32603, "Internal server error");
    }
  }
}

/** Build a node:http request listener that serves the MCP server statelessly. */
export function createRequestListener(options: CreateServerOptions = {}): http.RequestListener {
  return (req, res) => {
    void handle(req, res, options);
  };
}

/** Start an HTTP server bound to a port (0 = ephemeral). Resolves once listening. */
export async function startHttp(options: HttpServerOptions = {}): Promise<RunningHttpServer> {
  const { port = 0, host = "127.0.0.1", ...serverOptions } = options;
  const httpServer = http.createServer(createRequestListener(serverOptions));
  await new Promise<void>((resolve) => httpServer.listen(port, host, () => resolve()));

  const address = httpServer.address();
  const boundPort = typeof address === "object" && address !== null ? address.port : port;

  return {
    server: httpServer,
    port: boundPort,
    close: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
