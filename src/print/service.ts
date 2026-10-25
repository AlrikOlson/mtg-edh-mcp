/**
 * Print order service (chunk print-mcp-tools): what the `print_*` tools do.
 *
 * One instance per server process, shared by every per-request HTTP server,
 * orchestrates the existing owners without re-deciding anything they own:
 *
 * - `manifest.ts` counts the physical cards of a deck version;
 * - `jobStore.ts` owns the job record, its status machine, the per-slot
 *   image choices, the settings and the user's preset;
 * - `imageSelector.ts` decides and prepares every face's image;
 * - `projectFile.ts` writes `project.json` and `cards.xml`;
 * - `filler.ts` runs the browser and moves the job through the fill.
 *
 * What this service adds: the `prepare -> review -> start -> status` flow,
 * the `review.json` it keeps in the job directory (the last image resolution
 * as the user saw it, so `print_status` stays local after a restart), the
 * background fill (`start` answers once the job is `starting`), and the
 * in-process memory of a fill's outcome (review URL, continuation
 * instructions) until the server restarts.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Deck } from "../types/index.js";
import type { CardLookup } from "../validate/index.js";
import { writeFileAtomically } from "./atomicWrite.js";
import type { FillerAttentionItem, FillerRunResult, PrintFillerService } from "./filler.js";
import { FILL_STATE_FILENAME } from "./fillProject.js";
import {
  resolvePrintImages,
  type ImageAttentionItem,
  type ImageSelectorDeps,
  type PrintImageResolution,
} from "./imageSelector.js";
import {
  deckDrift,
  PrintImageRefSchema,
  type DeckDrift,
  type PrintImageRef,
  type PrintJobRecord,
  type PrintJobStatus,
  type PrintJobStore,
  type PrintPresetPatch,
  type PrintSettings,
  type PrintSlotImages,
} from "./jobStore.js";
import { buildPrintManifest, type PrintCard } from "./manifest.js";
import {
  PRINT_CARDS_XML_FILENAME,
  PRINT_PROJECT_FILENAME,
  writePrintProject,
} from "./projectFile.js";

export const PRINT_REVIEW_FORMAT = "mtg-edh-print-review";
export const PRINT_REVIEW_FILENAME = "review.json";

/** Statuses whose images and settings may still change (the job store's rule). */
const EDITABLE: ReadonlySet<PrintJobStatus> = new Set(["prepared", "reviewed"]);
/** Statuses a fill can be started from later, so the filler's availability matters. */
const STARTABLE_LATER: ReadonlySet<PrintJobStatus> = new Set(["prepared", "reviewed", "failed"]);

/**
 * One thing the user must see before or after the fill: a manifest
 * irregularity, a face without an image, or a filler that cannot run.
 */
export const PrintAttentionItemSchema = z.strictObject({
  kind: z.string(),
  /** The oracle id or token id, `card_back`, or `filler`. */
  ref: z.string(),
  /** Manifest slots the item is about; empty for the card back and the filler. */
  slots: z.array(z.number().int()),
  face: z.enum(["front", "back"]).optional(),
  /** The card's name when the item is about a slot. */
  name: z.string().optional(),
  message: z.string(),
  /** A command the user can run to resolve it, when there is one. */
  command: z.string().optional(),
  /** For an ambiguous community match: the images that carry the exact name. */
  candidates: z
    .array(
      z.strictObject({
        id: z.string(),
        name: z.string(),
        source: z.string(),
        dpi: z.number(),
        size: z.number(),
        extension: z.string(),
      }),
    )
    .optional(),
});
export type PrintAttentionItem = z.infer<typeof PrintAttentionItemSchema>;

export const PrintReviewSlotSchema = z.strictObject({
  slot: z.number().int().positive(),
  name: z.string(),
  source: z.enum(["commander", "library", "companion"]),
  front: PrintImageRefSchema.nullable(),
  /** Null for a card with no back face of its own. */
  back: PrintImageRefSchema.nullable(),
  front_ready: z.boolean(),
  /** Null for a card with no back face of its own. */
  back_ready: z.boolean().nullable(),
});
export type PrintReviewSlot = z.infer<typeof PrintReviewSlotSchema>;

