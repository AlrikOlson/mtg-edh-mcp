import { describe, expect, it } from "vitest";
import { fakeWorkerArgs, type FakeWorkerMode } from "./fakeWorker.test-support.js";
import { assertCompatibleHello } from "./protocol.js";
import {
  ENGINE_VERSION,
  PROTOCOL_VERSION,
  SCHEMA_SHA256,
  type Response,
} from "./protocol.generated.js";
import { WorkerFailure, WorkerSupervisor, type WorkerSession } from "./supervisor.js";

const hello = {
  type: "hello" as const,
  data: {
    protocol_version: PROTOCOL_VERSION,
    engine_version: ENGINE_VERSION,
    schema_sha256: SCHEMA_SHA256,
  },
};
const run = {
  type: "run" as const,
  data: {
    admission_id: "fake-admission",
    scenario_digest: "a".repeat(64),
    trial_index: 0,
    seed: "0".repeat(16),
  },
};

function supervisor(mode: FakeWorkerMode, extra: { maxConcurrent?: number; grace?: number } = {}) {
  return new WorkerSupervisor({
    executable: process.execPath,
    args: fakeWorkerArgs(mode),
    maxConcurrent: extra.maxConcurrent ?? 1,
    killGraceMs: extra.grace ?? 300,
    maxStderrBytes: 4096,
  });
}

async function handshake(session: WorkerSession): Promise<void> {
  assertCompatibleHello(await session.exchange("h", hello), "h");
}

/** Collect a run's events and resolve with its outcome. */
function drive(session: WorkerSession, events: Response[] = []) {
  return session.stream("r", run, (reply) => {
    events.push(reply);
    return reply.message.type === "outcome";
  });
}

async function gone(pid: number | null): Promise<boolean> {
  if (pid === null) return true;
  for (let i = 0; i < 50; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

async function failure(promise: Promise<unknown>): Promise<WorkerFailure> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof WorkerFailure) return error;
    throw error;
  }
  throw new Error("expected a WorkerFailure");
}

const limits = { maxElapsedMs: 4000, maxOutputBytes: 1_000_000 };

