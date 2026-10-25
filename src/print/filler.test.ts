import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UserDataStore } from "../storage/userData.js";
import type { Deck } from "../types/index.js";
import { fakeFillerWorkerSource, type FakeFillerMode } from "./fakeFillerWorker.test-support.js";
import {
  PRINT_BROWSER_PROFILE_DIRECTORY,
  PrintFillerService,
  type FillerRunResult,
} from "./filler.js";
import { BROWSER_INSTALL_COMMAND } from "./fillerProtocol.js";
import { buildPrintManifest, type PrintManifest } from "./manifest.js";
import type { PrintJobRecord } from "./jobStore.js";
import { PRINT_PROJECT_FILENAME, PrintProjectSchema } from "./projectFile.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

let root: string;
let store: UserDataStore;
let services: PrintFillerService[];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "print-filler-"));
  store = new UserDataStore(root);
  services = [];
});
afterEach(async () => {
  for (const service of services) await service.shutdown();
  store.close();
  rmSync(root, { recursive: true, force: true });
});

function workerFor(mode: FakeFillerMode): string {
  const path = join(root, `fake-filler-${mode}.cjs`);
  writeFileSync(path, fakeFillerWorkerSource(mode));
  return path;
}

function service(mode: FakeFillerMode | "missing", extra: { maxElapsedMs?: number } = {}) {
  const instance = new PrintFillerService({
    jobs: store.print,
    dataRoot: root,
    workerEntry: mode === "missing" ? join(root, "absent", "print-filler.js") : workerFor(mode),
    killGraceMs: 300,
    ...extra,
  });
  services.push(instance);
  return instance;
}

function saveDeck(): Deck {
  const created = store.deckStore.create({ name: "Proxies" }, "alice");
  return store.deckStore.update(
    created.deck_id,
    (deck) => ({ ...deck, commanders: ["cmdr"], cards: [{ oracle_id: "alpha", qty: 2 }] }),
    "alice",
  );
}

function manifestOf(deck: Deck): PrintManifest {
  const result = buildPrintManifest(deck, () => null);
  if (result.kind !== "manifest") throw new Error("expected a manifest");
  return result.manifest;
}

/** A reviewed job whose project document is in place, as print_start leaves it. */
function reviewedJob(withProject = true): PrintJobRecord {
  const job = store.print.create({ principal: "alice", manifest: manifestOf(saveDeck()) }).job;
  const reviewed = store.print.transition("alice", job.job_id, "reviewed");
  if (reviewed.kind !== "updated") throw new Error("expected reviewed");
  if (withProject) {
    mkdirSync(job.job_dir, { recursive: true });
    const golden = PrintProjectSchema.parse(
      JSON.parse(readFileSync(join(FIXTURES, "printProject.golden.json"), "utf8")),
    );
    writeFileSync(
      join(job.job_dir, PRINT_PROJECT_FILENAME),
      JSON.stringify({ ...golden, job_id: job.job_id, project_name: job.project_name }),
    );
  }
  return reviewed.job;
}

function expectKind<K extends FillerRunResult["kind"]>(
  result: FillerRunResult,
  kind: K,
): Extract<FillerRunResult, { kind: K }> {
  if (result.kind !== kind) throw new Error(`expected ${kind}, got ${JSON.stringify(result)}`);
  return result as Extract<FillerRunResult, { kind: K }>;
}

