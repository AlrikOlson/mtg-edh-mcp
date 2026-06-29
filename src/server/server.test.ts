import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createServer } from "./createServer.js";
import { startHttp } from "./http.js";
import { stampSnapshot, type ToolDefinition } from "./registry.js";
import { staticSnapshotProvider } from "./snapshot.js";
import { StructuredError } from "../types/errors.js";

const SNAPSHOT = "2026-06-27";

/** A tool that always throws a StructuredError, to exercise the isError mapping. */
const boomTool: ToolDefinition = {
  name: "boom",
  config: { description: "Always throws DECK_NOT_FOUND." },
  handler: () => {
    throw new StructuredError("DECK_NOT_FOUND", "no such deck");
  },
};

async function connectInMemory(tools: readonly ToolDefinition[] = []): Promise<Client> {
  const server = createServer({ snapshot: staticSnapshotProvider(SNAPSHOT), tools });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

describe("stampSnapshot", () => {
  it("merges data_snapshot into both structuredContent and _meta", () => {
    const stamped = stampSnapshot({ content: [{ type: "text", text: "x" }] }, SNAPSHOT);
    expect(stamped.structuredContent).toMatchObject({ data_snapshot: SNAPSHOT });
    expect(stamped._meta).toMatchObject({ data_snapshot: SNAPSHOT });
  });
});

describe("server core over in-memory transport", () => {
  it("round-trips the ping tool and stamps data_snapshot", async () => {
    const client = await connectInMemory();
    const result = await client.callTool({ name: "ping", arguments: { message: "hello" } });

    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toBe("hello");
    expect(result.structuredContent).toMatchObject({ message: "hello", data_snapshot: SNAPSHOT });
    await client.close();
  });

  it("defaults ping to 'pong' when no message is given", async () => {
    const client = await connectInMemory();
    const result = await client.callTool({ name: "ping", arguments: {} });
    expect(result.structuredContent).toMatchObject({ message: "pong" });
    await client.close();
  });

  it("maps a thrown StructuredError to an isError result carrying the code", async () => {
    const client = await connectInMemory([boomTool]);
    const result = await client.callTool({ name: "boom", arguments: {} });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      code: "DECK_NOT_FOUND",
      data_snapshot: SNAPSHOT,
    });

    const content = result.content as Array<{ type: string; text: string }>;
    const payload = JSON.parse(content[0]?.text ?? "{}") as { code: string };
    expect(payload.code).toBe("DECK_NOT_FOUND");
    await client.close();
  });
});

describe("server core over streamable HTTP", () => {
  it("boots on HTTP and round-trips ping with data_snapshot stamped", async () => {
    const running = await startHttp({ port: 0, snapshot: staticSnapshotProvider(SNAPSHOT) });
    const client = new Client({ name: "test-http", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${running.port}/mcp`),
    );
    try {
      await client.connect(transport);
      const result = await client.callTool({ name: "ping", arguments: { message: "via-http" } });
      expect(result.structuredContent).toMatchObject({
        message: "via-http",
        data_snapshot: SNAPSHOT,
      });
    } finally {
      await client.close();
      await running.close();
    }
  });
});
