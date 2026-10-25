/**
 * Print job store (Proxy Order Helper, step 2).
 *
 * The durable owner of a print order: which deck version the user reviewed
 * (the {@link PrintManifest} as built), the image chosen for every slot, the
 * print settings, the job directory and the printer project name, and where
 * the job is in its life. Jobs live inside the user-data store (schema
 * version 2) because artwork choices and reviewed orders are authored user
 * state that must survive and restore together with the decks they print.
 *
 * Rules carried from the roadmap record (`print-job-store`, think:444):
 * - a job is pinned to deck_id, deck version and data_snapshot; a later deck
 *   mutation never changes it, and {@link deckDrift} says how far the live
 *   deck has moved;
 * - a principal preparing the same deck version while an open job exists gets
 *   that job back (no duplicate), with its directory and project name intact;
 * - jobs are invisible across principals;
 * - the saved preset (preferred printing or image per oracle id, card back,
 *   stock, foil) seeds every new job; explicit choices at prepare time win.
 *
 * Status machine: prepared -> reviewed -> starting -> filling -> filled, with
 * failed and cancelled reachable from any live step. A failed job is retried
 * in place (failed -> starting) so the filler resumes the same printer
 * project; filled and cancelled are final. Changing images or settings is
 * allowed only before the fill starts and sends a reviewed job back to
 * prepared.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import type { PrintDataDriver } from "../storage/driver.js";
import { StructuredError } from "../types/errors.js";
import type { Deck } from "../types/index.js";
import type { PrintManifest } from "./manifest.js";

export const PRINT_JOB_STATUSES = [
  "prepared",
  "reviewed",
  "starting",
  "filling",
  "filled",
  "failed",
  "cancelled",
] as const;
export type PrintJobStatus = (typeof PRINT_JOB_STATUSES)[number];

/** Statuses of a job that still owns its deck version: create() returns it instead of a new job. */
export const OPEN_PRINT_JOB_STATUSES: readonly PrintJobStatus[] = [
  "prepared",
  "reviewed",
  "starting",
  "filling",
];

export function isOpenPrintJobStatus(status: PrintJobStatus): boolean {
  return OPEN_PRINT_JOB_STATUSES.includes(status);
}

/** Statuses a job may move to from each status. */
const TRANSITIONS: Readonly<Record<PrintJobStatus, readonly PrintJobStatus[]>> = {
  prepared: ["reviewed", "cancelled"],
  reviewed: ["prepared", "starting", "cancelled"],
  starting: ["filling", "failed", "cancelled"],
  filling: ["filled", "failed", "cancelled"],
  failed: ["starting", "cancelled"],
  filled: [],
  cancelled: [],
};

/** Statuses whose images and settings may still change. */
const EDITABLE_STATUSES: ReadonlySet<PrintJobStatus> = new Set(["prepared", "reviewed"]);

/** MakePlayingCards card stocks, spelled as the MPC Autofill schema expects them. */
export const PRINT_STOCKS = [
  "(S30) Standard Smooth",
  "(S33) Superior Smooth",
  "(M31) Linen",
  "(P10) Plastic",
] as const;
export type PrintStock = (typeof PRINT_STOCKS)[number];

/**
 * Where a printed image comes from: a catalog printing by Scryfall id, a
 * user-supplied file, or a community image by its MPC Autofill identifier
 * (a Google Drive file id). The image selector resolves each to a file.
 */
export const PrintImageRefSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("printing"), scryfall_id: z.string().min(1) }),
  z.strictObject({ kind: z.literal("file"), path: z.string().min(1) }),
  z.strictObject({ kind: z.literal("community"), id: z.string().min(1) }),
]);
export type PrintImageRef = z.infer<typeof PrintImageRefSchema>;

export const PrintSettingsSchema = z.strictObject({
  stock: z.enum(PRINT_STOCKS),
  foil: z.boolean(),
  /** The global card back; null leaves the printer's default. */
  card_back: PrintImageRefSchema.nullable(),
});
export type PrintSettings = z.infer<typeof PrintSettingsSchema>;

/** The user's standing preferences, applied to every new job. */
export const PrintPresetSchema = z.strictObject({
  /** Preferred printing or image per oracle id. */
  printings: z.record(z.string().min(1), PrintImageRefSchema),
  card_back: PrintImageRefSchema.nullable(),
  stock: z.enum(PRINT_STOCKS),
  foil: z.boolean(),
});
export type PrintPreset = z.infer<typeof PrintPresetSchema>;

