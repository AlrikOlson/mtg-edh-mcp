/**
 * Real-transport acceptance for the development-only engine preview route:
 * actual stdio and stateless Streamable HTTP clients, actual worker processes
 * (the pinned native worker when MTG_WORKER_BINARY is set, a protocol-shaped
 * fake otherwise), and the SDK's ordinary request context for cancellation.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { fakeWorkerArgs, type FakeWorkerMode } from "../engine/fakeWorker.test-support.js";
import { PREVIEW_MAX_DURATION_MS, PreviewFixtureService } from "../engine/previewRun.js";
import { PREVIEW_FIXTURE_ID } from "../engine/protocol.generated.js";
import type { WorkerReceipt } from "../engine/supervisor.js";
import { ENGINE_PREVIEW_TOOL, enginePreviewFromEnv } from "./engineTools.js";
import { startHttp, type RunningHttpServer } from "./http.js";
import { staticSnapshotProvider } from "./snapshot.js";

const SNAPSHOT = "2026-09-08";
const binary = process.env.MTG_WORKER_BINARY;
const native = it.skipIf(!binary);
const input = { fixture_id: PREVIEW_FIXTURE_ID, seed: "0000000000000000" };
let fixtureDir: string;

beforeAll(async () => {
  // The bundle must sit two directories below the repository root so the
  // service's `../../engine/contract/preview-fixture.json` resolves exactly as
  // it does from src/engine and dist; `build/` is ignored by Git.
  const buildRoot = fileURLToPath(new URL("../../build/", import.meta.url));
  await mkdir(buildRoot, { recursive: true });
  fixtureDir = await mkdtemp(path.join(buildRoot, "engine-preview-stdio-"));
  const require = createRequire(import.meta.url);
  await build({
    stdin: {
      contents: `
        import { startStdio } from "./stdio.js";
        import { staticSnapshotProvider } from "./snapshot.js";
        import { PreviewFixtureService } from "../engine/previewRun.js";
        import { fakeWorkerArgs } from "../engine/fakeWorker.test-support.js";
        const [executable, mode] = process.argv.slice(2);
        const service = new PreviewFixtureService({
          executable,
          args: mode === "native" ? ["--protocol"] : fakeWorkerArgs(mode),
          maxConcurrent: 1,
        });
        service.onReceipt((receipt) => process.stderr.write("RECEIPT " + JSON.stringify(receipt) + "\\n"));
        await startStdio({ snapshot: staticSnapshotProvider(${JSON.stringify(SNAPSHOT)}), enginePreview: service });
      `,
      resolveDir: fileURLToPath(new URL(".", import.meta.url)),
      sourcefile: "engine-preview-stdio.ts",
      loader: "ts",
    },
    outfile: path.join(fixtureDir, "main.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    banner: {
      js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
    },
    plugins: [
      {
        name: "external-native-sqlite",
        setup(builder) {
          builder.onResolve({ filter: /^better-sqlite3$/ }, ({ path: specifier }) => ({
            path: pathToFileURL(require.resolve(specifier)).href,
            external: true,
          }));
        },
      },
    ],
  });
}, 60_000);

afterAll(async () => {
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
});

type Era = "2026-07-28" | "2024-11-05";
function client(era: Era = "2026-07-28"): Client {
  return new Client(
    { name: "engine-preview-test", version: "1.0.0" },
    {
      supportedProtocolVersions: [era],
      versionNegotiation: { mode: era === "2026-07-28" ? { pin: era } : "legacy" },
    },
  );
}

function fakeService(mode: FakeWorkerMode): PreviewFixtureService {
  return new PreviewFixtureService({
    executable: process.execPath,
    args: fakeWorkerArgs(mode),
    maxConcurrent: 1,
  });
}

async function withHttp<T>(
  service: PreviewFixtureService | undefined,
  body: (url: URL, running: RunningHttpServer) => Promise<T>,
): Promise<T> {
  const running = await startHttp({
    snapshot: staticSnapshotProvider(SNAPSHOT),
    ...(service ? { enginePreview: service } : {}),
  });
  try {
    return await body(new URL(`http://127.0.0.1:${running.port}/mcp`), running);
  } finally {
    await running.close();
  }
}

async function withHttpClient<T>(
  service: PreviewFixtureService | undefined,
  body: (c: Client, url: URL) => Promise<T>,
  era: Era = "2026-07-28",
): Promise<T> {
  return withHttp(service, async (url) => {
    const c = client(era);
    await c.connect(new StreamableHTTPClientTransport(url));
    try {
      return await body(c, url);
    } finally {
      await c.close();
    }
  });
}

interface StdioHarness {
  readonly client: Client;
  readonly receipts: WorkerReceipt[];
  close(): Promise<void>;
}

async function stdioHarness(
  executable: string,
  mode: FakeWorkerMode | "native",
): Promise<StdioHarness> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(fixtureDir, "main.mjs"), executable, mode],
    stderr: "pipe",
  });
  const receipts: WorkerReceipt[] = [];
  let buffered = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    let index = buffered.indexOf("\n");
    while (index >= 0) {
      const line = buffered.slice(0, index);
      buffered = buffered.slice(index + 1);
      if (line.startsWith("RECEIPT ")) receipts.push(JSON.parse(line.slice(8)) as WorkerReceipt);
      index = buffered.indexOf("\n");
    }
  });
  const c = client();
  await c.connect(transport);
  return { client: c, receipts, close: () => c.close() };
}

const statusOf = (result: { structuredContent?: unknown }) =>
  z.object({ tool_status: z.string(), stage: z.string() }).parse(result.structuredContent);

async function rejects(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected rejection");
}

describe("engine_preview_fixture registration", () => {
  it("is absent by default and present only with an injected service", async () => {
    await withHttpClient(undefined, async (c) => {
      const { tools } = await c.listTools();
      expect(tools.map((t) => t.name)).not.toContain(ENGINE_PREVIEW_TOOL);
    });
    await withHttpClient(fakeService("complete"), async (c) => {
      const tool = (await c.listTools()).tools.find((t) => t.name === ENGINE_PREVIEW_TOOL);
      expect(tool).toBeDefined();
      expect(tool?.description).toContain(`MAX DURATION: ${PREVIEW_MAX_DURATION_MS} ms`);
      expect(tool?.description).toContain("NOT: deck evaluation");
      expect(tool?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
      const properties = z
        .object({ properties: z.record(z.string(), z.unknown()) })
        .parse(tool?.inputSchema).properties;
      expect(Object.keys(properties).sort()).toEqual([
        "fixture_id",
        "max_actions",
        "max_actions_per_turn",
        "max_elapsed_ms",
        "max_output_bytes",
        "max_turns",
        "max_work",
        "policies",
        "seed",
        "trial_index",
        "trials",
      ]);
    });
  });

  it("opts in only through the environment and rejects an unusable executable at boot", () => {
    expect(enginePreviewFromEnv({})).toBeUndefined();
    expect(enginePreviewFromEnv({ MTG_WORKER_BINARY: process.execPath })).toBeUndefined();
    expect(() => enginePreviewFromEnv({ MTG_ENGINE_PREVIEW: "1" })).toThrow("absolute path");
    expect(() =>
      enginePreviewFromEnv({ MTG_ENGINE_PREVIEW: "1", MTG_WORKER_BINARY: "relative/worker" }),
    ).toThrow("absolute path");
    expect(() =>
      enginePreviewFromEnv({ MTG_ENGINE_PREVIEW: "1", MTG_WORKER_BINARY: "/nonexistent/worker" }),
    ).toThrow("not an executable");
    expect(
      enginePreviewFromEnv({ MTG_ENGINE_PREVIEW: "1", MTG_WORKER_BINARY: process.execPath })
        ?.executable,
    ).toBe(process.execPath);
  });
});

describe("engine_preview_fixture over Streamable HTTP with protocol-shaped fake workers", () => {
  it.each([
    ["unsupported", "unsupported"],
    ["engine_error", "engine_error"],
  ] as const)("returns a worker %s outcome as a stamped result", async (mode, status) => {
    await withHttpClient(fakeService(mode), async (c) => {
      const result = await c.callTool({ name: ENGINE_PREVIEW_TOOL, arguments: input });
      expect(result.isError).not.toBe(true);
      expect(statusOf(result)).toEqual({ tool_status: status, stage: "run" });
      expect(result.structuredContent).toMatchObject({ data_snapshot: SNAPSHOT });
      expect(result._meta).toMatchObject({ data_snapshot: SNAPSHOT });
    });
  });

  it("reports a crashed worker as UPSTREAM_UNAVAILABLE, never as a game result", async () => {
    await withHttpClient(fakeService("crash"), async (c) => {
      const result = await c.callTool({ name: ENGINE_PREVIEW_TOOL, arguments: input });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        code: "UPSTREAM_UNAVAILABLE",
        details: { reason: "crashed" },
        data_snapshot: SNAPSHOT,
      });
    });
  });

  it("refuses undeclared or inconsistent inputs before any worker starts", async () => {
    const service = fakeService("complete");
    const receipts: WorkerReceipt[] = [];
    service.onReceipt((r) => receipts.push(r));
    await withHttpClient(service, async (c) => {
      const inconsistent = await c.callTool({
        name: ENGINE_PREVIEW_TOOL,
        arguments: { ...input, trial_index: 1, trials: 1 },
      });
      expect(inconsistent.isError).toBe(true);
      expect(inconsistent.structuredContent).toMatchObject({ code: "ENGINE_PREVIEW_INPUT" });
      for (const [bad, detail] of [
        [{ ...input, fixture_id: "muldrotha-final" }, "fixture_id"],
        [{ ...input, seed: "not-a-seed" }, "seed"],
        [{ ...input, deck_id: "authored-deck" }, 'Unrecognized key: "deck_id"'],
        [{ ...input, policies: ["fixture-baseline", "optimal"] }, "policies.1"],
        [{ ...input, max_elapsed_ms: 999_999 }, "max_elapsed_ms"],
      ] as const) {
        const refused = await c.callTool({ name: ENGINE_PREVIEW_TOOL, arguments: bad });
        expect(refused.isError).toBe(true);
        const text = z
          .array(z.object({ type: z.string(), text: z.string().optional() }))
          .parse(refused.content)[0]?.text;
        expect(text).toContain("Input validation error");
        expect(text).toContain(detail);
      }
    });
    expect(receipts).toHaveLength(0);
  });

  it("delivers progress notifications and a completed result to a modern client", async () => {
    await withHttpClient(fakeService("complete"), async (c) => {
      const progress: number[] = [];
      const result = await c.callTool(
        { name: ENGINE_PREVIEW_TOOL, arguments: { ...input, max_turns: 2 } },
        { onprogress: (p) => progress.push(p.progress) },
      );
      expect(statusOf(result)).toEqual({ tool_status: "completed", stage: "run" });
      expect(progress).toEqual([1, 2]);
      expect(result.structuredContent).toMatchObject({
        events_total: 2,
        max_duration_ms: PREVIEW_MAX_DURATION_MS,
        supervision: { termination: "closed", exit_code: 0 },
      });
    });
  });

  it("still serves a legacy 2024-11-05 client", async () => {
    await withHttpClient(
      fakeService("complete"),
      async (c) => {
        expect(c.getProtocolEra()).toBe("legacy");
        const result = await c.callTool({ name: ENGINE_PREVIEW_TOOL, arguments: input });
        expect(statusOf(result).tool_status).toBe("completed");
      },
      "2024-11-05",
    );
  });

  it("stops the worker when the HTTP client disconnects mid-run", async () => {
    const service = fakeService("slow");
    const receipts: WorkerReceipt[] = [];
    service.onReceipt((r) => receipts.push(r));
    await withHttpClient(service, async (c) => {
      const controller = new AbortController();
      const error = await rejects(
        c.callTool(
          { name: ENGINE_PREVIEW_TOOL, arguments: { ...input, max_turns: 50 } },
          {
            signal: controller.signal,
            onprogress: (p) => {
              if (p.progress >= 2) controller.abort();
            },
          },
        ),
      );
      expect(error).toBeInstanceOf(Error);
      await vi.waitFor(() => expect(receipts).toHaveLength(1), { timeout: 4000 });
      // hello, admit, run and the cooperative cancel; the worker exited by itself.
      expect(receipts[0]).toMatchObject({
        termination: "closed",
        hard_killed: false,
        requests: 4,
        exit_code: 0,
      });
      expect(service.active()).toBe(0);
    });
  });

  it("keeps unrelated requests responsive while a run is live", async () => {
    const service = fakeService("slow");
    await withHttp(service, async (url) => {
      const runner = client();
      const other = client();
      await Promise.all([
        runner.connect(new StreamableHTTPClientTransport(url)),
        other.connect(new StreamableHTTPClientTransport(url)),
      ]);
      const controller = new AbortController();
      try {
        const live = new Promise<void>((resolve) => {
          controller.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        const started = deferred();
        const run = runner.callTool(
          { name: ENGINE_PREVIEW_TOOL, arguments: { ...input, max_turns: 50 } },
          {
            signal: controller.signal,
            onprogress: () => {
              if (service.active() === 1 && !controller.signal.aborted) started.resolve();
            },
          },
        );
        await started.promise;
        const before = Date.now();
        const pong = await other.callTool({ name: "ping", arguments: { message: "live" } });
        expect(pong.structuredContent).toMatchObject({ message: "live" });
        expect(Date.now() - before).toBeLessThan(2000);
        controller.abort();
        await live;
        await rejects(run);
      } finally {
        await Promise.all([runner.close(), other.close()]);
      }
      await vi.waitFor(() => expect(service.active()).toBe(0), { timeout: 4000 });
    });
  });
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("engine_preview_fixture over stdio with protocol-shaped fake workers", () => {
  it("completes a run through a real stdio server process", async () => {
    const harness = await stdioHarness(process.execPath, "complete");
    try {
      const result = await harness.client.callTool({
        name: ENGINE_PREVIEW_TOOL,
        arguments: input,
      });
      expect(statusOf(result).tool_status).toBe("completed");
      await vi.waitFor(() => expect(harness.receipts).toHaveLength(1));
      expect(harness.receipts[0]).toMatchObject({ termination: "closed", requests: 3 });
    } finally {
      await harness.close();
    }
  });

  it("cancels the worker through notifications/cancelled, even for request id 0", async () => {
    const harness = await stdioHarness(process.execPath, "slow");
    try {
      // No request precedes this call: on a modern stdio connection it carries
      // JSON-RPC id 0, which the installed SDK's own cancellation handler drops.
      const controller = new AbortController();
      const error = await rejects(
        harness.client.callTool(
          { name: ENGINE_PREVIEW_TOOL, arguments: { ...input, max_turns: 50 } },
          {
            signal: controller.signal,
            onprogress: (p) => {
              if (p.progress >= 2) controller.abort();
            },
          },
        ),
      );
      expect(error).toBeInstanceOf(Error);
      await vi.waitFor(() => expect(harness.receipts).toHaveLength(1), { timeout: 4000 });
      expect(harness.receipts[0]).toMatchObject({
        termination: "closed",
        hard_killed: false,
        requests: 4,
        exit_code: 0,
      });
    } finally {
      await harness.close();
    }
  });
});

describe("engine_preview_fixture against the pinned native worker", () => {
  native("plays the fixture to a turn-five victory over HTTP with progress", async () => {
    const service = new PreviewFixtureService({ executable: binary as string });
    await withHttpClient(service, async (c) => {
      const progress: number[] = [];
      const result = await c.callTool(
        { name: ENGINE_PREVIEW_TOOL, arguments: input },
        { onprogress: (p) => progress.push(p.progress) },
      );
      expect(result.isError).not.toBe(true);
      expect(statusOf(result)).toEqual({ tool_status: "completed", stage: "run" });
      expect(result.structuredContent).toMatchObject({
        outcome: {
          type: "completed",
          data: { winner_seats: [0], reason: "life_reached_zero", turns: 5 },
        },
        engine: { protocol_version: 5, implementation_version: "core-support-v1" },
        events_total: 4,
        supervision: { termination: "closed", exit_code: 0, stderr: "" },
      });
      expect(progress).toEqual([1, 2, 3, 4]);
    });
  });

  native("plays a four-seat pod to one survivor through the MCP tool", async () => {
    const service = new PreviewFixtureService({ executable: binary as string });
    await withHttpClient(service, async (c) => {
      const progress: number[] = [];
      const result = await c.callTool(
        {
          name: ENGINE_PREVIEW_TOOL,
          arguments: {
            ...input,
            policies: [
              "fixture-baseline",
              "fixture-baseline",
              "fixture-baseline",
              "fixture-baseline",
            ],
            max_turns: 40,
          },
        },
        { onprogress: (p) => progress.push(p.progress) },
      );
      expect(result.isError).not.toBe(true);
      expect(statusOf(result)).toEqual({ tool_status: "completed", stage: "run" });
      expect(result.structuredContent).toMatchObject({
        outcome: {
          type: "completed",
          data: { winner_seats: [0], reason: "life_reached_zero", turns: 11 },
        },
        events_total: 10,
        supervision: { termination: "closed", exit_code: 0, stderr: "" },
      });
      expect(progress).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      const crowded = await c.callTool({
        name: ENGINE_PREVIEW_TOOL,
        arguments: { ...input, policies: Array<string>(5).fill("fixture-pass") },
      });
      expect(crowded.isError).toBe(true);
    });
  });

  native("reproduces the same hashes over stdio as over HTTP", async () => {
    const service = new PreviewFixtureService({ executable: binary as string });
    const overHttp = await withHttpClient(service, (c) =>
      c.callTool({ name: ENGINE_PREVIEW_TOOL, arguments: input }),
    );
    const harness = await stdioHarness(binary as string, "native");
    try {
      const overStdio = await harness.client.callTool({
        name: ENGINE_PREVIEW_TOOL,
        arguments: input,
      });
      const shape = z.object({
        outcome: z.unknown(),
        admission: z.unknown(),
        events: z.unknown(),
        catalog_digest: z.string(),
        input: z.object({ trial_seed: z.string() }),
      });
      expect(shape.parse(overStdio.structuredContent)).toEqual(
        shape.parse(overHttp.structuredContent),
      );
    } finally {
      await harness.close();
    }
  });

  native("truncates at the declared turn cap without a winner", async () => {
    const service = new PreviewFixtureService({ executable: binary as string });
    await withHttpClient(service, async (c) => {
      const result = await c.callTool({
        name: ENGINE_PREVIEW_TOOL,
        arguments: { ...input, max_turns: 2 },
      });
      expect(statusOf(result).tool_status).toBe("truncated");
      expect(result.structuredContent).toMatchObject({
        outcome: { type: "truncated", data: { reason: "turn_limit", turns: 2 } },
      });
    });
  });
});
