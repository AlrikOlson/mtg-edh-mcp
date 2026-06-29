/**
 * mtg-edh-mcp — public library surface (spec §2).
 *
 * Re-exports the server core so consumers (and later engines) can build, extend,
 * and connect a server programmatically. The executable bootstrap lives in
 * `main.ts` (the bin entry); this module has no side effects.
 */
export { createServer, SERVER_NAME, SERVER_VERSION } from "./createServer.js";
export type { CreateServerOptions } from "./createServer.js";
export { registerTool, registerTools, stampSnapshot } from "./registry.js";
export type { ToolDefinition, ToolHandler } from "./registry.js";
export {
  staticSnapshotProvider,
  UNINITIALIZED_SNAPSHOT,
  type SnapshotProvider,
} from "./snapshot.js";
export { BUILTIN_TOOLS, pingTool } from "./tools.js";
export { startStdio } from "./stdio.js";
export { startHttp, createRequestListener } from "./http.js";
export type { HttpServerOptions, RunningHttpServer } from "./http.js";
