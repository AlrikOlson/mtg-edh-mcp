import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StructuredError } from "../types/errors.js";
import { ENGINE_JOBS_DATABASE_NAME, EngineJobStore, type JobRecord } from "./jobStore.js";

const roots: string[] = [];
async function root(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "engine-jobs-"));
  roots.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function record(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    job_id: randomUUID(),
    principal: "alice",
    idempotency_key: null,
    status: "queued",
    created_at: new Date().toISOString(),
    started_at: null,
    finished_at: null,
    cancel_requested_at: null,
    data_snapshot: "2026-09-08",
    input: { fixture_id: "fixture", seed: "0".repeat(16), trial_seed: "1".repeat(16) },
    fixture: { id: "fixture", version: 1, digest: "a".repeat(64) },
    engine: {
      protocol_version: 6,
      engine_version: "0.0.0",
      schema_sha256: "b".repeat(64),
      implementation_version: "core-support-v1",
    },
    progress: null,
    report: null,
    failure: null,
    persistence_error: null,
    ...overrides,
  };
}

describe("EngineJobStore", () => {
  it("creates its own database in the data root and round-trips a record", async () => {
    const dir = await root();
    const store = new EngineJobStore(dir);
    try {
      expect(existsSync(path.join(dir, ENGINE_JOBS_DATABASE_NAME))).toBe(true);
      const created = store.insert(record());
      expect(created.created).toBe(true);
      expect(store.get("alice", created.record.job_id)).toEqual(created.record);
      // Another principal cannot tell the job from a missing one.
      expect(store.get("bob", created.record.job_id)).toBeNull();
      expect(store.get("alice", randomUUID())).toBeNull();
    } finally {
      store.close();
    }
  });

  it("returns the existing record for a repeated idempotency key without writing", async () => {
    const dir = await root();
    const store = new EngineJobStore(dir);
    try {
      const first = store.insert(record({ idempotency_key: "k1" }));
      const second = store.insert(record({ idempotency_key: "k1" }));
      expect(second.created).toBe(false);
      expect(second.record.job_id).toBe(first.record.job_id);
      // The same key under another principal is another job.
      const other = store.insert(record({ principal: "bob", idempotency_key: "k1" }));
      expect(other.created).toBe(true);
      expect(store.list("alice", 10)).toHaveLength(1);
      expect(store.list("bob", 10)).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("refuses a submission whose commit fails and leaves nothing behind", async () => {
    const dir = await root();
    let fail = true;
    const store = new EngineJobStore(dir, {
      beforeCommit: () => {
        if (fail) throw new Error("disk full");
      },
    });
    try {
      const attempt = record({ idempotency_key: "k2" });
      let error: unknown;
      try {
        store.insert(attempt);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(StructuredError);
      expect((error as StructuredError).code).toBe("STORAGE_ERROR");
      expect((error as StructuredError).message).toContain("disk full");
      expect(store.get("alice", attempt.job_id)).toBeNull();
      fail = false;
      // The key was never taken, so the retry creates the job.
      expect(store.insert(attempt).created).toBe(true);
    } finally {
      store.close();
    }
  });

  it("updates state atomically and lists the records a restart must reconcile", async () => {
    const dir = await root();
    const store = new EngineJobStore(dir);
    try {
      const queued = store.insert(record({ created_at: "2026-09-19T00:00:01.000Z" })).record;
      const running = store.insert(
        record({ status: "running", created_at: "2026-09-19T00:00:02.000Z" }),
      ).record;
      const done = store.insert(
        record({ status: "completed", created_at: "2026-09-19T00:00:03.000Z" }),
      ).record;
      expect(store.listNonTerminal().map((r) => r.job_id)).toEqual([queued.job_id, running.job_id]);
      store.update({ ...running, status: "failed", finished_at: new Date().toISOString() });
      expect(store.listNonTerminal().map((r) => r.job_id)).toEqual([queued.job_id]);
      expect(store.get("alice", done.job_id)?.status).toBe("completed");
      expect(() => store.update(record())).toThrow(StructuredError);
    } finally {
      store.close();
    }
  });

  it("survives a reopen and refuses a foreign schema", async () => {
    const dir = await root();
    const first = new EngineJobStore(dir);
    const created = first.insert(record()).record;
    first.close();
    const second = new EngineJobStore(dir);
    try {
      expect(second.get("alice", created.job_id)).toEqual(created);
    } finally {
      second.close();
    }
    const { default: Database } = await import("better-sqlite3");
    const db = new Database(path.join(dir, ENGINE_JOBS_DATABASE_NAME));
    db.pragma("user_version = 99");
    db.close();
    expect(() => new EngineJobStore(dir)).toThrow(/schema version 99/);
  });
});