describe("WorkerSupervisor", () => {
  it("routes replies by request id, ends input cleanly and reports a closed receipt", async () => {
    const events: Response[] = [];
    const { value, receipt } = await supervisor("complete").run(async (session) => {
      await handshake(session);
      const outcome = await drive(session, events);
      return outcome.message;
    }, limits);
    expect(value).toMatchObject({ type: "outcome", data: { type: "completed" } });
    expect(events.map((e) => e.message.type)).toEqual(["event", "event", "outcome"]);
    expect(receipt).toMatchObject({
      termination: "closed",
      exit_code: 0,
      exit_signal: null,
      requests: 2,
      responses: 4,
      hard_killed: false,
      stderr: "",
    });
    expect(await gone(receipt.pid)).toBe(true);
  });

  it("kills a hung worker at the parent deadline and leaves no orphan", async () => {
    const sup = supervisor("hang");
    const error = await failure(
      sup.run(
        async (session) => {
          await handshake(session);
          return drive(session);
        },
        { maxElapsedMs: 300, maxOutputBytes: 1_000_000 },
      ),
    );
    expect(error.reason).toBe("deadline");
    expect(error.receipt).toMatchObject({ termination: "deadline", exit_signal: "SIGTERM" });
    expect(await gone(error.receipt?.pid ?? null)).toBe(true);
    expect(sup.active()).toBe(0);
  });

  it("escalates to SIGKILL when a worker ignores SIGTERM", async () => {
    const error = await failure(
      supervisor("immortal", { grace: 100 }).run(
        async (session) => {
          await handshake(session);
          return drive(session);
        },
        { maxElapsedMs: 200, maxOutputBytes: 1_000_000 },
      ),
    );
    expect(error.receipt).toMatchObject({
      termination: "deadline",
      exit_signal: "SIGKILL",
      hard_killed: true,
    });
    expect(await gone(error.receipt?.pid ?? null)).toBe(true);
  });

  it("reports a crash as crashed with the real exit code", async () => {
    const error = await failure(
      supervisor("crash").run(async (session) => {
        await handshake(session);
        return drive(session);
      }, limits),
    );
    expect(error.reason).toBe("crashed");
    expect(error.receipt).toMatchObject({ termination: "crashed", exit_code: 3 });
  });

  it.each(["malformed", "rogue"] as const)(
    "discards the connection on a %s reply instead of guessing",
    async (mode) => {
      const error = await failure(
        supervisor(mode).run(async (session) => {
          await handshake(session);
          return drive(session);
        }, limits),
      );
      expect(error.reason).toBe("protocol");
      expect(error.receipt?.termination).toBe("protocol");
      expect(await gone(error.receipt?.pid ?? null)).toBe(true);
    },
  );

  it("terminates an output flood at the byte ceiling", async () => {
    const error = await failure(
      supervisor("flood").run(
        async (session) => {
          await handshake(session);
          return drive(session);
        },
        { maxElapsedMs: 4000, maxOutputBytes: 262_144 },
      ),
    );
    expect(error.reason).toBe("output_limit");
    expect(error.receipt?.stdout_bytes).toBeGreaterThan(262_144);
    expect(await gone(error.receipt?.pid ?? null)).toBe(true);
  });

  it("terminates a worker that floods stderr", async () => {
    const error = await failure(
      supervisor("stderr").run(async (session) => {
        await handshake(session);
        return drive(session);
      }, limits),
    );
    expect(error.reason).toBe("stderr_limit");
    expect(error.receipt?.stderr.length).toBeLessThanOrEqual(4096);
  });

  it("refuses a run before spawning when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const sup = supervisor("complete");
    const error = await failure(
      sup.run(async () => "never", { ...limits, signal: controller.signal }),
    );
    expect(error.reason).toBe("aborted");
    expect(error.receipt).toBeUndefined();
    expect(sup.active()).toBe(0);
  });

  it("cancels a live run cooperatively and lets the worker exit on its own", async () => {
    const controller = new AbortController();
    const events: Response[] = [];
    const { value, receipt } = await supervisor("slow").run(
      async (session) => {
        await handshake(session);
        const outcome = await session.stream("r", run, (reply) => {
          events.push(reply);
          if (events.length === 3) controller.abort();
          return reply.message.type === "outcome";
        });
        return outcome.message;
      },
      { ...limits, signal: controller.signal },
    );
    expect(value).toEqual({ type: "outcome", data: { type: "cancelled", data: {} } });
    expect(events.length).toBeGreaterThanOrEqual(4);
    // The cancel acknowledgement was consumed by the supervisor, never surfaced.
    expect(events.every((e) => e.request_id === "r")).toBe(true);
    expect(receipt).toMatchObject({ termination: "closed", exit_code: 0, hard_killed: false });
  });

  it("hard-kills a worker that ignores a cooperative cancel after the grace period", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 60);
    const error = await failure(
      supervisor("immortal-ignore-cancel", { grace: 100 }).run(
        async (session) => {
          await handshake(session);
          return drive(session);
        },
        { ...limits, signal: controller.signal },
      ),
    );
    expect(error.reason).toBe("aborted");
    expect(error.receipt).toMatchObject({ termination: "aborted", hard_killed: true });
    expect(await gone(error.receipt?.pid ?? null)).toBe(true);
  });

  it("aborts a session with no live run immediately", async () => {
    const controller = new AbortController();
    const error = await failure(
      supervisor("complete").run(
        async (session) => {
          await handshake(session);
          controller.abort();
          await new Promise((resolve) => setTimeout(resolve, 50));
          return session.exchange("late", hello);
        },
        { ...limits, signal: controller.signal },
      ),
    );
    expect(error.reason).toBe("aborted");
    expect(error.receipt?.termination).toBe("aborted");
  });

  it("refuses runs beyond the concurrency ceiling as busy without spawning", async () => {
    const sup = supervisor("slow", { maxConcurrent: 1 });
    const controller = new AbortController();
    let second: WorkerFailure | null = null;
    const { value } = await sup.run(
      async (session) => {
        await handshake(session);
        expect(sup.active()).toBe(1);
        second = await failure(sup.run(async () => "never", limits));
        return session.stream("r", run, (reply) => {
          // Stop the slow worker once the busy refusal has been observed.
          controller.abort();
          return reply.message.type === "outcome";
        });
      },
      { ...limits, signal: controller.signal },
    );
    expect(value.message).toEqual({ type: "outcome", data: { type: "cancelled", data: {} } });
    expect(second).not.toBeNull();
    expect((second as unknown as WorkerFailure).reason).toBe("busy");
    expect(sup.active()).toBe(0);
  });

  it("reports a worker that exits without answering as crashed", async () => {
    const error = await failure(
      supervisor("quiet-exit").run(async (session) => {
        await handshake(session);
        return drive(session);
      }, limits),
    );
    expect(error.reason).toBe("crashed");
    expect(error.receipt).toMatchObject({ termination: "crashed", exit_code: 0 });
  });

  it("reports a missing executable as spawn_failed", async () => {
    const sup = new WorkerSupervisor({
      executable: "/nonexistent/mtg-worker",
      args: ["--protocol"],
    });
    const error = await failure(sup.run(async (session) => session.exchange("h", hello), limits));
    expect(error.reason).toBe("spawn_failed");
    expect(error.message).toContain("ENOENT");
    expect(sup.active()).toBe(0);
  });

  it("rejects non-positive limits before spawning", async () => {
    const sup = supervisor("complete");
    await expect(sup.run(async () => 1, { maxElapsedMs: 0, maxOutputBytes: 1 })).rejects.toThrow(
      RangeError,
    );
    await expect(sup.run(async () => 1, { maxElapsedMs: 1, maxOutputBytes: 0 })).rejects.toThrow(
      RangeError,
    );
  });
});