/** The last image resolution of a job, as written to `review.json`. */
export const PrintReviewSchema = z.strictObject({
  format: z.literal(PRINT_REVIEW_FORMAT),
  version: z.literal(1),
  job_id: z.string().min(1),
  reviewed_at: z.iso.datetime(),
  /** True when every face and the chosen card back has a print-ready file. */
  complete: z.boolean(),
  slots: z.array(PrintReviewSlotSchema),
  card_back: z.strictObject({ ref: PrintImageRefSchema.nullable(), ready: z.boolean() }),
  /** Faces without an image; the manifest's own attention stays on the job. */
  attention: z.array(PrintAttentionItemSchema),
});
export type PrintReview = z.infer<typeof PrintReviewSchema>;

/** The caller's view of decks and cards, already scoped to the principal. */
export interface PrintContext {
  deck(deckId: string): Deck | null;
  lookup: CardLookup;
}

export interface PreparePrintInput {
  deck_id: string;
  /** The deck version the caller reviewed; a different live version is a conflict. */
  expected_version?: number;
  /** Settings for a new job; unset fields come from the preset. Ignored for an existing open job. */
  settings?: Partial<PrintSettings>;
}

export interface UpdatePrintInput {
  /** Per slot: faces to change (an omitted face keeps its choice), or null to clear the slot. */
  images?: Readonly<
    Record<string, { front?: PrintImageRef | null; back?: PrintImageRef | null } | null>
  >;
  settings?: Partial<PrintSettings>;
  /** Save this job's settings and the changed slots' artwork as the preset for later jobs. */
  remember?: boolean;
}

export type PreparePrintResult =
  | { kind: "prepared"; job: PrintJobRecord; created: boolean; review: PrintReview }
  | { kind: "deck_not_found"; deck_id: string }
  | { kind: "conflict"; deck_id: string; expected_version: number; current_version: number };

export type UpdatePrintResult =
  | { kind: "updated"; job: PrintJobRecord; review: PrintReview }
  | { kind: "not_found" }
  | { kind: "locked"; status: PrintJobStatus }
  | { kind: "unknown_slot"; slot: number };

export type StartPrintResult =
  /** The fill is under way in the background; print_status reports it. */
  | { kind: "started"; job: PrintJobRecord }
  /** Faces still have no image; nothing was written or started. */
  | { kind: "attention"; job: PrintJobRecord; review: PrintReview }
  | { kind: "not_found" }
  | { kind: "invalid_status"; status: PrintJobStatus }
  | { kind: "too_large"; quantity: number; max: number }
  | { kind: "invalid"; message: string }
  | { kind: "no_project"; message: string }
  | { kind: "unavailable"; attention: PrintAttentionItem[] }
  | { kind: "busy" };

/** Files in the job directory that exist right now. */
export interface PrintEvidence {
  job_dir: string;
  project?: string;
  cards_xml?: string;
  /** The filler's `failure-<step>.png`, after a failed fill. */
  screenshot?: string;
  /** The filler's `fill-state.json`, once a fill has placed anything. */
  fill_state?: string;
}

/** What this process remembers of the last fill of a job. */
export interface PrintFillSummary {
  ssid: string | null;
  review_url: string | null;
  /** How to finish by hand after a failure. */
  instructions: string | null;
}

export type PrintStatusResult =
  | {
      kind: "status";
      job: PrintJobRecord;
      deck: DeckDrift;
      notices: string[];
      review: PrintReview | null;
      /** Manifest irregularities, faces without images and, while the job can still start, the filler's availability. */
      attention: PrintAttentionItem[];
      evidence: PrintEvidence;
      fill: PrintFillSummary | null;
    }
  | { kind: "not_found" };

export interface PrintOrderServiceOptions {
  jobs: PrintJobStore;
  filler: PrintFillerService;
  images: ImageSelectorDeps;
  now?: () => Date;
}

interface RunMemory {
  outcome: FillerRunResult | null;
}

function physicalCards(job: PrintJobRecord): PrintCard[] {
  return [
    ...job.manifest.cards,
    ...(job.manifest.extras.companion ? [job.manifest.extras.companion] : []),
  ];
}