describe("PrintFillerService", () => {
  it("probes the worker for browsers and reports an installable browser as an attention item, never a failure", async () => {
    const ready = await service("complete").probe();
    expect(ready).toMatchObject({ available: true, browser: "chromium", attention: [] });
    expect(ready.probe?.chromium.executable).toBe("/fake/chromium");

    const missing = await service("no-browser").probe();
    expect(missing.available).toBe(false);
    expect(missing.browser).toBeNull();
    expect(missing.attention).toEqual([
      {
        kind: "browser_missing",
        message: expect.stringContaining("Google Chrome"),
        command: BROWSER_INSTALL_COMMAND,
      },
    ]);
    expect(BROWSER_INSTALL_COMMAND).toBe("npx playwright install chromium");
  });

  it("reports a missing worker entry without spawning anything", async () => {
    const instance = service("missing");
    const report = await instance.probe();
    expect(report.available).toBe(false);
    expect(report.attention[0]).toMatchObject({ kind: "worker_missing" });
    expect(report.attention[0]?.message).toContain("print-filler.js");
    const job = reviewedJob();
    const result = await instance.run("alice", job.job_id);
    expect(result).toMatchObject({ kind: "unavailable" });
    expect(store.print.get("alice", job.job_id)?.status).toBe("reviewed");
  });

  it("drives a reviewed job through starting, filling with progress, and filled, holding the browser until shutdown", async () => {
    const instance = service("complete");
    const job = reviewedJob();
    const statuses: string[] = [];
    const progress: Array<{ slots_filled: number; slots_total: number }> = [];
    const result = await instance.run("alice", job.job_id, {
      onProgress: (update) => {
        statuses.push(update.job.status);
        if (update.job.progress) progress.push(update.job.progress);
      },
    });
    const filled = expectKind(result, "filled");
    expect(filled.job.status).toBe("filled");
    expect(filled.job.progress).toEqual({ slots_filled: 6, slots_total: 6 });
    expect(filled.job.failure).toBeNull();
    expect(filled.outcome).toMatchObject({ ssid: "FAKESSID", project_name: "mtg-edh-print-fake" });
    // Every event arrives on a job that is already filling; starting is the state before the first event.
    expect(statuses).toEqual(["filling", "filling", "filling"]);
    expect(progress).toEqual([
      { slots_filled: 0, slots_total: 6 },
      { slots_filled: 3, slots_total: 6 },
      { slots_filled: 6, slots_total: 6 },
    ]);
    expect(store.print.get("alice", job.job_id)?.status).toBe("filled");
    // The worker (and so the user's browser) stays open after the outcome.
    expect(instance.active()).toBe(1);
    const second = reviewedJob();
    expect(await instance.run("alice", second.job_id)).toMatchObject({ kind: "busy" });
    expect(store.print.get("alice", second.job_id)?.status).toBe("reviewed");
    await instance.shutdown();
    expect(instance.active()).toBe(0);
    const receipt = filled.closed ? await filled.closed : null;
    expect(receipt?.termination).toBe("closed");
  });

  it("passes the job directory, the browser profile directory under the data root and the chosen browser to the worker", async () => {
    const instance = service("complete");
    const job = reviewedJob();
    const messages: string[] = [];
    await instance.run("alice", job.job_id, {
      onProgress: (update) => messages.push(update.message),
    });
    expect(messages[0]).toContain(job.job_dir);
    expect(messages[0]).toContain("with chromium");
    expect(messages[0]).toContain(join(root, PRINT_BROWSER_PROFILE_DIRECTORY));
    expect(existsSync(join(root, PRINT_BROWSER_PROFILE_DIRECTORY))).toBe(true);
  });

  it("records a failed fill with its step and message and lets the job be retried in place", async () => {
    const instance = service("fail");
    const job = reviewedJob();
    const failed = expectKind(await instance.run("alice", job.job_id), "failed");
    expect(failed.job.status).toBe("failed");
    expect(failed.job.failure).toEqual({
      step: "place_front",
      message: "dnImg3_0_0 is not a slot any more",
    });
    expect(failed.outcome.instructions).toContain("continue by hand");
    expect(failed.outcome.screenshot).toBe(join(job.job_dir, "failure-place_front.png"));
    await instance.shutdown();
    expect(store.print.transition("alice", job.job_id, "starting")).toMatchObject({
      kind: "updated",
    });
  });

  it("records a crashed worker as a failure with the supervisor's reason", async () => {
    const instance = service("crash");
    const job = reviewedJob();
    const failed = expectKind(await instance.run("alice", job.job_id), "failed");
    expect(failed.job.status).toBe("failed");
    expect(failed.job.failure?.step).toBeNull();
    expect(failed.job.failure?.message).toMatch(/crashed/);
    expect(instance.active()).toBe(0);
  });

  it("cancels a running fill cooperatively and records the job as cancelled", async () => {
    const instance = service("hang-until-cancel");
    const job = reviewedJob();
    const controller = new AbortController();
    const result = instance.run("alice", job.job_id, {
      signal: controller.signal,
      onProgress: (update) => {
        if (update.job.progress?.slots_filled === 3) controller.abort();
      },
    });
    const cancelled = expectKind(await result, "cancelled");
    expect(cancelled.job.status).toBe("cancelled");
    expect(store.print.get("alice", job.job_id)?.status).toBe("cancelled");
    const receipt = await cancelled.closed;
    expect(receipt.hard_killed).toBe(false);
    expect(instance.active()).toBe(0);
  });

  it("refuses jobs it cannot run without touching them", async () => {
    const instance = service("complete");
    expect(await instance.run("alice", "00000000-0000-4000-8000-000000000000")).toEqual({
      kind: "not_found",
    });
    const prepared = store.print.create({
      principal: "alice",
      manifest: manifestOf(saveDeck()),
    }).job;
    expect(await instance.run("alice", prepared.job_id)).toEqual({
      kind: "invalid_status",
      status: "prepared",
    });
    const bare = reviewedJob(false);
    const noProject = await instance.run("alice", bare.job_id);
    expect(noProject).toMatchObject({ kind: "no_project" });
    expect(store.print.get("alice", bare.job_id)?.status).toBe("reviewed");
    // Another principal's job is invisible.
    const job = reviewedJob();
    expect(await instance.run("bob", job.job_id)).toEqual({ kind: "not_found" });
    expect(instance.active()).toBe(0);
  });
});
