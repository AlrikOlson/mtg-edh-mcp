/**
 * Data-lifecycle tools (release-first-run): expose the existing ingest pipeline
 * (ingestBulk → buildIndex, both atomic — a half-built version is never
 * published) as MCP tools so the GUI can onboard an index-less install and
 * refresh a stale snapshot. Registered UNCONDITIONALLY — unlike the card/deck
 * tools these must work when no index exists yet.
 *
 * One {@link IngestRunner} instance must be shared across per-request servers
 * in HTTP mode (the same rule as CollectionStore); stdio has one long-lived
 * server anyway. Progress is PHASE-level (download → build, with elapsed time)
 * — the underlying download stream has no byte hooks, so a percentage would be
 * an invention.
 *
 * After a successful run the RUNNING server still serves the old index (tool
 * registration is static at createServer time): the client is expected to
 * reconnect/restart the server to pick up the new index.
 */
import { z } from "zod";
import { BulkClient, ingestBulk, VersionedStore } from "../ingest/index.js";
import { buildIndex, DEFAULT_DATA_ROOT } from "../index/index.js";
import { READS_LOCAL, mutates } from "./registry.js";
import type { ToolDefinition } from "./registry.js";

export type IngestPhase = "idle" | "download" | "build" | "done" | "error";

/** Snapshot of the current/last ingest run, safe to poll. */
export interface IngestStatus {
  running: boolean;
  phase: IngestPhase;
  started_at?: string;
  finished_at?: string;
  /** Present when phase is "done": the fresh data_snapshot date + card count. */
  snapshot?: string;
  cards?: number;
  /** True when upstream was unchanged (the index was rebuilt from cached bulk). */
  skipped?: boolean;
  /** Present when phase is "error". */
  error?: string;
}

/** The real download+build pipeline; injectable so tests never hit the network. */
export type IngestPipeline = (
  root: string,
  force: boolean,
  onPhase: (phase: IngestPhase) => void,
) => Promise<{ snapshot: string; cards: number; skipped: boolean }>;

const realPipeline: IngestPipeline = async (root, force, onPhase) => {
  const store = new VersionedStore(root);
  onPhase("download");
  const ingest = await ingestBulk({ store, client: new BulkClient(), force });
  onPhase("build");
  const built = await buildIndex({ store, version: ingest.version });
  return { snapshot: ingest.snapshot, cards: built.cards, skipped: ingest.skipped };
};

/**
 * Serializes ingest runs and holds the pollable status. `start` returns
 * immediately; the pipeline runs in the background.
 */
export class IngestRunner {
  private current: IngestStatus = { running: false, phase: "idle" };
  private readonly root: string;
  private readonly pipeline: IngestPipeline;

  constructor(root?: string, pipeline: IngestPipeline = realPipeline) {
    this.root = root ?? process.env.MCP_DATA_DIR ?? DEFAULT_DATA_ROOT;
    this.pipeline = pipeline;
  }

  status(): IngestStatus {
    return { ...this.current };
  }

  /** Kick off a run in the background. Returns false when one is already running. */
  start(force: boolean): boolean {
    if (this.current.running) return false;
    this.current = { running: true, phase: "download", started_at: new Date().toISOString() };
    void this.run(force);
    return true;
  }

  private async run(force: boolean): Promise<void> {
    const started_at = this.current.started_at;
    try {
      const result = await this.pipeline(this.root, force, (phase) => {
        this.current = { ...this.current, phase };
      });
      this.current = {
        running: false,
        phase: "done",
        started_at,
        finished_at: new Date().toISOString(),
        ...result,
      };
    } catch (err) {
      this.current = {
        running: false,
        phase: "error",
        started_at,
        finished_at: new Date().toISOString(),
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

export interface DataToolsOptions {
  /** Whether the running server booted with a card index. */
  hasIndex: boolean;
  runner: IngestRunner;
}

/** `data_status` + `data_ingest` — the GUI onboarding/update surface. */
export function makeDataTools(options: DataToolsOptions): ToolDefinition[] {
  const { hasIndex, runner } = options;
  const statusTool: ToolDefinition = {
    name: "data_status",
    config: {
      annotations: READS_LOCAL,
      title: "Card-data status",
      description:
        "Report card-index readiness and any in-flight ingest.\n" +
        "USE: checking data exists before searching; polling during data_ingest. NOT: deck state (deck_status).\n" +
        "FLOW: ping -> data_status -> card_search.\n" +
        "ARGS: none.\n" +
        "RETURNS: has_index; ingest {running, phase download|build|done|error, snapshot, cards, error}. " +
        "data_snapshot on every response is the RUNNING index's build date; after a 'done' ingest, " +
        "restart/reconnect to serve the fresh index.",
      inputSchema: {},
    },
    handler: () => {
      const ingest = runner.status();
      return {
        content: [
          {
            type: "text",
            text: hasIndex
              ? `index loaded; ingest ${ingest.phase}`
              : `no index; ingest ${ingest.phase}`,
          },
        ],
        structuredContent: { has_index: hasIndex, ingest },
      };
    },
  };
  const ingestTool: ToolDefinition = {
    name: "data_ingest",
    config: {
      annotations: mutates({ destructive: false, idempotent: false, openWorld: true }),
      title: "Card-data ingest",
      description:
        "Download Scryfall bulk data (~700MB) and rebuild the local card index atomically.\n" +
        "USE: first-run setup; refreshing a stale snapshot. NOT: quick checks (data_status).\n" +
        "FLOW: data_status -> data_ingest -> data_status (poll).\n" +
        "ARGS: force:true rebuilds even when upstream is unchanged.\n" +
        "RETURNS: started, already_running — returns immediately; poll data_status for phase. " +
        "One run at a time; a failed run never corrupts the served index.",
      inputSchema: { force: z.boolean().optional() },
    },
    handler: (args) => {
      const started = runner.start(args.force === true);
      return {
        content: [{ type: "text", text: started ? "ingest started" : "ingest already running" }],
        structuredContent: { started, already_running: !started },
      };
    },
  };
  return [statusTool, ingestTool];
}
