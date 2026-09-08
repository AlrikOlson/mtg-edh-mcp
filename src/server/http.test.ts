import http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_HTTP_BODY_BYTES, startHttp, type RunningHttpServer } from "./http.js";

let running: RunningHttpServer;
let url: string;

beforeEach(async () => {
  running = await startHttp();
  url = `http://127.0.0.1:${running.port}/mcp`;
});

afterEach(async () => {
  await running.close();
});

const initialize = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "http-test", version: "1.0.0" },
  },
});
const headers = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

describe("local HTTP boundary", () => {
  it.each([
    "https://attacker.example",
    "null",
    "http://localhost.attacker.example",
    "http://localhost/path",
  ])("rejects invalid Origin %s before processing the request", async (origin) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { ...headers, Origin: origin },
      body: initialize,
    });
    expect(res.status).toBe(403);
    expect(res.headers.has("Access-Control-Allow-Origin")).toBe(false);
  });

  it("validates origins on preflight and GET requests too", async () => {
    for (const method of ["OPTIONS", "GET"]) {
      const res = await fetch(url, { method, headers: { Origin: "https://attacker.example" } });
      expect(res.status).toBe(403);
    }
  });

  it("rejects a non-loopback Host header", async () => {
    // Native fetch normalizes Host; node:http lets this regression send it verbatim.
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = http.request(
        url,
        {
          method: "POST",
          headers: { ...headers, Host: "attacker.example" },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      req.end(initialize);
    });
    expect(status).toBe(403);
  });

  it.each(["http://localhost:5173", "http://127.0.0.1:5173", "http://[::1]:5173"])(
    "allows local browser Origin %s with cache-safe CORS headers",
    async (origin) => {
      const res = await fetch(url, { method: "OPTIONS", headers: { Origin: origin } });
      expect(res.status).toBe(204);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe(origin);
      expect(res.headers.get("Vary")).toBe("Origin");
    },
  );

  it.each(["{broken", "", "   "])(
    "returns a JSON-RPC parse error for malformed JSON %j",
    async (body) => {
      const res = await fetch(url, { method: "POST", headers, body });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ jsonrpc: "2.0", error: { code: -32700 }, id: null });
    },
  );

  it("rejects oversized Content-Length before reading the body", async () => {
    const response = await new Promise<{ status: number | undefined; body: string }>(
      (resolve, reject) => {
        const req = http.request(
          url,
          {
            method: "POST",
            headers: { ...headers, "Content-Length": MAX_HTTP_BODY_BYTES + 1 },
          },
          (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (chunk: string) => {
              body += chunk;
            });
            res.on("end", () => {
              req.destroy();
              resolve({ status: res.statusCode, body });
            });
            res.on("error", reject);
          },
        );
        req.on("error", reject);
        req.setTimeout(2000, () => req.destroy(new Error("Server waited for an oversized body")));
        // The server must reject the declaration without waiting for any body bytes.
        // Sending a full upload would race the deliberate Connection: close response.
        req.flushHeaders();
      },
    );
    expect(response.status).toBe(413);
    expect(JSON.parse(response.body)).toMatchObject({ error: { code: -32600 } });
  });

  it("enforces the same limit on chunked requests", async () => {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = http.request(
        url,
        { method: "POST", headers: { ...headers, "Transfer-Encoding": "chunked" } },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      req.write("x".repeat(MAX_HTTP_BODY_BYTES / 2));
      req.end("x".repeat(MAX_HTTP_BODY_BYTES / 2 + 1));
    });
    expect(status).toBe(413);
  });

  it("retains the POST-only stateless transport response", async () => {
    const res = await fetch(url);
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
  });
});

describe("HTTP startup", () => {
  it("rejects a port collision without an unhandled server error", async () => {
    await expect(startHttp({ port: running.port })).rejects.toMatchObject({ code: "EADDRINUSE" });
  });

  it("rejects non-loopback binding", async () => {
    await expect(startHttp({ host: "0.0.0.0" })).rejects.toThrow("local-only");
  });

  it.each([-1, 65536, NaN, 1.5])("rejects invalid port %s", async (port) => {
    await expect(startHttp({ port })).rejects.toThrow("integer between 0 and 65535");
  });
});
