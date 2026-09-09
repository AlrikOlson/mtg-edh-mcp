import { spawn } from "node:child_process";
import { expect, it } from "vitest";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import {
  ENGINE_VERSION,
  PROTOCOL_VERSION,
  SCHEMA_SHA256,
  type Response,
} from "./protocol.generated.js";
import { assertCompatibleHello, WorkerFrameDecoder } from "./protocol.js";

const binary = process.env.MTG_WORKER_BINARY;
const native = it.skipIf(!binary);
const hello = {
  request_id: "h-1",
  message: {
    type: "hello",
    data: {
      protocol_version: PROTOCOL_VERSION,
      engine_version: ENGINE_VERSION,
      schema_sha256: SCHEMA_SHA256,
    },
  },
};
const line = (value: unknown) => Buffer.from(JSON.stringify(value) + "\n");

/** Acceptance harness only; the production supervisor belongs to a later chunk. */
async function run(input: Buffer): Promise<Response[]> {
  if (!binary) throw new Error("MTG_WORKER_BINARY is required for native acceptance");
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ["--protocol"], {
      stdio: ["pipe", "pipe", "pipe"],
      signal: AbortSignal.timeout(5000),
    });
    const decoder = new WorkerFrameDecoder(),
      replies: Response[] = [];
    let diagnostics = "",
      outputBytes = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      try {
        outputBytes += chunk.length;
        if (outputBytes > 262144) throw new Error("acceptance output limit exceeded");
        replies.push(...decoder.push(chunk));
      } catch (error) {
        child.kill("SIGKILL");
        reject(error);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      diagnostics += chunk.toString();
      if (diagnostics.length > 4096) {
        child.kill("SIGKILL");
        reject(new Error("excessive stderr"));
      }
    });
    child.once("error", reject);
    child.once("close", (code) => {
      try {
        decoder.finish();
        expect(code).toBe(0);
        expect(diagnostics).toBe("");
        resolve(replies);
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.on("error", reject);
    child.stdin.end(input);
  });
}

native("exchanges real generated Rust replies with the TypeScript validator", async () => {
  const f = z
    .object({
      valid: z.array(
        z.object({
          name: z.string(),
          direction: z.string(),
          value: z.unknown(),
        }),
      ),
    })
    .parse(
      JSON.parse(
        await readFile(new URL("../../engine/contract/fixtures.json", import.meta.url), "utf8"),
      ),
    );
  const requests = f.valid.filter(
    (c) => c.direction === "request" && ["admit", "run", "decision", "cancel"].includes(c.name),
  );
  const replies = await run(Buffer.concat([line(hello), ...requests.map((c) => line(c.value))]));
  expect(replies).toHaveLength(1 + requests.length);
  const first = replies[0];
  if (!first) throw new Error("missing hello");
  assertCompatibleHello(first, "h-1");
  for (const response of replies.slice(1)) {
    expect(response.request_id).toBe("req-1");
    expect(response.message.type).toBe("outcome");
    if (response.message.type === "outcome") expect(response.message.data.type).toBe("unsupported");
  }
});
native("rejects mismatched worker versions and drains only framed diagnostics", async () => {
  const changed = structuredClone(hello);
  changed.message.data.protocol_version = 2;
  const replies = await run(line(changed));
  expect(replies).toHaveLength(1);
  expect(() =>
    assertCompatibleHello(
      replies[0] ?? {
        message: { type: "outcome", data: { type: "cancelled", data: {} } },
      },
      "h-1",
    ),
  ).toThrow("invalid_handshake");
});
native("recovers after a malformed input frame through the real binary", async () => {
  const replies = await run(Buffer.concat([Buffer.from("{\n"), line(hello)]));
  expect(replies).toHaveLength(2);
  const last = replies[1];
  if (!last) throw new Error("missing hello");
  assertCompatibleHello(last, "h-1");
});
