/**
 * Community image source (Proxy Order Helper, step 3b): the optional secondary
 * source behind the image selector.
 *
 * The MPC Autofill project indexes community-made card images kept in Google
 * Drive folders. Its backend is undocumented and read here from the frontend
 * client (github.com/chilli-axe/mpc-autofill, frontend/src/store/api.ts and
 * frontend/src/common/schema_types.ts, 2026-10-25): GET 2/sources/ lists the
 * drives, POST 3/editorSearch/ maps caller-chosen query keys to image
 * identifiers, and POST 2/cards/ hydrates identifiers into card documents.
 * Identifiers are Google Drive file ids. The desktop tool downloads them
 * through the authenticated Drive API; this adapter uses the anonymous
 * `uc?export=download` form instead and treats anything that is not an image
 * as the service being unavailable, so a sign-in or quota page never becomes
 * a printed card.
 *
 * Everything the selector needs is the {@link CommunityImageSource}
 * interface; the backend URL is configuration, never a default, because the
 * service is third-party and may change or go away.
 */
import { z } from "zod";
import type { FetchFn } from "../ingest/scryfall.js";
import { Throttle } from "../ingest/throttle.js";
import { StructuredError } from "../types/errors.js";
import { USER_AGENT } from "../types/userAgent.js";

/** One community image the search found. */
export interface CommunityCandidate {
  /** The MPC Autofill identifier (a Google Drive file id). */
  id: string;
  name: string;
  /** The contributing drive's display name. */
  source: string;
  dpi: number;
  /** File size in bytes as the index reports it. */
  size: number;
  extension: string;
}

export interface CommunityImageSource {
  /** Images indexed under this card name, in the backend's priority order. */
  search(name: string): Promise<CommunityCandidate[]>;
  /** The image bytes for an identifier. */
  download(id: string): Promise<Uint8Array>;
}

export const GOOGLE_DRIVE_DOWNLOAD_URL = (id: string): string =>
  `https://drive.google.com/uc?export=download&id=${encodeURIComponent(id)}`;

/** Minimum spacing between requests to the community backend and Google Drive. */
export const COMMUNITY_SPACING_MS = 250;
const COMMUNITY_TIMEOUT_MS = 30_000;

