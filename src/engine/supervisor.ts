/**
 * Reusable asynchronous supervisor for one native worker process.
 *
 * The supervisor owns everything the worker contract leaves to the parent:
 * a fixed executable and argument array (never a shell, never protocol-selected
 * paths), bounded LF framing through {@link WorkerFrameDecoder}, continuously
 * drained stdout/stderr, a concurrency ceiling, a parent elapsed deadline,
 * output and diagnostic byte ceilings, cooperative cancellation followed by
 * parent-enforced termination (SIGTERM, then SIGKILL after a grace period), and
 * a receipt that is only produced once every stdio pipe has closed, so a run
 * can never leave an orphaned worker behind.
 *
 * It interprets no game state. Replies are routed by `request_id` to the
 * request that produced them; anything the contract does not allow (an
 * unrouted reply, a framing failure, an early exit) ends the session with a
 * typed {@link WorkerFailure} instead of a guess.
 *
 * Reference: https://nodejs.org/api/child_process.html (spawn with explicit
 * argv, `stdio: "pipe"`, `kill`, and the `close` event that follows every pipe).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { encodeRequestFrame, WorkerFrameDecoder } from "./protocol.js";
import type { RequestMessage, Response } from "./protocol.generated.js";

export interface SupervisorOptions {
  /** Absolute path of the worker executable. Fixed for the supervisor's lifetime. */
  readonly executable: string;
  /** Fixed argument array; nothing from a request is ever appended. */
  readonly args: readonly string[];
  /** Maximum simultaneously live workers; further runs are refused as `busy`. */
  readonly maxConcurrent?: number;
  /** Milliseconds between a cooperative cancel or SIGTERM and SIGKILL. */
  readonly killGraceMs?: number;
  /** Ceiling on retained stderr bytes; exceeding it terminates the worker. */
  readonly maxStderrBytes?: number;
}

export interface RunOptions {
  /** Parent cancellation: a cooperative `cancel` for a live run, then a hard kill. */
  readonly signal?: AbortSignal;
  /** Parent deadline for the whole worker lifetime, in milliseconds. */
  readonly maxElapsedMs: number;
  /** Ceiling on total stdout bytes the worker may produce. */
  readonly maxOutputBytes: number;
}

export type TerminationReason =
  | "closed"
  | "deadline"
  | "output_limit"
  | "stderr_limit"
  | "protocol"
  | "aborted"
  | "crashed"
  | "spawn_failed";

export type FailureReason = TerminationReason | "busy";

/** What actually happened to the process; produced only after every pipe closed. */
export interface WorkerReceipt {
  readonly pid: number | null;
  readonly exit_code: number | null;
  readonly exit_signal: NodeJS.Signals | null;
  readonly elapsed_ms: number;
  readonly stdout_bytes: number;
  readonly stderr_bytes: number;
  /** Bounded stderr text (process/I-O diagnostics only; never protocol). */
  readonly stderr: string;
  readonly termination: TerminationReason;
  readonly requests: number;
  readonly responses: number;
  readonly hard_killed: boolean;
}