function sameRef(a: PrintImageRef | null, b: PrintImageRef | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function fillerItem(item: FillerAttentionItem): PrintAttentionItem {
  return {
    kind: item.kind,
    ref: "filler",
    slots: [],
    message: item.message,
    ...(item.command === undefined ? {} : { command: item.command }),
  };
}

/** The manifest's irregularities as attention items; the cards stay in the order. */
export function manifestAttention(job: PrintJobRecord): PrintAttentionItem[] {
  const names = new Map(physicalCards(job).map((card) => [card.slot, card.name]));
  return job.manifest.attention.map((item) => {
    const first = item.slots[0];
    const name = first === undefined ? undefined : names.get(first);
    return {
      kind: item.kind,
      ref: item.ref,
      slots: [...item.slots],
      message: item.message,
      ...(name === undefined ? {} : { name }),
    };
  });
}

export class PrintOrderService {
  private readonly jobs: PrintJobStore;
  private readonly filler: PrintFillerService;
  private readonly images: ImageSelectorDeps;
  private readonly now: () => Date;
  private readonly runs = new Map<string, RunMemory>();
  private readonly background = new Set<Promise<unknown>>();

  constructor(options: PrintOrderServiceOptions) {
    this.jobs = options.jobs;
    this.filler = options.filler;
    this.images = options.images;
    this.now = options.now ?? (() => new Date());
  }

  /** The principal's jobs, newest first. */
  list(principal: string, limit?: number): PrintJobRecord[] {
    return this.jobs.list(principal, limit);
  }

  /**
   * Turn the caller's deck into a print job (or return the open job for that
   * deck version) and resolve every face's image into the job directory.
   */
  async prepare(
    principal: string,
    context: PrintContext,
    input: PreparePrintInput,
  ): Promise<PreparePrintResult> {
    const deck = context.deck(input.deck_id);
    if (!deck) return { kind: "deck_not_found", deck_id: input.deck_id };
    if (input.expected_version !== undefined && deck.version !== input.expected_version) {
      return {
        kind: "conflict",
        deck_id: input.deck_id,
        expected_version: input.expected_version,
        current_version: deck.version,
      };
    }
    const built = buildPrintManifest(deck, context.lookup);
    if (built.kind !== "manifest") throw new Error("unpinned manifest cannot conflict");
    const { job, created } = this.jobs.create({
      principal,
      manifest: built.manifest,
      settings: input.settings,
    });
    if (!created && !EDITABLE.has(job.status)) {
      // The fill is running or done: leave the files alone and report the review as it was.
      const review =
        (await this.readReview(job)) ?? (await this.review(principal, job, context.lookup)).review;
      return { kind: "prepared", job, created, review };
    }
    const reviewed = await this.review(principal, job, context.lookup);
    return { kind: "prepared", job: reviewed.job, created, review: reviewed.review };
  }

  /** Change artwork or settings on a job that has not started, then resolve again. */
  async update(
    principal: string,
    context: PrintContext,
    jobId: string,
    input: UpdatePrintInput,
  ): Promise<UpdatePrintResult> {
    const job = this.jobs.get(principal, jobId);
    if (!job) return { kind: "not_found" };
    const images: Record<string, PrintSlotImages | null> = {};
    for (const [slot, faces] of Object.entries(input.images ?? {})) {
      if (faces === null) {
        images[slot] = null;
        continue;
      }
      const current = job.images[slot] ?? { front: null, back: null };
      images[slot] = {
        front: faces.front === undefined ? current.front : faces.front,
        back: faces.back === undefined ? current.back : faces.back,
      };
    }
    const result = this.jobs.update(principal, jobId, { images, settings: input.settings });
    if (result.kind === "invalid_transition")
      throw new Error(`unexpected transition ${result.from} -> ${result.to} on update`);
    if (result.kind !== "updated") return result;
    if (input.remember) this.remember(principal, result.job, images);
    const reviewed = await this.review(principal, result.job, context.lookup);
    return { kind: "updated", job: reviewed.job, review: reviewed.review };
  }

  /**
   * Write the project file for a job whose images are all resolved and start
   * the browser fill in the background. A `failed` job is retried in place
   * with its retained project file.
   */
  async start(principal: string, context: PrintContext, jobId: string): Promise<StartPrintResult> {
    const job = this.jobs.get(principal, jobId);
    if (!job) return { kind: "not_found" };
    if (EDITABLE.has(job.status)) {
      const reviewed = await this.review(principal, job, context.lookup);
      if (!reviewed.review.complete)
        return { kind: "attention", job: reviewed.job, review: reviewed.review };
      const written = await writePrintProject(reviewed.job, reviewed.resolution);
      switch (written.kind) {
        case "written":
          break;
        case "incomplete":
          return { kind: "attention", job: reviewed.job, review: reviewed.review };
        case "too_large":
          return { kind: "too_large", quantity: written.quantity, max: written.max };
        case "invalid":
          return { kind: "invalid", message: written.message };
        default: {
          const never: never = written;
          throw new Error(`unknown project result ${JSON.stringify(never)}`);
        }
      }
      if (reviewed.job.status === "prepared") {
        const transition = this.jobs.transition(principal, jobId, "reviewed");
        if (transition.kind === "not_found") return { kind: "not_found" };
        if (transition.kind !== "updated")
          throw new Error(`cannot review job ${jobId}: ${transition.kind}`);
      }
    } else if (job.status !== "failed") {
      return { kind: "invalid_status", status: job.status };
    }
    return this.launch(principal, jobId);
  }

  /** Everything known about a job right now, without touching the network. */
  async status(
    principal: string,
    context: PrintContext,
    jobId: string,
  ): Promise<PrintStatusResult> {
    const job = this.jobs.get(principal, jobId);
    if (!job) return { kind: "not_found" };
    const drift = deckDrift(job, context.deck(job.deck_id));
    const notices: string[] = [];
    if (drift.state === "moved_on") {
      notices.push(
        `Deck "${job.deck_name}" has moved on to version ${drift.live_version} since this job pinned version ${drift.pinned_version}; the job keeps the reviewed contents. Prepare the deck again to print its current version.`,
      );
    } else if (drift.state === "deleted") {
      notices.push(
        `Deck ${job.deck_id} no longer exists for this caller; the job keeps the reviewed contents.`,
      );
    }
    const review = await this.readReview(job);
    const attention: PrintAttentionItem[] = [
      ...manifestAttention(job),
      ...(review?.attention ?? []),
    ];
    if (STARTABLE_LATER.has(job.status)) {
      const probe = await this.filler.probe();
      attention.push(...probe.attention.map(fillerItem));
    }
    return {
      kind: "status",
      job,
      deck: drift,
      notices,
      review,
      attention,
      evidence: this.evidence(job),
      fill: this.fillSummary(job),
    };
  }

  /** Release every held browser and let background fills settle. */
  async shutdown(): Promise<void> {
    await this.filler.shutdown();
    await Promise.all([...this.background]);
  }

  private async launch(principal: string, jobId: string): Promise<StartPrintResult> {
    let onStarted: (job: PrintJobRecord) => void = () => undefined;
    const started = new Promise<PrintJobRecord>((resolve) => {
      onStarted = resolve;
    });
    const memory: RunMemory = { outcome: null };
    this.runs.set(jobId, memory);
    const run = this.filler.run(principal, jobId, { onStarted }).then((result) => {
      memory.outcome = result;
      return result;
    });
    // The fill outlives this call; its rejection, if any, is observed here.
    const observed = run.catch(() => undefined);
    this.background.add(observed);
    void observed.finally(() => this.background.delete(observed));

    const first = await Promise.race([
      started.then((job) => ({ kind: "started" as const, job })),
      run.then((result) => ({ kind: "settled" as const, result })),
    ]);
    if (first.kind === "started") return { kind: "started", job: first.job };
    const { result } = first;
    switch (result.kind) {
      case "not_found":
      case "invalid_status":
      case "no_project":
      case "busy":
        return result;
      case "unavailable":
        return { kind: "unavailable", attention: result.attention.map(fillerItem) };
      case "filled":
      case "failed":
      case "cancelled":
        return { kind: "started", job: result.job };
      default: {
        const never: never = result;
        throw new Error(`unknown filler result ${JSON.stringify(never)}`);
      }
    }
  }

  /**
   * Resolve every face into the job directory, fill the job's unchosen faces
   * with the references the selector chose (a stored choice is never
   * replaced, even when it has no image), and write `review.json`.
   */
  private async review(
    principal: string,
    job: PrintJobRecord,
    lookup: CardLookup,
  ): Promise<{ job: PrintJobRecord; review: PrintReview; resolution: PrintImageResolution }> {
    const resolution = await resolvePrintImages(
      {
        manifest: job.manifest,
        images: job.images,
        card_back: job.settings.card_back,
        job_dir: job.job_dir,
        lookup,
      },
      this.images,
    );
    let current = job;
    if (EDITABLE.has(job.status)) {
      const filled: Record<string, PrintSlotImages> = {};
      for (const [slot, resolved] of Object.entries(resolution.slots)) {
        const stored = job.images[slot] ?? { front: null, back: null };
        const next: PrintSlotImages = {
          front: stored.front ?? resolved.chosen.front,
          back: stored.back ?? resolved.chosen.back,
        };
        if (!sameRef(stored.front, next.front) || !sameRef(stored.back, next.back))
          filled[slot] = next;
      }
      if (Object.keys(filled).length > 0) {
        const updated = this.jobs.update(principal, job.job_id, { images: filled });
        if (updated.kind === "updated") current = updated.job;
      }
    }
    const review = this.buildReview(current, resolution);
    await writeFileAtomically(
      join(current.job_dir, PRINT_REVIEW_FILENAME),
      new TextEncoder().encode(`${JSON.stringify(review, null, 2)}\n`),
    );
    return { job: current, review, resolution };
  }

  private buildReview(job: PrintJobRecord, resolution: PrintImageResolution): PrintReview {
    const cards = physicalCards(job);
    const names = new Map(cards.map((card) => [card.slot, card.name]));
    const slots: PrintReviewSlot[] = cards.map((card) => {
      const key = String(card.slot);
      const stored = job.images[key] ?? { front: null, back: null };
      const resolved = resolution.slots[key];
      return {
        slot: card.slot,
        name: card.name,
        source: card.source,
        front: stored.front ?? resolved?.chosen.front ?? null,
        back: card.back === null ? null : (stored.back ?? resolved?.chosen.back ?? null),
        front_ready: Boolean(resolved?.front),
        back_ready: card.back === null ? null : Boolean(resolved?.back),
      };
    });
    const attention: PrintAttentionItem[] = resolution.attention.map((item: ImageAttentionItem) => {
      const name = item.slot === null ? undefined : names.get(item.slot);
      return {
        kind: item.kind,
        ref: item.ref,
        slots: item.slot === null ? [] : [item.slot],
        face: item.face,
        message: item.message,
        ...(name === undefined ? {} : { name }),
        ...(item.candidates === undefined
          ? {}
          : { candidates: item.candidates.map((candidate) => ({ ...candidate })) }),
      };
    });
    return {
      format: PRINT_REVIEW_FORMAT,
      version: 1,
      job_id: job.job_id,
      reviewed_at: this.now().toISOString(),
      complete: resolution.complete,
      slots,
      card_back: {
        ref: job.settings.card_back,
        ready: job.settings.card_back === null ? true : resolution.card_back !== null,
      },
      attention,
    };
  }

  private async readReview(job: PrintJobRecord): Promise<PrintReview | null> {
    try {
      const text = await readFile(join(job.job_dir, PRINT_REVIEW_FILENAME), "utf8");
      const parsed = PrintReviewSchema.safeParse(JSON.parse(text));
      return parsed.success && parsed.data.job_id === job.job_id ? parsed.data : null;
    } catch {
      return null;
    }
  }

  /** Save the job's settings and the changed slots' artwork as the principal's preset. */
  private remember(
    principal: string,
    job: PrintJobRecord,
    changed: Readonly<Record<string, PrintSlotImages | null>>,
  ): void {
    const oracleBySlot = new Map(
      physicalCards(job).map((card) => [String(card.slot), card.oracle_id]),
    );
    const printings: Record<string, PrintImageRef | null> = {};
    for (const [slot, images] of Object.entries(changed)) {
      const oracleId = oracleBySlot.get(slot);
      if (oracleId === undefined) continue;
      printings[oracleId] = images?.front ?? null;
    }
    const patch: PrintPresetPatch = {
      printings,
      card_back: job.settings.card_back,
      stock: job.settings.stock,
      foil: job.settings.foil,
    };
    this.jobs.setPreset(principal, patch);
  }

  private evidence(job: PrintJobRecord): PrintEvidence {
    const evidence: PrintEvidence = { job_dir: job.job_dir };
    const project = join(job.job_dir, PRINT_PROJECT_FILENAME);
    if (existsSync(project)) evidence.project = project;
    const cardsXml = join(job.job_dir, PRINT_CARDS_XML_FILENAME);
    if (existsSync(cardsXml)) evidence.cards_xml = cardsXml;
    const outcome = this.runs.get(job.job_id)?.outcome;
    const screenshot =
      outcome?.kind === "failed" && outcome.outcome.screenshot
        ? outcome.outcome.screenshot
        : job.failure
          ? join(job.job_dir, `failure-${job.failure.step ?? "unknown"}.png`)
          : null;
    if (screenshot && existsSync(screenshot)) evidence.screenshot = screenshot;
    const fillState = join(job.job_dir, FILL_STATE_FILENAME);
    if (existsSync(fillState)) evidence.fill_state = fillState;
    return evidence;
  }

  private fillSummary(job: PrintJobRecord): PrintFillSummary | null {
    const outcome = this.runs.get(job.job_id)?.outcome;
    if (!outcome) return null;
    switch (outcome.kind) {
      case "filled":
        return {
          ssid: outcome.outcome.ssid,
          review_url: outcome.outcome.review_url,
          instructions: null,
        };
      case "failed":
        return { ssid: null, review_url: null, instructions: outcome.outcome.instructions };
      default:
        return null;
    }
  }
}
