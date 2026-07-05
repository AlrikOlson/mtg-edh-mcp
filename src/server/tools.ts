/**
 * Built-in tools that ship with the server core. Domain tools (card_*, deck_*,
 * validate_*, analyze_*, meta_*) register from their own engines in later phases.
 */
import { z } from "zod";
import type { ToolDefinition } from "./registry.js";

/**
 * `ping` — a trivial echo/liveness tool. Proves the registration framework,
 * snapshot stamping, and round-trip plumbing end to end (§2 acceptance).
 */
export const pingTool: ToolDefinition = {
  name: "ping",
  config: {
    title: "Ping",
    description:
      "Echo a liveness check.\n" +
      "USE: verifying the server is reachable. NOT: card-data readiness (data_status).\n" +
      "FLOW: (connect) -> ping -> data_status.\n" +
      "ARGS: message (optional; echoed back, default 'pong').\n" +
      "RETURNS: message.",
    inputSchema: { message: z.string().optional() },
  },
  handler: (args) => {
    const message = typeof args.message === "string" ? args.message : "pong";
    return {
      content: [{ type: "text", text: message }],
      structuredContent: { message },
    };
  },
};

/** Tools always registered by the server core. */
export const BUILTIN_TOOLS: readonly ToolDefinition[] = [pingTool];