export class WorkerFailure extends Error {
  override readonly name = "WorkerFailure";
  constructor(
    readonly reason: FailureReason,
    message: string,
    readonly receipt?: WorkerReceipt,
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface WorkerSession {
  /** Send one request and resolve with the single reply carrying its id. */
  exchange(requestId: string, message: RequestMessage): Promise<Response>;
  /**
   * Send one request whose replies stream under its id; `onReply` returns true
   * for the terminal reply. A `run` is terminal on its `outcome`.
   */
  stream(
    requestId: string,
    message: RequestMessage,
    onReply: (reply: Response) => boolean,
  ): Promise<Response>;
  /**
   * Out-of-band cancel of the live run. The worker acknowledges after the run's
   * outcome; the acknowledgement is consumed here and never surfaced.
   */
  cancel(runRequestId: string): void;
  /** Aborted when the parent cancelled or a supervisor limit ended the session. */
  readonly signal: AbortSignal;
}

export interface RunResult<T> {
  readonly value: T;
  readonly receipt: WorkerReceipt;
}

interface Waiter {
  readonly onReply: (reply: Response) => boolean;
  readonly resolve: (reply: Response) => void;
  readonly reject: (error: WorkerFailure) => void;
}

const DEFAULT_MAX_CONCURRENT = 2;
const DEFAULT_KILL_GRACE_MS = 1000;
const DEFAULT_MAX_STDERR_BYTES = 16 * 1024;

export class WorkerSupervisor {
  private readonly executable: string;
  private readonly args: readonly string[];
  private readonly maxConcurrent: number;
  readonly killGraceMs: number;
  readonly maxStderrBytes: number;
  private live = 0;

  constructor(options: SupervisorOptions) {
    this.executable = options.executable;
    this.args = Object.freeze([...options.args]);
    this.maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    this.killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    this.maxStderrBytes = options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
  }

  /** Number of workers currently alive under this supervisor. */
  active(): number {
    return this.live;
  }

  /**
   * Spawn one worker, hand a session to `body`, then end input and wait for the
   * process to close. Resolves with the body's value and the process receipt;
   * rejects with {@link WorkerFailure} when the worker or a limit ended the
   * session first. Either way the worker is gone when the promise settles.
   */
  async run<T>(
    body: (session: WorkerSession) => Promise<T>,
    options: RunOptions,
  ): Promise<RunResult<T>> {
    if (!Number.isInteger(options.maxElapsedMs) || options.maxElapsedMs <= 0)
      throw new RangeError("maxElapsedMs must be a positive integer");
    if (!Number.isInteger(options.maxOutputBytes) || options.maxOutputBytes <= 0)
      throw new RangeError("maxOutputBytes must be a positive integer");
    if (this.live >= this.maxConcurrent)
      throw new WorkerFailure("busy", `worker concurrency limit ${this.maxConcurrent} reached`);
    if (options.signal?.aborted)
      throw new WorkerFailure("aborted", "cancelled before the worker started");
    this.live += 1;
    try {
      return await new Lifetime(this, options).execute(body);
    } finally {
      this.live -= 1;
    }
  }

  /** @internal */
  spawnWorker(): ChildProcess {
    return spawn(this.executable, [...this.args], {
      stdio: ["pipe", "pipe", "pipe"],
      // The executable is an absolute path chosen by the operator; the worker
      // needs nothing from the parent environment and must not see secrets.
      env: {},
      shell: false,
      windowsHide: true,
    });
  }
}

/** One worker process from spawn to close. */
class Lifetime {
  private readonly decoder = new WorkerFrameDecoder();
  private readonly waiters = new Map<string, Waiter>();
  private readonly abort = new AbortController();
  private readonly started = Date.now();
  private child: ChildProcess | null = null;
  private spawnError: Error | null = null;
  private stdoutBytes = 0;
  private stderrBytes = 0;
  private stderr = "";
  private requests = 0;
  private responses = 0;
  private termination: TerminationReason | null = null;
  private hardKilled = false;
  private ending = false;
  private liveRun: string | null = null;
  private cancelSent = false;
  /** Grace after a cooperative cancel before the parent kills the worker. */
  private abortTimer: NodeJS.Timeout | null = null;
  /** Grace after SIGTERM before SIGKILL. */
  private killTimer: NodeJS.Timeout | null = null;
  private deadline: NodeJS.Timeout | null = null;

  constructor(
    private readonly supervisor: WorkerSupervisor,
    private readonly options: RunOptions,
  ) {}

  async execute<T>(body: (session: WorkerSession) => Promise<T>): Promise<RunResult<T>> {
    const child = this.supervisor.spawnWorker();
    this.child = child;
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.once("error", (error) => {
          this.spawnError = error;
          this.fail("spawn_failed");
        });
        child.once("close", (code, signal) => {
          this.onClose();
          resolve({ code, signal });
        });
      },
    );
    child.stdout?.on("data", (chunk: Buffer) => this.onStdout(chunk));
    child.stderr?.on("data", (chunk: Buffer) => this.onStderr(chunk));
    child.stdin?.on("error", () => {
      // EPIPE after the worker died is reported through the close receipt.
    });
    this.deadline = setTimeout(() => this.fail("deadline"), this.options.maxElapsedMs);
    const onAbort = () => this.onAbort();
    this.options.signal?.addEventListener("abort", onAbort, { once: true });

    const session: WorkerSession = {
      exchange: (requestId, message) => this.stream(requestId, message, () => true),
      stream: (requestId, message, onReply) => this.stream(requestId, message, onReply),
      cancel: (runRequestId) => this.cancel(runRequestId),
      signal: this.abort.signal,
    };

    let value: T | undefined;
    let bodyError: unknown = null;
    try {
      value = await body(session);
    } catch (error) {
      bodyError = error;
    }
    // A clean end of input lets the worker answer its backlog and exit by itself.
    this.ending = true;
    if (this.termination === null) child.stdin?.end();
    else this.terminateProcess();
    const exit = await closed;
    this.options.signal?.removeEventListener("abort", onAbort);
    for (const timer of [this.deadline, this.abortTimer, this.killTimer])
      if (timer) clearTimeout(timer);
    const termination = this.termination ?? "closed";
    const receipt: WorkerReceipt = Object.freeze({
      pid: child.pid ?? null,
      exit_code: exit.code,
      exit_signal: exit.signal,
      elapsed_ms: Date.now() - this.started,
      stdout_bytes: this.stdoutBytes,
      stderr_bytes: this.stderrBytes,
      stderr: this.stderr,
      termination,
      requests: this.requests,
      responses: this.responses,
      hard_killed: this.hardKilled,
    });
    const detail = this.spawnError ? `: ${this.spawnError.message}` : "";
    const failed = `worker ${termination}${detail}`;
    if (bodyError !== null) {
      if (bodyError instanceof WorkerFailure)
        throw new WorkerFailure(
          bodyError.reason,
          bodyError.reason === termination ? failed : bodyError.message,
          receipt,
        );
      throw bodyError;
    }
    if (termination !== "closed") throw new WorkerFailure(termination, failed, receipt);
    return { value: value as T, receipt };
  }

