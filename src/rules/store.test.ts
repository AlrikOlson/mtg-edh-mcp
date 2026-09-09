import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { StructuredError } from "../types/index.js";
import { RulesStore, openCurrentRules, refreshRules } from "./store.js";
import { RulesService } from "./service.js";

import {
  FIXTURE_DISCOVERED_URL as DISCOVERED_URL,
  FIXTURE_PINNED_URL as PINNED_URL,
  FIXTURE_RULES_PAGE as RULES_PAGE,
  FIXTURE_RULING as RULING,
  FIXTURE_RULINGS_URL as RULINGS_URL,
  rulesFixture as fixture,
  syntheticComprehensiveRules as comprehensiveRules,
} from "./fixture.js";

let root: string;
let store: RulesStore;
let clock = Date.parse("2026-09-08T22:00:00Z");
const now = () => new Date(clock);

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "mtg-rules-"));
  store = new RulesStore(root);
  clock = Date.parse("2026-09-08T22:00:00Z");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("refreshRules", () => {
  it("discovers the current release from the rules page, stores both corpora with digests and publishes atomically", async () => {
    const { client, requested } = fixture();
    const result = await refreshRules({ store, client, now });
    expect(result.skipped).toBe(false);
    expect(requested).toEqual([
      RULES_PAGE,
      DISCOVERED_URL,
      "https://api.scryfall.com/bulk-data",
      RULINGS_URL,
    ]);
    const manifest = result.manifest;
    expect(manifest.comprehensive_rules).toMatchObject({
      url: DISCOVERED_URL,
      url_discovery: "rules_page",
      effective_date: "2026-08-07",
      published_version: "20260901",
      rule_count: 1204,
      glossary_count: 2,
      retrieved_at: "2026-09-08T22:00:00.000Z",
    });
    expect(manifest.comprehensive_rules.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.rulings).toMatchObject({
      source: "scryfall_bulk_rulings",
      url: RULINGS_URL,
      updated_at: "2026-09-08T21:00:31.549+00:00",
      ruling_count: 2,
    });
    expect(manifest.rulings.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.rulings.bytes).toBeGreaterThan(0);

    const opened = await openCurrentRules(store);
    expect(opened?.version).toBe(result.version);
    expect(opened?.corpus.ruleCount).toBe(1204);
    expect(opened?.corpus.lookup("903.17").status).toBe("found");
    const staged = await readFile(opened!.rulingsPath, "utf8");
    expect(staged.split("\n").filter(Boolean)).toHaveLength(2);
  });

  it("skips when the release digest and rulings export are unchanged, and re-downloads on force", async () => {
    const { client } = fixture();
    const first = await refreshRules({ store, client, now });
    clock += 60_000;
    const second = await refreshRules({ store, client, now });
    expect(second.skipped).toBe(true);
    expect(second.version).toBe(first.version);
    const forced = await refreshRules({ store, client, now, force: true });
    expect(forced.skipped).toBe(false);
    expect(forced.version).not.toBe(first.version);
  });

  it("falls back to the pinned release URL when the rules page is unreachable or has no link", async () => {
    const unreachable = fixture({ rulesPage: "fail" });
    const result = await refreshRules({ store, client: unreachable.client, now });
    expect(result.manifest.comprehensive_rules).toMatchObject({
      url: PINNED_URL,
      url_discovery: "pinned_default",
      published_version: "20260819",
    });
    const noLink = fixture({ rulesPage: "no-link" });
    const again = await refreshRules({ store, client: noLink.client, now, force: true });
    expect(again.manifest.comprehensive_rules.url_discovery).toBe("pinned_default");
  });

  it("honors an explicit release URL without consulting the rules page", async () => {
    const { client, requested } = fixture();
    const result = await refreshRules({
      store,
      client,
      now,
      url: "https://example.test/explicit.txt",
    });
    expect(result.manifest.comprehensive_rules).toMatchObject({
      url: "https://example.test/explicit.txt",
      url_discovery: "explicit",
      published_version: null,
    });
    expect(requested).not.toContain(RULES_PAGE);
  });

  it("rejects a malformed Comprehensive Rules download and keeps the published corpus", async () => {
    const good = await refreshRules({ store, client: fixture().client, now });
    const bad = fixture({ rulesText: "Not a rules document at all.\r\nNo numbered rules." });
    await expect(refreshRules({ store, client: bad.client, now, force: true })).rejects.toThrow(
      /malformed|no numbered rules|effective/i,
    );
    expect(await store.readCurrent()).toBe(good.version);
    expect(await readdir(store.versionsDir)).toEqual([good.version]);
  });

  it("rejects a truncated rulings export and keeps the published corpus", async () => {
    const good = await refreshRules({ store, client: fixture().client, now });
    const truncated = gzipSync(
      Buffer.from(`${JSON.stringify(RULING)}\n{"oracle_id": "trunc`, "utf8"),
    );
    const bad = fixture({ rulingsBody: truncated, rulingsUpdatedAt: "2026-09-09T00:00:00Z" });
    await expect(refreshRules({ store, client: bad.client, now })).rejects.toThrow(/malformed/i);
    expect(await store.readCurrent()).toBe(good.version);
    expect(await readdir(store.versionsDir)).toEqual([good.version]);
  });

  it("surfaces network failures as UPSTREAM_UNAVAILABLE and leaves a cold store cold", async () => {
    const dead = fixture({ rulesPage: "fail", rulesText: "fail" });
    const failure = await refreshRules({ store, client: dead.client, now }).catch(
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(StructuredError);
    expect((failure as StructuredError).code).toBe("UPSTREAM_UNAVAILABLE");
    expect(await store.readCurrent()).toBeNull();
    expect(await openCurrentRules(store)).toBeNull();
  });
});

describe("openCurrentRules", () => {
  it("returns null on a cold store and recovers the previous version when the current one is unreadable", async () => {
    expect(await openCurrentRules(store)).toBeNull();
    const first = await refreshRules({ store, client: fixture().client, now });
    const second = await refreshRules({
      store,
      client: fixture({ rulesText: comprehensiveRules("August 7, 2026", 1300) }).client,
      now,
    });
    expect(second.version).not.toBe(first.version);
    await writeFile(store.filePath(second.version, "comprehensive-rules.txt"), "corrupted");
    const opened = await openCurrentRules(store);
    expect(opened?.version).toBe(first.version);
    expect(opened?.corpus.ruleCount).toBe(1204);
    expect(opened?.recovered_from_previous).toBe(true);
  });
});

describe("RulesService", () => {
  it("reports unavailable on a cold store without touching the network", async () => {
    const { client, requested } = fixture();
    const service = new RulesService(store, { client: () => client, now: () => clock });
    await service.load();
    expect(service.corpus).toBeNull();
    expect(await service.rulings()).toBeNull();
    expect(service.status()).toMatchObject({
      status: "unavailable",
      version: null,
      comprehensive_rules: null,
      rulings: null,
      age_hours: null,
      refresh_failed: false,
      last_refresh: null,
    });
    expect(requested).toEqual([]);
  });

  it("serves the corpus after a refresh, ages into stale, and lazily parses rulings", async () => {
    const { client } = fixture();
    const service = new RulesService(store, {
      client: () => client,
      now: () => clock,
      staleAfterMs: 24 * 60 * 60 * 1000,
    });
    await service.load();
    const outcome = await service.refresh();
    expect(outcome).toMatchObject({ ok: true, skipped: false });
    expect(service.corpus?.ruleCount).toBe(1204);
    expect(service.status()).toMatchObject({
      status: "current",
      age_hours: 0,
      refresh_failed: false,
      last_refresh: { ok: true, skipped: false },
    });
    const rulings = await service.rulings();
    expect(rulings?.rulingsFor(RULING.oracle_id).map((r) => r.source_type)).toEqual([
      "wizards_ruling",
      "provider_note",
    ]);
    clock += 25 * 60 * 60 * 1000;
    expect(service.status()).toMatchObject({ status: "stale", age_hours: 25 });
  });

  it("keeps the last usable corpus with stale status when a refresh fails", async () => {
    const good = fixture();
    const service = new RulesService(store, { client: () => good.client, now: () => clock });
    await service.load();
    await service.refresh();
    const dead = fixture({ rulesPage: "fail", rulesText: "fail" });
    const failing = new RulesService(store, { client: () => dead.client, now: () => clock });
    await failing.load();
    expect(failing.corpus?.ruleCount).toBe(1204);
    const outcome = await failing.refresh();
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? null : outcome.error.code).toBe("UPSTREAM_UNAVAILABLE");
    expect(failing.corpus?.ruleCount).toBe(1204);
    expect(failing.status()).toMatchObject({
      status: "stale",
      refresh_failed: true,
      last_refresh: { ok: false, error: expect.stringMatching(/UPSTREAM_UNAVAILABLE/) },
    });
    expect(await failing.rulings()).not.toBeNull();
  });

  it("serializes concurrent refreshes instead of racing the store", async () => {
    const { client } = fixture();
    const service = new RulesService(store, { client: () => client, now: () => clock });
    await service.load();
    const [a, b] = await Promise.all([service.refresh(), service.refresh()]);
    expect(a).toMatchObject({ ok: true, skipped: false });
    expect(b).toMatchObject({ ok: false, error: { code: "UPSTREAM_UNAVAILABLE" } });
    expect(service.status().refreshing).toBe(false);
  });
});
