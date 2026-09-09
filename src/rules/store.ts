/**
 * Versioned rules store and refresh (Commander workshop: rules and combo
 * intelligence).
 *
 * The two rules corpora live beside the card snapshots, under
 * `<data root>/rules/`, in the same versioned layout the card store uses:
 *
 *   rules/versions/<id>/comprehensive-rules.txt   verbatim release bytes
 *   rules/versions/<id>/rulings.jsonl             decoded Scryfall rulings export
 *   rules/versions/<id>/manifest.json             {@link RulesManifest}
 *   rules/current.json                            atomic pointer (+ previous)
 *
 * A refresh downloads both sources into a fresh version, validates that each
 * parses into a usable corpus, then flips the pointer. Any failure — network,
 * an unreadable rules page, a malformed or truncated download — removes the
 * staged version and leaves the published pointer untouched, so the last
 * usable corpus keeps serving. Refreshes are explicit; nothing here runs at
 * boot.
 */
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { BulkClient, VersionedStore, type BulkDataEntry, type FetchFn } from "../ingest/index.js";
import { StructuredError, USER_AGENT } from "../types/index.js";
import type { RulesManifest } from "../types/rules.js";
import { ComprehensiveRulesCorpus, parseComprehensiveRules } from "./comprehensive.js";
import { parseRulingsText } from "./rulings.js";

export const RULES_DIRECTORY = "rules";
export const COMPREHENSIVE_RULES_FILE = "comprehensive-rules.txt";
export const RULINGS_FILE = "rulings.jsonl";

/** Wizards' rules page links the current Comprehensive Rules release. */
export const COMPREHENSIVE_RULES_PAGE_URL = "https://magic.wizards.com/en/rules";
/** The release verified while this module was written; used when the page cannot be read. */
export const PINNED_COMPREHENSIVE_RULES_URL =
  "https://media.wizards.com/2026/downloads/MagicCompRules%2020260819.txt";
/** A genuine release has thousands of numbered rules; anything smaller is not one. */
export const MIN_COMPREHENSIVE_RULE_COUNT = 1000;
/** Deadline for the rules page and the ~1MB text release. */
export const COMPREHENSIVE_RULES_TIMEOUT_MS = 60_000;