export interface MpcAutofillOptions {
  /** The backend origin, e.g. the one the MPC Autofill frontend is configured with. */
  baseUrl: string;
  fetch?: FetchFn;
  userAgent?: string;
  requestTimeoutMs?: number;
  /** Where an identifier's bytes are fetched from; defaults to the anonymous Google Drive download. */
  downloadUrl?: (id: string) => string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const SourcesResponseSchema = z.object({
  results: z.record(
    z.string(),
    z.object({ pk: z.number().int(), name: z.string(), key: z.string() }).loose(),
  ),
});

const EditorSearchResponseSchema = z.object({
  results: z.record(z.string(), z.array(z.string())),
});

const CardsResponseSchema = z.object({
  results: z.record(
    z.string(),
    z
      .object({
        identifier: z.string(),
        name: z.string(),
        dpi: z.number(),
        size: z.number(),
        extension: z.string(),
        sourceName: z.string().optional(),
        sourceVerbose: z.string().optional(),
        source: z.string().optional(),
      })
      .loose(),
  ),
});

/** The frontend's `processQuery`: lower-case, trimmed, punctuation removed, whitespace collapsed. */
export function communityQuery(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[~`!@#$%^&*(){}[\];:"'’<,.>?/\\|_+=]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function unavailable(message: string, details: { url?: string; status?: number; reason?: string }) {
  return new StructuredError("UPSTREAM_UNAVAILABLE", message, details);
}

/** A parser for one endpoint's recorded shape; a different shape means the service has changed. */
function shaped<T>(schema: z.ZodType<T>, endpoint: string): (body: unknown) => T {
  return (body) => {
    const parsed = schema.safeParse(body);
    if (parsed.success) return parsed.data;
    throw unavailable(`Community backend answered ${endpoint} in an unrecognised shape`, {
      reason: parsed.error.message,
    });
  };
}

const parseSources = shaped(SourcesResponseSchema, "2/sources");
const parseEditorSearch = shaped(EditorSearchResponseSchema, "3/editorSearch");
const parseCards = shaped(CardsResponseSchema, "2/cards");

export class MpcAutofillCommunitySource implements CommunityImageSource {
  private readonly baseUrl: string;
  private readonly fetchFn: FetchFn;
  private readonly userAgent: string;
  private readonly requestTimeoutMs: number;
  private readonly downloadUrl: (id: string) => string;
  private readonly throttle: Throttle;
  private sources: Promise<Array<[number, boolean]>> | undefined;

  constructor(options: MpcAutofillOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchFn = options.fetch ?? fetch;
    this.userAgent = options.userAgent ?? USER_AGENT;
    this.requestTimeoutMs = options.requestTimeoutMs ?? COMMUNITY_TIMEOUT_MS;
    this.downloadUrl = options.downloadUrl ?? GOOGLE_DRIVE_DOWNLOAD_URL;
    this.throttle = new Throttle({
      minSpacingMs: COMMUNITY_SPACING_MS,
      sleep: options.sleep,
      now: options.now,
    });
  }

  async search(name: string): Promise<CommunityCandidate[]> {
    const query = communityQuery(name);
    if (query === "") return [];
    const sources = await this.loadSources();
    const search = parseEditorSearch(
      await this.postJson("/3/editorSearch/", {
        searchSettings: {
          searchTypeSettings: { fuzzySearch: false, filterCardbacks: false },
          sourceSettings: { sources },
          filterSettings: {
            minimumDPI: 0,
            maximumDPI: 1500,
            maximumSize: 30,
            languages: [],
            includesTags: [],
            excludesTags: [],
          },
        },
        queries: { [query]: { query, cardType: "CARD" } },
      }),
    );
    const ids = search.results[query] ?? [];
    if (ids.length === 0) return [];
    const cards = parseCards(await this.postJson("/2/cards/", { cardIdentifiers: ids }));
    const candidates: CommunityCandidate[] = [];
    for (const id of ids) {
      const document = cards.results[id];
      if (!document) continue;
      candidates.push({
        id: document.identifier,
        name: document.name,
        source: document.sourceName ?? document.sourceVerbose ?? document.source ?? "",
        dpi: document.dpi,
        size: document.size,
        extension: document.extension,
      });
    }
    return candidates;
  }

  async download(id: string): Promise<Uint8Array> {
    const url = this.downloadUrl(id);
    const response = await this.send(url, { headers: { Accept: "image/*" } });
    const type = response.headers.get("content-type") ?? "";
    if (type && !type.startsWith("image/") && !type.startsWith("application/octet-stream")) {
      throw unavailable(`Community image ${id} answered with ${type}, not an image`, { url });
    }
    try {
      return new Uint8Array(await response.arrayBuffer());
    } catch (cause) {
      throw unavailable(`Community image ${id} could not be read`, {
        url,
        reason: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  private loadSources(): Promise<Array<[number, boolean]>> {
    this.sources ??= this.getJson("/2/sources/")
      .then((body) => {
        const parsed = parseSources(body);
        return Object.values(parsed.results)
          .map((source) => [source.pk, true] as [number, boolean])
          .sort((a, b) => a[0] - b[0]);
      })
      .catch((error: unknown) => {
        // Let the next search retry instead of pinning a failure.
        this.sources = undefined;
        throw error;
      });
    return this.sources;
  }

  private async getJson(path: string): Promise<unknown> {
    return this.readJson(await this.send(`${this.baseUrl}${path}`, {}));
  }

  private async postJson(path: string, body: unknown): Promise<unknown> {
    return this.readJson(
      await this.send(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  private async readJson(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch (cause) {
      throw unavailable("Community backend answered with something other than JSON", {
        url: response.url || undefined,
        reason: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    await this.throttle.wait();
    let response: Response;
    try {
      response = await this.fetchFn(url, {
        ...init,
        headers: {
          "User-Agent": this.userAgent,
          Accept: "application/json",
          ...((init.headers as Record<string, string> | undefined) ?? {}),
        },
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (cause) {
      throw unavailable(`Community request failed: ${url}`, {
        url,
        reason: cause instanceof Error ? cause.message : String(cause),
      });
    }
    if (!response.ok) {
      throw unavailable(`Community backend returned ${response.status} for ${url}`, {
        url,
        status: response.status,
      });
    }
    return response;
  }
}
