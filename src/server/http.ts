/**
 * Streamable HTTP transport (spec §2) — for local MCP clients.
 *
 * Stateless mode (`sessionIdGenerator: undefined`): a fresh server + transport
 * is created per POST, so there is no cross-request session state. Multi-tenancy
 * (§2/§11) is achieved by resolving a namespace from the `x-mcp-principal`
 * request header and passing it as the `session` to {@link createServer}: the
 * shared {@link DeckStore} (held in `options.deckStore` across all per-request
 * servers) isolates each principal's decks, while the shared {@link CardIndex}
 * serves bulk card data read-only to every session. Requests without the header
 * fall back to the single default "local" session.
 * This header is client-selected, not authentication. The listener is restricted
 * to loopback and must not be exposed directly to untrusted clients.
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
import { CollectionStore } from "../collection/index.js";
import { CacheStore, EdhrecClient, SpellbookClient, GameChangersClient } from "../meta/index.js";
import { createServer, type CreateServerOptions } from "./createServer.js";
import { IngestRunner } from "./dataTools.js";

export interface HttpServerOptions extends CreateServerOptions {
  /** Port to bind; 0 (default) picks an ephemeral free port. */
  port?: number;
  /** Loopback host/interface to bind: 127.0.0.1 (default), localhost, or ::1. */
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
/** Bounds deck imports and all other incoming JSON-RPC requests to 1 MiB. */
export const MAX_HTTP_BODY_BYTES = 1024 * 1024;

class RequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/** Resolve the per-request principal/session from the principal header (fallback "local"). */
function resolvePrincipal(req: http.IncomingMessage): string {
  const raw = req.headers[PRINCIPAL_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : "local";
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const declaredLength = Number(req.headers["content-length"]);
  if (declaredLength > MAX_HTTP_BODY_BYTES) {
    throw new RequestError(413, -32600, "Request body exceeds 1 MiB");
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  // Keep the socket alive long enough to send a 413 when iteration stops early.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    bytes += buffer.length;
    if (bytes > MAX_HTTP_BODY_BYTES) {
      throw new RequestError(413, -32600, "Request body exceeds 1 MiB");
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw) as unknown;
  } catch (err) {
    if (err instanceof SyntaxError) throw new RequestError(400, -32700, "Parse error");
    throw err;
  }
}

const LOCAL_HOST = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i;

/** Validate both browser origins and the target host before handling any method. */
function validateLocalRequest(req: http.IncomingMessage): void {
  if (!req.headers.host || !LOCAL_HOST.test(req.headers.host)) {
    throw new RequestError(403, -32000, "Forbidden host: use a loopback address");
  }
  const origin = req.headers.origin;
  if (origin === undefined) return; // Native MCP clients do not send Origin.
  try {
    const url = new URL(origin);
    if (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.origin === origin &&
      LOCAL_HOST.test(url.host)
    ) {
      return;
    }
  } catch {
    // Invalid origins receive the same response as non-local origins.
  }
  throw new RequestError(403, -32000, "Forbidden origin: only local clients are supported");
}

/** CORS for validated local browser clients. Invalid origins never reach here. */
function applyCors(req: http.IncomingMessage, res: http.ServerResponse): void {
  const origin = req.headers.origin;
  if (typeof origin !== "string") return;
  res.setHeader("Vary", "Origin");
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
  validateLocalRequest(req);
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

  const body = await readJsonBody(req);
  // Share stores/clients, but never the server or transport across requests.
  const server = createServer({
    ...options,
    session: resolvePrincipal(req),
    resourceSubscriptions: false,
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void server.close().catch(() => undefined);
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (err) {
    await server.close().catch(() => undefined);
    throw err;
  }
}

/** Build a node:http request listener that serves the MCP server statelessly. */
export function createRequestListener(options: CreateServerOptions = {}): http.RequestListener {
  const shared: CreateServerOptions = {
    ...options,
    collection: options.collection ?? new CollectionStore(),
    ingest: options.ingest ?? new IngestRunner(),
    edhrec: options.edhrec ?? new EdhrecClient(new CacheStore()),
    spellbook: options.spellbook ?? new SpellbookClient(new CacheStore()),
    gameChangers: options.gameChangers ?? new GameChangersClient(new CacheStore()),
  };
  return (req, res) => {
    void handle(req, res, shared).catch((err: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      // Close rejected requests after the response; do not keep buffering uploads.
      res.setHeader("Connection", "close");
      req.resume();
      if (err instanceof RequestError) {
        jsonRpcError(res, err.status, err.code, err.message);
      } else {
        jsonRpcError(res, 500, -32603, "Internal server error");
      }
    });
  };
}

/** Start an HTTP server bound to a port (0 = ephemeral). Resolves once listening. */
export async function startHttp(options: HttpServerOptions = {}): Promise<RunningHttpServer> {
  const { port = 0, host = "127.0.0.1", ...serverOptions } = options;
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error("HTTP is local-only: MCP_HTTP_HOST must be 127.0.0.1, localhost, or ::1");
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("HTTP port must be an integer between 0 and 65535");
  }
  const httpServer = http.createServer(createRequestListener(serverOptions));
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => {
      httpServer.removeListener("error", reject);
      resolve();
    });
  });

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