const RELEASE_LINK =
  /https?:\/\/media\.wizards\.com\/[^"'\s<>]*MagicCompRules(?:%20|\s|\+)?(\d{8})\.txt/i;
const RELEASE_VERSION = /MagicCompRules(?:%20|\s|\+)?(\d{8})\.txt$/i;

export interface RulesClientOptions {
  /** Injectable fetch (tests pass a stub). Defaults to global fetch. */
  fetch?: FetchFn;
  userAgent?: string;
  rulesPageUrl?: string;
  pinnedRulesUrl?: string;
  requestTimeoutMs?: number;
  /** Injectable sleep/clock forwarded to the throttled Scryfall bulk client. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export type UrlDiscovery = RulesManifest["comprehensive_rules"]["url_discovery"];

export interface ComprehensiveRulesDownload {
  url: string;
  discovery: UrlDiscovery;
  published_version: string | null;
  bytes: Buffer;
}

/** Release label from a download URL, e.g. "20260819"; null when not encoded there. */
export function releaseVersionFromUrl(url: string): string | null {
  return RELEASE_VERSION.exec(url)?.[1] ?? null;
}

/** Retrieves the Comprehensive Rules release and Scryfall's rulings export. */
export class RulesClient {
  private readonly fetchFn: FetchFn;
  private readonly userAgent: string;
  private readonly rulesPageUrl: string;
  private readonly pinnedRulesUrl: string;
  private readonly timeoutMs: number;
  readonly bulk: BulkClient;

  constructor(options: RulesClientOptions = {}) {
    this.fetchFn = options.fetch ?? fetch;
    this.userAgent = options.userAgent ?? USER_AGENT;
    this.rulesPageUrl = options.rulesPageUrl ?? COMPREHENSIVE_RULES_PAGE_URL;
    this.pinnedRulesUrl = options.pinnedRulesUrl ?? PINNED_COMPREHENSIVE_RULES_URL;
    this.timeoutMs = options.requestTimeoutMs ?? COMPREHENSIVE_RULES_TIMEOUT_MS;
    this.bulk = new BulkClient({
      fetch: this.fetchFn,
      userAgent: this.userAgent,
      sleep: options.sleep,
      now: options.now,
    });
  }

  private async request(url: string, accept: string): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchFn(url, {
        headers: { "User-Agent": this.userAgent, Accept: accept },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      throw new StructuredError("UPSTREAM_UNAVAILABLE", `Rules request failed: ${url}`, {
        url,
        reason: cause instanceof Error ? cause.message : String(cause),
      });
    }
    if (!response.ok) {
      throw new StructuredError(
        "UPSTREAM_UNAVAILABLE",
        `Rules source returned ${response.status}`,
        {
          url,
          status: response.status,
        },
      );
    }
    return response;
  }

  /**
   * Choose the release URL: an explicit one wins; otherwise the current link on
   * the rules page; otherwise the pinned release. The choice is recorded in
   * provenance so a stale pinned fallback is visible, never silent.
   */
  async resolveComprehensiveRulesUrl(
    explicit?: string,
  ): Promise<{ url: string; discovery: UrlDiscovery }> {
    if (explicit) return { url: explicit, discovery: "explicit" };
    try {
      const page = await this.request(this.rulesPageUrl, "text/html");
      const html = await page.text();
      const match = RELEASE_LINK.exec(html);
      if (match) {
        return { url: match[0].replace(/\s/g, "%20"), discovery: "rules_page" };
      }
    } catch (cause) {
      if (!(cause instanceof StructuredError)) throw cause;
    }
    return { url: this.pinnedRulesUrl, discovery: "pinned_default" };
  }

  async fetchComprehensiveRules(explicit?: string): Promise<ComprehensiveRulesDownload> {
    const { url, discovery } = await this.resolveComprehensiveRulesUrl(explicit);
    const response = await this.request(url, "text/plain");
    let bytes: Buffer;
    try {
      bytes = Buffer.from(await response.arrayBuffer());
    } catch (cause) {
      throw new StructuredError("UPSTREAM_UNAVAILABLE", "Comprehensive Rules download failed", {
        url,
        reason: cause instanceof Error ? cause.message : String(cause),
      });
    }
    return { url, discovery, published_version: releaseVersionFromUrl(url), bytes };
  }

  /** The Scryfall bulk `rulings` descriptor (throttled, descriptive User-Agent). */
  async rulingsEntry(): Promise<BulkDataEntry> {
    return this.bulk.getEntry("rulings");
  }

  /** Decoded JSONL bytes of the rulings export. */
  async openRulingsStream(entry: BulkDataEntry) {
    return this.bulk.openBulkStream(entry);
  }
}

/** The rules corpora's versioned directory, sharing the card store's layout and pointer swap. */
export class RulesStore extends VersionedStore {
  constructor(dataRoot: string) {
    super(path.join(dataRoot, RULES_DIRECTORY));
  }

  async readRulesManifest(id: string): Promise<RulesManifest | null> {
    const manifest = await this.readManifest<RulesManifest>(id);
    return manifest && manifest.version === id && manifest.comprehensive_rules && manifest.rulings
      ? manifest
      : null;
  }
}

export interface RefreshRulesOptions {
  store: RulesStore;
  client: RulesClient;
  /** Re-download even when the release digest and rulings export are unchanged. */
  force?: boolean;
  /** Explicit Comprehensive Rules release URL (recorded as `explicit`). */
  url?: string;
  /** Injectable clock for version ids and retrieval timestamps. */
  now?: () => Date;
  /** Versions to keep besides the current one (default 1). */
  retain?: number;
}

export interface RefreshRulesResult {
  version: string;
  skipped: boolean;
  manifest: RulesManifest;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function versionId(now: Date): string {
  return `${now.toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
}

function malformed(what: string, reason: string, url?: string): StructuredError {
  return new StructuredError("UPSTREAM_UNAVAILABLE", `${what} download is malformed: ${reason}`, {
    url,
    reason,
  });
}

/** Parse and validate release bytes; throws UPSTREAM_UNAVAILABLE when unusable. */
export function validateComprehensiveRules(
  bytes: Uint8Array,
  url?: string,
): ComprehensiveRulesCorpus {
  const text = Buffer.from(bytes).toString("utf8");
  const parsed = parseComprehensiveRules(text);
  if (parsed.rules.length < MIN_COMPREHENSIVE_RULE_COUNT) {
    throw malformed(
      "Comprehensive Rules",
      `expected at least ${MIN_COMPREHENSIVE_RULE_COUNT} numbered rules, found ${parsed.rules.length}`,
      url,
    );
  }
  if (!parsed.effective_date) {
    throw malformed("Comprehensive Rules", "no effective date sentence found", url);
  }
  return new ComprehensiveRulesCorpus(parsed);
}

/**
 * Download both corpora into a fresh version and publish it. Idempotent on the
 * release digest plus the rulings export's `updated_at` unless forced.
 */
export async function refreshRules(options: RefreshRulesOptions): Promise<RefreshRulesResult> {
  const { store, client, force = false } = options;
  const now = options.now ?? (() => new Date());

  const release = await client.fetchComprehensiveRules(options.url);
  const releaseDigest = sha256(release.bytes);
  const corpus = validateComprehensiveRules(release.bytes, release.url);
  const entry = await client.rulingsEntry();

  const currentId = await store.readCurrent();
  if (!force && currentId) {
    const current = await store.readRulesManifest(currentId);
    if (
      current &&
      current.comprehensive_rules.sha256 === releaseDigest &&
      current.rulings.updated_at === entry.updated_at
    ) {
      return { version: currentId, skipped: true, manifest: current };
    }
  }

  const id = versionId(now());
  await store.createVersion(id);
  try {
    const retrievedRules = now().toISOString();
    await store.writeBytes(id, COMPREHENSIVE_RULES_FILE, release.bytes);
    const { body, download } = await client.openRulingsStream(entry);
    const rulingsBytes = await store.writeStream(id, RULINGS_FILE, body);
    const staged = await readFile(store.filePath(id, RULINGS_FILE));
    const rulings = parseRulingsText(staged.toString("utf8"));
    if (rulings.malformed_lines > 0 || rulings.corpus.rulingCount === 0) {
      throw malformed(
        "Rulings",
        `${rulings.malformed_lines} unparseable line(s), ${rulings.corpus.rulingCount} rulings`,
        download.uri,
      );
    }
    const manifest: RulesManifest = {
      version: id,
      created_at: now().toISOString(),
      comprehensive_rules: {
        url: release.url,
        url_discovery: release.discovery,
        published_version: release.published_version,
        effective_date: corpus.parsed.effective_date,
        sha256: releaseDigest,
        bytes: release.bytes.byteLength,
        retrieved_at: retrievedRules,
        rule_count: corpus.ruleCount,
        glossary_count: corpus.glossaryCount,
      },
      rulings: {
        source: "scryfall_bulk_rulings",
        url: download.uri,
        updated_at: entry.updated_at,
        sha256: sha256(staged),
        bytes: rulingsBytes,
        retrieved_at: now().toISOString(),
        ruling_count: rulings.corpus.rulingCount,
      },
    };
    await store.writeManifest(id, manifest);
    await store.publish(id, currentId);
    await store.retain((options.retain ?? 1) + 1);
    return { version: id, skipped: false, manifest };
  } catch (err) {
    await store.removeVersion(id).catch(() => undefined);
    throw err instanceof StructuredError
      ? err
      : new StructuredError("UPSTREAM_UNAVAILABLE", "Rules refresh failed", {
          reason: err instanceof Error ? err.message : String(err),
        });
  }
}

export interface OpenRules {
  version: string;
  manifest: RulesManifest;
  corpus: ComprehensiveRulesCorpus;
  /** Staged rulings export; parsed lazily by the service. */
  rulingsPath: string;
  /** True when the pointer's current version was unusable and its predecessor served instead. */
  recovered_from_previous: boolean;
}

/** Open the published rules version, falling back to the pointer's predecessor. */
export async function openCurrentRules(store: RulesStore): Promise<OpenRules | null> {
  const pointer = await store.readPointer();
  if (!pointer) return null;
  const candidates: Array<{ version: string; recovered: boolean }> = [
    { version: pointer.version, recovered: false },
  ];
  if (pointer.previous) candidates.push({ version: pointer.previous, recovered: true });
  for (const { version, recovered } of candidates) {
    try {
      const manifest = await store.readRulesManifest(version);
      if (!manifest) continue;
      const bytes = await readFile(store.filePath(version, COMPREHENSIVE_RULES_FILE));
      if (sha256(bytes) !== manifest.comprehensive_rules.sha256) continue;
      const corpus = validateComprehensiveRules(bytes, manifest.comprehensive_rules.url);
      return {
        version,
        manifest,
        corpus,
        rulingsPath: store.filePath(version, RULINGS_FILE),
        recovered_from_previous: recovered,
      };
    } catch {
      /* Try the known predecessor. */
    }
  }
  return null;
}
