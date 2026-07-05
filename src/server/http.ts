/**
 * Streamable HTTP transport (spec §2) — for hosted MCP clients.
 *
 * Stateless mode (`sessionIdGenerator: undefined`): a fresh server + transport
 * is created per POST, so there is no cross-request session state. Multi-tenancy
 * (§2/§11) is achieved by resolving a *principal* from the `x-mcp-principal`
 * request header and passing it as the `session` to {@link createServer}: the
 * shared {@link DeckStore} (held in `options.deckStore` across all per-request
 * servers) isolates each principal's decks, while the shared {@link CardIndex}
 * serves bulk card data read-only to every session. Requests without the header
 * fall back to the single default "local" session.
 *
 * Security note (CVE-2026-25536, audited 2026-07-04): sharing one McpServer or
 * transport instance across clients in stateless deployments could leak
 * cross-client response data in SDK <=1.25.3 (fixed 1.26.0; we pin ^1.29.0).
 * The fresh-server-plus-fresh-transport-per-POST construction below makes the
 * precondition structurally absent — keep it that way. Regression guard:
 * multitenancy.test.ts "never leaks across principals under interleaved
 * stateless POSTs".
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

/** HTTP header carrying the deck-scope principal (a single token, never trusted as auth). */
export const PRINCIPAL_HEADER = "x-mcp-principal";

/** Resolve the per-request principal/session from the principal header (fallback "local"). */
function resolvePrincipal(req: http.IncomingMessage): string {
  const raw = req.headers[PRINCIPAL_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : "local";
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw.length === 0 ? undefined : JSON.parse(raw);
}

/**
 * Minimal CORS for local browser-based clients (the Dioxus web target used by
 * the GUI scrutiny gate). Only localhost origins are reflected — this server
 * binds 127.0.0.1 and is not meant to be exposed cross-origin beyond dev.
 */
function applyCors(req: http.IncomingMessage, res: http.ServerResponse): void {
  const origin = req.headers.origin;
  if (typeof origin !== "string") return;
  if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "content-type, accept, x-mcp-principal, mcp-protocol-version",
  );
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: CreateServerOptions,
): Promise<void> {
  applyCors(req, res);
  // CORS preflight from a browser client: answer before the POST-only gate.
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }
  // Stateless: only POST carries JSON-RPC. A 405 on GET tells the client there
  // is no long-lived SSE stream, which the SDK client tolerates gracefully.
  if (req.method !== "POST") {
    jsonRpcError(res, 405, -32000, "Method Not Allowed");
    return;
  }

  // Scope deck state to the request's principal; card data stays shared read-only.
  const server = createServer({ ...options, session: resolvePrincipal(req) });
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
