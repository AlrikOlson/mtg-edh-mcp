/**
 * Data-lifecycle tools (release-first-run): expose the existing ingest pipeline
 * (stage → build → validate → publish) as MCP tools to initialize an index-less install and
 * refresh a stale snapshot. Registered UNCONDITIONALLY — unlike the card/deck
 * tools these must work when no index exists yet.
 *
 * One {@link IngestRunner} instance must be shared across per-request servers
 * in HTTP mode (the same rule as CollectionStore); stdio has one long-lived
 * server anyway. Progress is PHASE-level (download → build, with elapsed time)
 * — the underlying download stream has no byte hooks, so a percentage would be
 * an invention.
 *
 * Existing indexed servers activate before reporting success. First ingestion
 * still needs a restart to register the indexed tools.
 */
import { z } from "zod";
import { BulkClient, VersionedStore } from "../ingest/index.js";
import { DEFAULT_DATA_ROOT } from "../index/index.js";
import { refreshSnapshot } from "../index/refresh.js";
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
  /** True when a complete unchanged snapshot was reused without rebuilding. */
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
  const result = await refreshSnapshot({
    store,
    client: new BulkClient(),
    force,
    onPhase,
  });
  return {
    snapshot: result.snapshot,
    cards: result.cards,
    skipped: result.skipped,
  };
};

/**
 * Serializes ingest runs and holds the pollable status. `start` returns
 * immediately; the pipeline runs in the background.
 */
export class IngestRunner {
  private current: IngestStatus = { running: false, phase: "idle" };
  private readonly root: string;
  private readonly pipeline: IngestPipeline;
  private readonly successListeners: Array<(status: IngestStatus) => void> = [];

  constructor(root?: string, pipeline: IngestPipeline = realPipeline) {
    this.root = root ?? process.env.MCP_DATA_DIR ?? DEFAULT_DATA_ROOT;
    this.pipeline = pipeline;
  }

  /**
   * Register a callback fired after every successful run (phase "done"),
   * including skipped ones. Activation belongs inside the pipeline; these
   * callbacks are notifications and must not perform a fallible activation.
   */
  onSuccess(listener: (status: IngestStatus) => void): void {
    this.successListeners.push(listener);
  }

  status(): IngestStatus {
    return { ...this.current };
  }

  /** Kick off a run in the background. Returns false when one is already running. */
  start(force: boolean): boolean {
    if (this.current.running) return false;
    this.current = {
      running: true,
      phase: "download",
      started_at: new Date().toISOString(),
    };
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
      for (const listener of this.successListeners) {
        try {
          listener(this.current);
        } catch {
          // A listener failure never corrupts the run status.
        }
      }
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

/** Staleness of the served bulk data, surfaced by data_status. */
export interface StalenessInfo {
  /** Age of the current bulk data in hours (from upstream updated_at), or null when unknown. */
  bulk_age_hours: number | null;
  /** True when the age exceeds the configured bulk refresh interval. */
  stale: boolean;
}

/** Async provider so the tool handler never caches a stale answer about staleness. */
export type StalenessProvider = () => Promise<StalenessInfo>;

export interface DataToolsOptions {
  /** Whether the running server booted with a card index. */
  hasIndex: boolean;
  runner: IngestRunner;
  /** When provided, data_status reports bulk data age + a stale flag. */
  staleness?: StalenessProvider;
}

/** `data_status` + `data_ingest` — the GUI onboarding/update surface. */
export function makeDataTools(options: DataToolsOptions): ToolDefinition[] {
  const { hasIndex, runner, staleness } = options;
  const statusTool: ToolDefinition = {
    name: "data_status",
    config: {
      annotations: READS_LOCAL,
      title: "Card-data status",
      description:
        "Report card-index readiness, bulk-data staleness, and any in-flight ingest.\n" +
        "USE: checking data exists before searching; polling during data_ingest. NOT: deck state (deck_status).\n" +
        "FLOW: ping -> data_status -> card_search.\n" +
        "ARGS: none.\n" +
        "RETURNS: has_index; bulk_age_hours + stale (age of the served bulk data vs the refresh " +
        "interval); ingest {running, phase download|build|done|error, snapshot, cards, error}. " +
        "A server that booted WITH an index hot-swaps onto a finished ingest automatically; " +
        "after a first-ever ingest (has_index false) restart/reconnect to get the card tools.",
      inputSchema: {},
    },
    handler: async () => {
      const ingest = runner.status();
      const freshness = staleness ? await staleness() : undefined;
      const staleNote = freshness?.stale ? " (STALE — refresh due)" : "";
      return {
        content: [
          {
            type: "text",
            text: hasIndex
              ? `index loaded${staleNote}; ingest ${ingest.phase}`
              : `no index; ingest ${ingest.phase}`,
          },
        ],
        structuredContent: {
          has_index: hasIndex,
          ...(freshness ?? {}),
          ingest,
        },
      };
    },
  };
  const ingestTool: ToolDefinition = {
    name: "data_ingest",
    config: {
      annotations: mutates({
        destructive: false,
        idempotent: false,
        openWorld: true,
      }),
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
        content: [
          {
            type: "text",
            text: started ? "ingest started" : "ingest already running",
          },
        ],
        structuredContent: { started, already_running: !started },
      };
    },
  };
  return [statusTool, ingestTool];
}