  /** Every pipe has closed: settle the termination reason and any pending waiter. */
  private onClose(): void {
    if (this.termination === null) {
      try {
        this.decoder.finish();
        // Exiting before the parent ended input is a failure even with code 0.
        this.termination = this.ending ? "closed" : "crashed";
      } catch {
        this.termination = "protocol";
      }
    }
    // Waiters still pending after close never received their reply.
    this.rejectAll(this.termination === "closed" ? "crashed" : this.termination);
  }

  private stream(
    requestId: string,
    message: RequestMessage,
    onReply: (reply: Response) => boolean,
  ): Promise<Response> {
    return new Promise<Response>((resolve, reject) => {
      if (this.termination !== null) {
        reject(new WorkerFailure(this.termination, `worker ${this.termination}`));
        return;
      }
      if (this.waiters.has(requestId)) {
        reject(new WorkerFailure("protocol", `duplicate request id ${requestId}`));
        return;
      }
      let frame: Buffer;
      try {
        frame = encodeRequestFrame({ request_id: requestId, message });
      } catch (error) {
        reject(new WorkerFailure("protocol", error instanceof Error ? error.message : "encode"));
        return;
      }
      this.waiters.set(requestId, {
        onReply,
        resolve: (reply) => {
          if (this.liveRun === requestId) {
            this.liveRun = null;
            // The worker honored (or outran) the cancel: no hard kill is needed.
            if (this.abortTimer) {
              clearTimeout(this.abortTimer);
              this.abortTimer = null;
            }
          }
          resolve(reply);
        },
        reject,
      });
      this.requests += 1;
      this.child?.stdin?.write(frame);
      if (message.type === "run") {
        this.liveRun = requestId;
        this.cancelSent = false;
        // Parent cancelled between the decision to run and the send: honor it
        // at the worker's first checkpoint instead of racing a hard kill.
        if (this.abort.signal.aborted) this.onAbort();
      }
    });
  }

  private cancel(runRequestId: string): void {
    if (this.termination !== null || this.cancelSent || this.liveRun !== runRequestId) return;
    this.cancelSent = true;
    const cancelRequestId = `${runRequestId}.cancel`;
    // The acknowledgement arrives after the run's outcome and is consumed here.
    this.waiters.set(cancelRequestId, {
      onReply: () => true,
      resolve: () => {},
      reject: () => {},
    });
    this.requests += 1;
    this.child?.stdin?.write(
      encodeRequestFrame({
        request_id: cancelRequestId,
        message: { type: "cancel", data: { run_request_id: runRequestId } },
      }),
    );
  }

  private onStdout(chunk: Buffer): void {
    if (this.termination !== null) return;
    this.stdoutBytes += chunk.length;
    if (this.stdoutBytes > this.options.maxOutputBytes) {
      this.fail("output_limit");
      return;
    }
    let replies: Response[];
    try {
      replies = this.decoder.push(chunk);
    } catch {
      this.fail("protocol");
      return;
    }
    for (const reply of replies) {
      this.responses += 1;
      const id = reply.request_id ?? null;
      const waiter = id === null ? undefined : this.waiters.get(id);
      if (id === null || !waiter) {
        // A reply nothing asked for (including an unattributed malformed_frame
        // diagnostic) means the two sides disagree; stop rather than guess.
        this.fail("protocol");
        return;
      }
      let terminal: boolean;
      try {
        terminal = waiter.onReply(reply);
      } catch {
        this.fail("protocol");
        return;
      }
      if (terminal) {
        this.waiters.delete(id);
        waiter.resolve(reply);
      }
    }
  }

  private onStderr(chunk: Buffer): void {
    this.stderrBytes += chunk.length;
    if (this.stderrBytes > this.supervisor.maxStderrBytes) {
      this.fail("stderr_limit");
      return;
    }
    this.stderr += chunk.toString("utf8");
  }

  private onAbort(): void {
    if (this.termination !== null || this.ending) return;
    if (!this.abort.signal.aborted) this.abort.abort();
    if (this.liveRun !== null) {
      if (this.cancelSent) return;
      // Cooperative first: the worker reports `cancelled` at its next checkpoint.
      this.cancel(this.liveRun);
      this.abortTimer = setTimeout(() => this.fail("aborted"), this.supervisor.killGraceMs);
      return;
    }
    this.fail("aborted");
  }

  /** Record the first reason and terminate the process. */
  private fail(reason: TerminationReason): void {
    if (this.termination !== null) return;
    this.termination = reason;
    if (!this.abort.signal.aborted) this.abort.abort();
    this.rejectAll(reason);
    this.terminateProcess();
  }

  private terminateProcess(): void {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.stdin?.destroy();
    child.kill("SIGTERM");
    if (this.killTimer) clearTimeout(this.killTimer);
    this.killTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        this.hardKilled = true;
        child.kill("SIGKILL");
      }
    }, this.supervisor.killGraceMs);
  }

  private rejectAll(reason: TerminationReason): void {
    const pending = [...this.waiters.values()];
    this.waiters.clear();
    for (const waiter of pending) waiter.reject(new WorkerFailure(reason, `worker ${reason}`));
  }
}
