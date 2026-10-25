/**
 * Print filler service (chunk print-mpc-filler): the MCP server's side of the
 * browser filler.
 *
 * It spawns the `print-filler` worker (node + one fixed entry argument, the
 * bundle beside this one) through the shared {@link WorkerSupervisor}, so the
 * same deadline, output ceilings, cooperative cancel and SIGTERM-then-SIGKILL
 * discipline apply as to the engine worker. The variable data (the job
 * directory, the browser profile directory, the browser to use) travels in
 * the `fill` frame, never on the command line. Playwright is never imported
 * here: the worker is the only process that loads it, and `probe()` asks the
 * worker which browsers it can launch, so a missing browser is an attention
 * item carrying the install command rather than a failure of the server.
 *
 * The service also owns the job's status while it fills: `reviewed` or
 * `failed` -> `starting` -> `filling` (with progress on every event) ->
 * `filled` | `failed` | `cancelled`, through the job store's transitions. The
 * outcome settles {@link PrintFillerService.run} while the worker keeps the
 * browser open for the user; the worker is released when the user closes the
 * browser, on cancel, or at {@link PrintFillerService.shutdown}.
 */
import { existsSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { WorkerFailure, WorkerSupervisor, type WorkerReceipt } from "../engine/supervisor.js";
import {
  FILLER_WIRE,
  type FillerBrowser,
  type FillerEvent,
  type FillerFailed,
  type FillerFilled,
  type FillerOutcome,
  type FillerProbe,
  type FillerReply,
  type FillerRequestMessage,
} from "./fillerProtocol.js";
import type { PrintJobRecord, PrintJobStatus, PrintJobStore } from "./jobStore.js";
import { PRINT_PROJECT_FILENAME, PrintProjectSchema } from "./projectFile.js";

/** The persistent browser profile that keeps the printer login, under the data root. */
export const PRINT_BROWSER_PROFILE_DIRECTORY = "print-browser-profile";
/** The worker bundle tsup emits next to the server bundle. */
export const PRINT_FILLER_WORKER_FILENAME = "print-filler.js";
/** The whole worker lifetime, fill plus the held browser; the user pays within this. */
export const DEFAULT_FILLER_MAX_ELAPSED_MS = 6 * 60 * 60_000;
/** Events are small; a hundred cards produce far less than this. */
export const DEFAULT_FILLER_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
/** Probing browsers needs no browser; it is a module load and a few file checks. */
const PROBE_MAX_ELAPSED_MS = 60_000;
const PROBE_MAX_OUTPUT_BYTES = 64 * 1024;
/** Grace between a cooperative cancel (closing the browser) and SIGTERM. */
const DEFAULT_KILL_GRACE_MS = 10_000;

/** Statuses a fill may start from: a reviewed order, or a failed fill retried in place. */
const STARTABLE: ReadonlySet<PrintJobStatus> = new Set(["reviewed", "failed"]);

export type FillerAttentionKind = "worker_missing" | "browser_missing" | "worker_failed";

export interface FillerAttentionItem {
  kind: FillerAttentionKind;
  message: string;
  /** A command the user can run to resolve it, when there is one. */
  command?: string;
}

export interface FillerProbeReport {
  /** True when a worker and a browser are both at hand. */
  available: boolean;
  browser: FillerBrowser | null;
  probe: FillerProbe | null;
  attention: FillerAttentionItem[];
}

export interface FillerProgressUpdate {
  job: PrintJobRecord;
  event: FillerEvent;
  message: string;
}

export type FillerRunResult =
  | { kind: "filled"; job: PrintJobRecord; outcome: FillerFilled; closed: Promise<WorkerReceipt> }
  | { kind: "failed"; job: PrintJobRecord; outcome: FillerFailed; closed: Promise<WorkerReceipt> }
  | { kind: "cancelled"; job: PrintJobRecord; closed: Promise<WorkerReceipt> }
  | { kind: "not_found" }
  | { kind: "invalid_status"; status: PrintJobStatus }
  | { kind: "no_project"; message: string }
  | { kind: "unavailable"; attention: FillerAttentionItem[] }
  | { kind: "busy" };

export interface PrintFillerServiceOptions {
  jobs: PrintJobStore;
  /** The user-data root; the browser profile lives under it. */
  dataRoot: string;
  /** The worker entry to run with node; defaults to the bundle beside this module. */
  workerEntry?: string;
  /** The node executable; defaults to the running one. */
  executable?: string;
  maxElapsedMs?: number;
  maxOutputBytes?: number;
  killGraceMs?: number;
  /** Headless only for fixture tests; the user must see the printer. */
  headless?: boolean;
  /** Fixture site URL for tests; null for the real printer. */
  siteUrl?: string | null;
}

export interface FillerRunOptions {
  signal?: AbortSignal;
  onProgress?: (update: FillerProgressUpdate) => void;
}

/** The default worker entry: the `print-filler.js` bundle next to the running bundle. */
export function defaultFillerWorkerEntry(): string {
  return fileURLToPath(new URL(`./${PRINT_FILLER_WORKER_FILENAME}`, import.meta.url));
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The browser to launch for a probe result, bundled Chromium first. */
export function chooseBrowser(probe: FillerProbe): FillerBrowser | null {
  if (probe.chromium.available) return "chromium";
  if (probe.chrome.available) return "chrome";
  return null;
}

function browserMissing(probe: FillerProbe): FillerAttentionItem {
  return {
    kind: "browser_missing",
    message:
      `No browser for the MakePlayingCards filler was found on ${probe.platform}: install Playwright's Chromium with ` +
      `\`${probe.install_command}\`, or install Google Chrome, then run print_status again.`,
    command: probe.install_command,
  };
}

export class PrintFillerService {
  readonly workerEntry: string;
  readonly profileDir: string;
  private readonly jobs: PrintJobStore;
  private readonly supervisor: WorkerSupervisor<FillerRequestMessage, FillerReply>;
  private readonly maxElapsedMs: number;
  private readonly maxOutputBytes: number;
  private readonly headless: boolean;
  private readonly siteUrl: string | null;
  private readonly holds = new Set<AbortController>();
  private readonly closing = new Set<Promise<unknown>>();

  constructor(options: PrintFillerServiceOptions) {
    this.jobs = options.jobs;
    this.workerEntry = options.workerEntry ?? defaultFillerWorkerEntry();
    this.profileDir = join(options.dataRoot, PRINT_BROWSER_PROFILE_DIRECTORY);
    this.maxElapsedMs = options.maxElapsedMs ?? DEFAULT_FILLER_MAX_ELAPSED_MS;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_FILLER_MAX_OUTPUT_BYTES;
    this.headless = options.headless ?? false;
    this.siteUrl = options.siteUrl ?? null;
    this.supervisor = new WorkerSupervisor<FillerRequestMessage, FillerReply>({
      executable: options.executable ?? process.execPath,
      args: [this.workerEntry],
      wire: FILLER_WIRE,
      // One browser window at a time: a second fill would fight for the profile.
      maxConcurrent: 1,
      killGraceMs: options.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
    });
  }

  /** Workers alive right now, including one holding the browser after its outcome. */
  active(): number {
    return this.supervisor.active();
  }

  private workerMissing(): FillerAttentionItem | null {
    if (existsSync(this.workerEntry)) return null;
    return {
      kind: "worker_missing",
      message: `The browser filler worker ${PRINT_FILLER_WORKER_FILENAME} is not at ${this.workerEntry}; rebuild the server (npm run build) and reinstall.`,
    };
  }

  /** Ask the worker which browsers it can launch; never throws, never touches a job. */
  async probe(): Promise<FillerProbeReport> {
    const missing = this.workerMissing();
    if (missing) return { available: false, browser: null, probe: null, attention: [missing] };
    let probe: FillerProbe;
    try {
      const result = await this.supervisor.run(
        async (session) => {
          const reply = await session.exchange("probe", { type: "probe", data: {} });
          if (reply.message.type !== "probe_result")
            throw new WorkerFailure("protocol", `unexpected ${reply.message.type} for probe`);
          return reply.message.data;
        },
        { maxElapsedMs: PROBE_MAX_ELAPSED_MS, maxOutputBytes: PROBE_MAX_OUTPUT_BYTES },
      );
      probe = result.value;
    } catch (error) {
      const reason = error instanceof WorkerFailure ? error.reason : "failed";
      return {
        available: false,
        browser: null,
        probe: null,
        attention: [
          {
            kind: "worker_failed",
            message: `The browser filler worker could not report its browsers (${reason}): ${describeError(error)}`,
          },
        ],
      };
    }
    const browser = chooseBrowser(probe);
    return {
      available: browser !== null,
      browser,
      probe,
      attention: browser === null ? [browserMissing(probe)] : [],
    };
  }

  /**
   * Fill one job: `reviewed` (or `failed`, retried in place) through
   * `starting`, `filling` and the outcome. Resolves on the outcome; the worker
   * then holds the browser for the user until released.
   */
  async run(
    principal: string,
    jobId: string,
    options: FillerRunOptions = {},
  ): Promise<FillerRunResult> {
    const job = this.jobs.get(principal, jobId);
    if (!job) return { kind: "not_found" };
    if (!STARTABLE.has(job.status)) return { kind: "invalid_status", status: job.status };
    const projectPath = join(job.job_dir, PRINT_PROJECT_FILENAME);
    try {
      PrintProjectSchema.parse(JSON.parse(await readFile(projectPath, "utf8")));
    } catch (error) {
      const detail = error instanceof z.ZodError ? z.prettifyError(error) : describeError(error);
      return {
        kind: "no_project",
        message: `${projectPath} is missing or not a print project: ${detail}`,
      };
    }
    if (this.supervisor.active() > 0) return { kind: "busy" };
    const report = await this.probe();
    if (!report.available || report.browser === null)
      return { kind: "unavailable", attention: report.attention };
    if (this.supervisor.active() > 0) return { kind: "busy" };
    mkdirSync(this.profileDir, { recursive: true, mode: 0o700 });

    const started = this.transition(principal, jobId, "starting");
    if (!started) return { kind: "not_found" };
    let current = started;
    const hold = new AbortController();
    this.holds.add(hold);
    const abort = () => hold.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();

    let settle: (outcome: FillerOutcome) => void = () => undefined;
    const settled = new Promise<FillerOutcome>((resolve) => {
      settle = resolve;
    });
    let outcomeSeen = false;
    const onEvent = (event: FillerEvent): void => {
      const progress = { slots_filled: event.slots_filled, slots_total: event.slots_total };
      const next =
        current.status === "starting"
          ? this.transition(principal, jobId, "filling", { progress })
          : this.recordProgress(principal, jobId, progress);
      if (next) current = next;
      options.onProgress?.({ job: current, event, message: event.message });
    };

    const closed: Promise<WorkerReceipt> = this.supervisor
      .run(
        async (session) => {
          await session.stream(
            "fill",
            {
              type: "fill",
              data: {
                job_dir: job.job_dir,
                profile_dir: this.profileDir,
                browser: report.browser ?? "chromium",
                headless: this.headless,
                site_url: this.siteUrl,
              },
            },
            (reply) => {
              switch (reply.message.type) {
                case "event":
                  onEvent(reply.message.data);
                  return false;
                case "outcome":
                  if (!outcomeSeen) {
                    outcomeSeen = true;
                    settle(reply.message.data);
                  }
                  return false;
                case "released":
                  return true;
                default:
                  return false;
              }
            },
          );
        },
        {
          signal: hold.signal,
          maxElapsedMs: this.maxElapsedMs,
          maxOutputBytes: this.maxOutputBytes,
        },
      )
      .then(
        (result) => result.receipt,
        (error: unknown) => {
          if (!outcomeSeen) {
            outcomeSeen = true;
            const reason = error instanceof WorkerFailure ? error.reason : "failed";
            settle(
              hold.signal.aborted
                ? { type: "cancelled", data: { step: null } }
                : {
                    type: "failed",
                    data: {
                      step: null,
                      message: `The browser filler worker ${reason}: ${describeError(error)}`,
                      screenshot: null,
                      instructions:
                        "Open your MakePlayingCards saved projects to see what was placed, then run print_start again to resume.",
                    },
                  },
            );
          }
          if (error instanceof WorkerFailure && error.receipt) return error.receipt;
          throw error;
        },
      )
      .finally(() => {
        this.holds.delete(hold);
        options.signal?.removeEventListener("abort", abort);
      });
    // A rejection after the outcome settled is still observed somewhere.
    const observed = closed.catch(() => undefined);
    this.closing.add(observed);
    void observed.finally(() => this.closing.delete(observed));

    const outcome = await settled;
    switch (outcome.type) {
      case "filled": {
        if (current.status === "starting") {
          const filling = this.transition(principal, jobId, "filling", {
            progress: {
              slots_filled: outcome.data.slots_total,
              slots_total: outcome.data.slots_total,
            },
          });
          if (filling) current = filling;
        }
        const filled = this.transition(principal, jobId, "filled", {
          progress: {
            slots_filled: outcome.data.slots_total,
            slots_total: outcome.data.slots_total,
          },
        });
        return { kind: "filled", job: filled ?? current, outcome: outcome.data, closed };
      }
      case "failed": {
        const failed = this.transition(principal, jobId, "failed", {
          failure: { step: outcome.data.step, message: outcome.data.message },
        });
        return { kind: "failed", job: failed ?? current, outcome: outcome.data, closed };
      }
      case "cancelled": {
        const cancelled = this.transition(principal, jobId, "cancelled");
        return { kind: "cancelled", job: cancelled ?? current, closed };
      }
      default: {
        const never: never = outcome;
        throw new Error(`unknown outcome ${JSON.stringify(never)}`);
      }
    }
  }

  /** Release every held browser and wait for the workers to be gone. */
  async shutdown(): Promise<void> {
    for (const hold of this.holds) hold.abort();
    await Promise.all([...this.closing]);
  }

  private transition(
    principal: string,
    jobId: string,
    status: PrintJobStatus,
    extra: Parameters<PrintJobStore["transition"]>[3] = {},
  ): PrintJobRecord | null {
    const result = this.jobs.transition(principal, jobId, status, extra);
    return result.kind === "updated" ? result.job : null;
  }

  private recordProgress(
    principal: string,
    jobId: string,
    progress: NonNullable<PrintJobRecord["progress"]>,
  ): PrintJobRecord | null {
    const result = this.jobs.recordProgress(principal, jobId, progress);
    return result.kind === "updated" ? result.job : null;
  }
}