export const DEFAULT_PRINT_PRESET: Readonly<PrintPreset> = Object.freeze({
  printings: {},
  card_back: null,
  stock: "(S30) Standard Smooth",
  foil: false,
});

/** The images chosen for one physical card; null faces are still unresolved. */
export const PrintSlotImagesSchema = z.strictObject({
  front: PrintImageRefSchema.nullable(),
  back: PrintImageRefSchema.nullable(),
});
export type PrintSlotImages = z.infer<typeof PrintSlotImagesSchema>;

const PrintFaceSchema = z.strictObject({
  face_index: z.number().int().nonnegative(),
  source_path: z.string(),
  name: z.string(),
});

const PrintCardSchema = z.strictObject({
  slot: z.number().int().positive(),
  oracle_id: z.string(),
  name: z.string(),
  source: z.enum(["commander", "library", "companion"]),
  illegal: z.boolean(),
  front: PrintFaceSchema,
  back: PrintFaceSchema.nullable(),
});

/** The manifest exactly as the manifest owner built it; kept in step with its type at compile time. */
export const PrintManifestSchema = z.strictObject({
  deck_id: z.string(),
  deck_name: z.string(),
  version: z.number().int(),
  data_snapshot: z.string(),
  cards: z.array(PrintCardSchema),
  extras: z.strictObject({
    companion: PrintCardSchema.nullable(),
    tokens: z.array(
      z.strictObject({
        related_id: z.string(),
        name: z.string(),
        type_line: z.string(),
        from_oracle_ids: z.array(z.string()),
        selected: z.boolean(),
      }),
    ),
  }),
  total: z.number().int().nonnegative(),
  attention: z.array(
    z.strictObject({
      kind: z.enum([
        "illegal_card",
        "unknown_card",
        "missing_faces",
        "commander_in_library",
        "unknown_companion",
        "unknown_token",
      ]),
      ref: z.string(),
      slots: z.array(z.number().int()),
      message: z.string(),
    }),
  ),
}) satisfies z.ZodType<PrintManifest>;

export const PrintJobRecordSchema = z.strictObject({
  /** Record shape version, for a future in-place migration of stored rows. */
  record_version: z.literal(1),
  job_id: z.uuid(),
  principal: z.string().min(1),
  status: z.enum(PRINT_JOB_STATUSES),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
  deck_id: z.string().min(1),
  deck_name: z.string(),
  deck_version: z.number().int().positive(),
  data_snapshot: z.string(),
  manifest: PrintManifestSchema,
  /** Image choices keyed by manifest slot (as a string); every card and the companion have an entry. */
  images: z.record(z.string().regex(/^\d+$/), PrintSlotImagesSchema),
  settings: PrintSettingsSchema,
  /** Where images, the project file and the filler's evidence are kept. */
  job_dir: z.string().min(1),
  /** The printer project the filler creates or resumes. */
  project_name: z.string().min(1),
  progress: z
    .strictObject({
      slots_filled: z.number().int().nonnegative(),
      slots_total: z.number().int().nonnegative(),
    })
    .nullable(),
  failure: z.strictObject({ step: z.string().nullable(), message: z.string() }).nullable(),
});
export type PrintJobRecord = z.infer<typeof PrintJobRecordSchema>;
export type PrintJobProgress = NonNullable<PrintJobRecord["progress"]>;
export type PrintJobFailure = NonNullable<PrintJobRecord["failure"]>;

export interface CreatePrintJobInput {
  principal: string;
  /** The manifest the user reviewed; its deck identity becomes the job's pin. */
  manifest: PrintManifest;
  /** Settings chosen at prepare time; unset fields come from the preset. */
  settings?: Partial<PrintSettings>;
  /** Image choices at prepare time by slot; unset slots come from the preset. */
  images?: Readonly<Record<string, PrintSlotImages>>;
}

export interface PrintJobPatch {
  /** Per slot: new images, or null to clear the slot's choices. */
  images?: Readonly<Record<string, PrintSlotImages | null>>;
  settings?: Partial<PrintSettings>;
}

export interface PrintPresetPatch {
  /** Per oracle id: a preferred image, or null to forget it. */
  printings?: Readonly<Record<string, PrintImageRef | null>>;
  card_back?: PrintImageRef | null;
  stock?: PrintStock;
  foil?: boolean;
}

export type PrintJobUpdateResult =
  | { kind: "updated"; job: PrintJobRecord }
  | { kind: "not_found" }
  | { kind: "invalid_transition"; from: PrintJobStatus; to: PrintJobStatus }
  | { kind: "locked"; status: PrintJobStatus }
  | { kind: "unknown_slot"; slot: number };

export interface PrintJobStoreOptions {
  /** Parent directory of per-job directories (`<jobRoot>/<job_id>`). */
  jobRoot: string;
  now?: () => Date;
  newId?: () => string;
}

/** How the live deck relates to the version a job pinned. */
export interface DeckDrift {
  pinned_version: number;
  live_version: number | null;
  state: "current" | "moved_on" | "deleted";
}

/** The pinned version against the live deck (null when the deck no longer exists). */
export function deckDrift(job: PrintJobRecord, live: Deck | null): DeckDrift {
  if (live === null || live.deck_id !== job.deck_id)
    return { pinned_version: job.deck_version, live_version: null, state: "deleted" };
  return {
    pinned_version: job.deck_version,
    live_version: live.version,
    state: live.version === job.deck_version ? "current" : "moved_on",
  };
}

const UNRECORDED_FAILURE: PrintJobFailure = {
  step: null,
  message: "The fill ended without a recorded reason.",
};

function storageError(context: string, error: unknown): StructuredError<"STORAGE_ERROR"> {
  return new StructuredError(
    "STORAGE_ERROR",
    `${context}: ${error instanceof Error ? error.message : String(error)}`,
  );
}

/** `base` with every defined field of `patch` applied; undefined never overwrites. */
function withDefined<T extends object>(base: T, patch: Partial<T> | undefined): T {
  const next = { ...base };
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value !== undefined) Object.assign(next, { [key]: value });
  }
  return next;
}

/** A printing chosen for a card covers both of its faces; a file covers the front only. */
function imagesFromPreset(
  card: PrintManifest["cards"][number],
  preset: PrintPreset,
): PrintSlotImages {
  const preferred = preset.printings[card.oracle_id];
  if (!preferred) return { front: null, back: null };
  return {
    front: preferred,
    back: preferred.kind === "printing" && card.back !== null ? preferred : null,
  };
}

export class PrintJobStore {
  private readonly jobRoot: string;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly driver: PrintDataDriver,
    options: PrintJobStoreOptions,
  ) {
    this.jobRoot = options.jobRoot;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? randomUUID;
  }

  /**
   * Record a prepared job for the reviewed manifest, or return the principal's
   * open job for that deck version (`created: false`) without writing.
   */
  create(input: CreatePrintJobInput): { readonly job: PrintJobRecord; readonly created: boolean } {
    const principal = z.string().min(1).parse(input.principal);
    const { manifest } = input;
    return this.driver.transaction(() => {
      const existing = this.findOpen(principal, manifest.deck_id, manifest.version);
      if (existing) return { job: existing, created: false };
      const preset = this.getPreset(principal);
      const settings = withDefined<PrintSettings>(
        { stock: preset.stock, foil: preset.foil, card_back: preset.card_back },
        input.settings,
      );
      const images: Record<string, PrintSlotImages> = {};
      const physical = [
        ...manifest.cards,
        ...(manifest.extras.companion ? [manifest.extras.companion] : []),
      ];
      for (const card of physical) images[String(card.slot)] = imagesFromPreset(card, preset);
      for (const [slot, chosen] of Object.entries(input.images ?? {})) {
        if (!(slot in images)) throw new Error(`manifest has no slot ${slot}`);
        images[slot] = chosen;
      }
      const job_id = this.newId();
      const stamp = this.now().toISOString();
      const job = this.validate(
        {
          record_version: 1,
          job_id,
          principal,
          status: "prepared",
          created_at: stamp,
          updated_at: stamp,
          deck_id: manifest.deck_id,
          deck_name: manifest.deck_name,
          deck_version: manifest.version,
          data_snapshot: manifest.data_snapshot,
          manifest,
          images,
          settings,
          job_dir: join(this.jobRoot, job_id),
          project_name: `mtg-edh-print-${job_id.slice(0, 8)}`,
          progress: null,
          failure: null,
        },
        "Cannot create print job",
      );
      this.driver.insertPrintJob({
        job_id: job.job_id,
        principal: job.principal,
        deck_id: job.deck_id,
        deck_version: job.deck_version,
        status: job.status,
        created_at: job.created_at,
        updated_at: job.updated_at,
        payload: job,
      });
      return { job, created: true };
    });
  }

  /** A principal's job by id, or null; another principal's job is indistinguishable from none. */
  get(principal: string, jobId: string): PrintJobRecord | null {
    const value = this.driver.getPrintJob(principal, jobId);
    return value === null ? null : this.validate(value, "Cannot read print job");
  }

  /** The principal's open job for a deck version, or null. */
  findOpen(principal: string, deckId: string, deckVersion: number): PrintJobRecord | null {
    const value = this.driver.findOpenPrintJob(principal, deckId, deckVersion);
    return value === null ? null : this.validate(value, "Cannot read print job");
  }

  /** The principal's jobs, newest first. */
  list(principal: string, limit = 20): PrintJobRecord[] {
    return this.driver
      .listPrintJobs(principal, limit)
      .map((value) => this.validate(value, "Cannot read print job"));
  }

  /** Change images or settings before the fill starts; a reviewed job returns to prepared. */
  update(principal: string, jobId: string, patch: PrintJobPatch): PrintJobUpdateResult {
    return this.driver.transaction(() => {
      const job = this.get(principal, jobId);
      if (!job) return { kind: "not_found" };
      if (!EDITABLE_STATUSES.has(job.status)) return { kind: "locked", status: job.status };
      const images = { ...job.images };
      for (const [slot, chosen] of Object.entries(patch.images ?? {})) {
        if (!(slot in images)) return { kind: "unknown_slot", slot: Number(slot) };
        images[slot] = chosen ?? { front: null, back: null };
      }
      return this.save({
        ...job,
        status: "prepared",
        images,
        settings: withDefined(job.settings, patch.settings),
      });
    });
  }

  /** Move a job along its status machine, recording fill progress or the failure. */
  transition(
    principal: string,
    jobId: string,
    status: PrintJobStatus,
    extra: { progress?: PrintJobProgress; failure?: PrintJobFailure } = {},
  ): PrintJobUpdateResult {
    return this.driver.transaction(() => {
      const job = this.get(principal, jobId);
      if (!job) return { kind: "not_found" };
      if (!TRANSITIONS[job.status].includes(status))
        return { kind: "invalid_transition", from: job.status, to: status };
      return this.save({
        ...job,
        status,
        progress: extra.progress ?? job.progress,
        failure: status === "failed" ? (extra.failure ?? job.failure ?? UNRECORDED_FAILURE) : null,
      });
    });
  }

  getPreset(principal: string): PrintPreset {
    const value = this.driver.getPrintPreset(principal);
    if (value === null) return { ...DEFAULT_PRINT_PRESET, printings: {} };
    try {
      return PrintPresetSchema.parse(value);
    } catch (error) {
      throw storageError("Cannot read print preset", error);
    }
  }

  /** Merge a patch into the principal's preset; a null printing forgets that oracle id. */
  setPreset(principal: string, patch: PrintPresetPatch): PrintPreset {
    z.string().min(1).parse(principal);
    return this.driver.transaction(() => {
      const current = this.getPreset(principal);
      const printings = { ...current.printings };
      for (const [oracleId, chosen] of Object.entries(patch.printings ?? {})) {
        if (chosen === null) delete printings[oracleId];
        else printings[oracleId] = chosen;
      }
      const next = PrintPresetSchema.parse(
        withDefined<PrintPreset>(
          { ...current, printings },
          { card_back: patch.card_back, stock: patch.stock, foil: patch.foil },
        ),
      );
      this.driver.setPrintPreset(principal, next);
      return next;
    });
  }

  private save(record: PrintJobRecord): PrintJobUpdateResult {
    const job = this.validate(
      { ...record, updated_at: this.now().toISOString() },
      "Cannot save print job",
    );
    const stored = this.driver.updatePrintJob(
      job.principal,
      job.job_id,
      job.status,
      job.updated_at,
      job,
    );
    return stored ? { kind: "updated", job } : { kind: "not_found" };
  }

  private validate(value: unknown, context: string): PrintJobRecord {
    try {
      return PrintJobRecordSchema.parse(value);
    } catch (error) {
      throw storageError(context, error);
    }
  }
}
