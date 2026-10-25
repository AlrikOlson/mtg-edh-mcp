/**
 * Print project file (Proxy Order Helper, step 4).
 *
 * Freezes a reviewed print job whose images are all resolved into the two
 * documents the rest of the helper consumes:
 *
 * - `project.json`, our own versioned project document: the printer project
 *   name, the pinned deck identity, quantity, the MakePlayingCards bracket,
 *   stock, foil, the global card back, one entry per zero-based slot naming
 *   the card in it, and the front and back images grouped by image (one file
 *   that fills several slots) with paths relative to the job directory. The
 *   browser filler (`print-mpc-filler`) reads this and nothing else.
 * - `cards.xml`, the MPC Autofill order schema (the project's wiki page
 *   "XML-Schema-Specification" and `frontend/.../downloadXML.ts`, read
 *   2026-10-25), so the user can finish with the community desktop tool when
 *   our filler is unavailable. It carries absolute paths because that tool
 *   resolves relative ids against its own working directory.
 *
 * Both documents are the same data: `renderCardsXml` is a projection of the
 * project document. Slots are zero-based and contiguous, in manifest order
 * (commanders, library entries, then the companion); a two-sided card's back
 * fills exactly its front slot and the global card back covers every other
 * back. This module never decides images or recounts the deck: it reads the
 * image selector's resolution and the manifest owner's cards. A resolution
 * with any unresolved face is refused rather than written with holes.
 */
import { mkdir } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { ScryfallImageFace } from "../ingest/live.js";
import {
  writeFileAtomically,
  type ImageAttentionItem,
  type PreparedFace,
  type PrintImageResolution,
} from "./imageSelector.js";
import { PRINT_STOCKS, type PrintImageRef, type PrintJobRecord } from "./jobStore.js";
import type { PrintCard, PrintManifest } from "./manifest.js";

export const PRINT_PROJECT_FORMAT = "mtg-edh-print-project";
export const PRINT_PROJECT_FILENAME = "project.json";
export const PRINT_CARDS_XML_FILENAME = "cards.xml";

/**
 * MakePlayingCards' order sizes for a custom deck, ascending. An order is
 * priced at the smallest bracket that holds it. Source: MPC Autofill
 * `frontend/src/common/constants.ts` (`Brackets`), read 2026-10-25.
 */
export const MPC_BRACKETS = [
  18, 36, 55, 72, 90, 108, 126, 144, 162, 180, 198, 216, 234, 396, 504, 612,
] as const;
/** The largest single project the printer accepts. */
export const MPC_PROJECT_MAX_SIZE: number = MPC_BRACKETS[15];

/** The smallest bracket at or above `quantity`, or null for an empty or oversized order. */
export function bracketFor(quantity: number): number | null {
  if (!Number.isInteger(quantity) || quantity < 1) return null;
  return MPC_BRACKETS.find((bracket) => bracket >= quantity) ?? null;
}

/** One image file and the zero-based slots it fills on its face. */
export const PrintProjectImageSchema = z.strictObject({
  /** Path relative to the job directory, with forward slashes. */
  path: z.string().min(1),
  /** The file's basename, the `name` the MPC Autofill schema carries. */
  name: z.string().min(1),
  slots: z.array(z.number().int().nonnegative()).min(1),
});
export type PrintProjectImage = z.infer<typeof PrintProjectImageSchema>;

export const PrintProjectSchema = z.strictObject({
  format: z.literal(PRINT_PROJECT_FORMAT),
  version: z.literal(1),
  job_id: z.string().min(1),
  project_name: z.string().min(1),
  deck: z.strictObject({
    deck_id: z.string().min(1),
    deck_name: z.string(),
    version: z.number().int().positive(),
    data_snapshot: z.string(),
  }),
  /** Number of physical cards, which is also the number of slots. */
  quantity: z.number().int().positive(),
  bracket: z.number().int().positive(),
  stock: z.enum(PRINT_STOCKS),
  foil: z.boolean(),
  /** The global card back, relative to the job directory; null keeps the printer's default. */
  card_back: z.string().min(1).nullable(),
  /** One entry per slot, in slot order. */
  slots: z.array(
    z.strictObject({
      slot: z.number().int().nonnegative(),
      name: z.string(),
      oracle_id: z.string(),
      source: z.enum(["commander", "library", "companion"]),
    }),
  ),
  fronts: z.array(PrintProjectImageSchema),
  backs: z.array(PrintProjectImageSchema),
});
export type PrintProject = z.infer<typeof PrintProjectSchema>;

/** The part of a stored job the project file reads; the manifest is read-only here. */
export type PrintProjectJob = Pick<
  PrintJobRecord,
  | "job_id"
  | "project_name"
  | "job_dir"
  | "deck_id"
  | "deck_name"
  | "deck_version"
  | "data_snapshot"
  | "settings"
> & { manifest: PrintManifest };

/** A face the resolution has no file for; `slot` is the manifest slot, null for the card back. */
export interface MissingFace {
  slot: number | null;
  face: ScryfallImageFace;
}

export type BuildPrintProjectResult =
  | { kind: "project"; project: PrintProject }
  | { kind: "incomplete"; attention: ImageAttentionItem[]; missing: MissingFace[] }
  | { kind: "too_large"; quantity: number; max: number }
  | { kind: "invalid"; message: string };

export type WritePrintProjectResult =
  | { kind: "written"; project: PrintProject; project_path: string; cards_xml_path: string }
  | Exclude<BuildPrintProjectResult, { kind: "project" }>;

function referenceKey(ref: PrintImageRef): string {
  switch (ref.kind) {
    case "printing":
      return `printing:${ref.scryfall_id}`;
    case "file":
      return `file:${ref.path}`;
    case "community":
      return `community:${ref.id}`;
    default: {
      const never: never = ref;
      throw new Error(`unknown image ref ${JSON.stringify(never)}`);
    }
  }
}

function jobRelative(jobDir: string, path: string): string {
  return relative(jobDir, path).split(sep).join("/");
}

/** Images of one face grouped by the reference they were produced from, in first-slot order. */
class ImageGroups {
  private readonly groups = new Map<string, PrintProjectImage>();

  constructor(private readonly jobDir: string) {}

  add(face: PreparedFace, slot: number): void {
    const key = referenceKey(face.source);
    const existing = this.groups.get(key);
    if (existing) {
      existing.slots.push(slot);
      return;
    }
    this.groups.set(key, {
      path: jobRelative(this.jobDir, face.path),
      name: basename(face.path),
      slots: [slot],
    });
  }

  toArray(): PrintProjectImage[] {
    return [...this.groups.values()];
  }
}

/**
 * Build the project document for `job` from the image selector's resolution.
 * Pure: reads the manifest and the resolved paths, writes nothing.
 */
export function buildPrintProject(
  job: PrintProjectJob,
  resolution: PrintImageResolution,
): BuildPrintProjectResult {
  const { manifest } = job;
  const physical: PrintCard[] = [
    ...manifest.cards,
    ...(manifest.extras.companion ? [manifest.extras.companion] : []),
  ];
  const missing: MissingFace[] = [];
  const slots: PrintProject["slots"] = [];
  const fronts = new ImageGroups(job.job_dir);
  const backs = new ImageGroups(job.job_dir);

  physical.forEach((printCard, slot) => {
    slots.push({
      slot,
      name: printCard.name,
      oracle_id: printCard.oracle_id,
      source: printCard.source,
    });
    const resolved = resolution.slots[String(printCard.slot)];
    if (resolved?.front) fronts.add(resolved.front, slot);
    else missing.push({ slot: printCard.slot, face: "front" });
    if (printCard.back !== null) {
      if (resolved?.back) backs.add(resolved.back, slot);
      else missing.push({ slot: printCard.slot, face: "back" });
    }
  });

  let card_back: string | null = null;
  if (job.settings.card_back !== null) {
    if (resolution.card_back) card_back = jobRelative(job.job_dir, resolution.card_back.path);
    else missing.push({ slot: null, face: "front" });
  }

  if (missing.length > 0 || !resolution.complete || resolution.attention.length > 0) {
    return { kind: "incomplete", attention: [...resolution.attention], missing };
  }

  const quantity = slots.length;
  if (quantity === 0) return { kind: "invalid", message: "The manifest has no physical cards." };
  const bracket = bracketFor(quantity);
  if (bracket === null) return { kind: "too_large", quantity, max: MPC_PROJECT_MAX_SIZE };

  const parsed = PrintProjectSchema.safeParse({
    format: PRINT_PROJECT_FORMAT,
    version: 1,
    job_id: job.job_id,
    project_name: job.project_name,
    deck: {
      deck_id: job.deck_id,
      deck_name: job.deck_name,
      version: job.deck_version,
      data_snapshot: job.data_snapshot,
    },
    quantity,
    bracket,
    stock: job.settings.stock,
    foil: job.settings.foil,
    card_back,
    slots,
    fronts: fronts.toArray(),
    backs: backs.toArray(),
  } satisfies Record<keyof PrintProject, unknown>);
  if (!parsed.success) return { kind: "invalid", message: z.prettifyError(parsed.error) };
  return { kind: "project", project: parsed.data };
}

function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

const INDENT = "    ";

function cardElements(images: readonly PrintProjectImage[], jobDir: string): string[] {
  const lines: string[] = [];
  for (const image of images) {
    lines.push(
      `${INDENT}${INDENT}<card>`,
      `${INDENT}${INDENT}${INDENT}<id>${escapeXml(resolve(jobDir, image.path))}</id>`,
      `${INDENT}${INDENT}${INDENT}<sourceType>Local File</sourceType>`,
      `${INDENT}${INDENT}${INDENT}<slots>${image.slots.join(",")}</slots>`,
      `${INDENT}${INDENT}${INDENT}<name>${escapeXml(image.name)}</name>`,
      `${INDENT}${INDENT}</card>`,
    );
  }
  return lines;
}

/**
 * The MPC Autofill `cards.xml` for `project`, with every image as an absolute
 * `Local File` path under `jobDir`. `backs` is omitted when no card has its
 * own back, as the community exporter does; `cardback` is always present and
 * empty when the printer's default back is kept. No `bracket` or `query`
 * elements: the schema has neither.
 */
export function renderCardsXml(project: PrintProject, jobDir: string): string {
  const lines: string[] = [
    "<order>",
    `${INDENT}<details>`,
    `${INDENT}${INDENT}<quantity>${project.quantity}</quantity>`,
    `${INDENT}${INDENT}<stock>${escapeXml(project.stock)}</stock>`,
    `${INDENT}${INDENT}<foil>${project.foil ? "true" : "false"}</foil>`,
    `${INDENT}</details>`,
    `${INDENT}<fronts>`,
    ...cardElements(project.fronts, jobDir),
    `${INDENT}</fronts>`,
  ];
  if (project.backs.length > 0) {
    lines.push(`${INDENT}<backs>`, ...cardElements(project.backs, jobDir), `${INDENT}</backs>`);
  }
  lines.push(
    project.card_back === null
      ? `${INDENT}<cardback/>`
      : `${INDENT}<cardback>${escapeXml(resolve(jobDir, project.card_back))}</cardback>`,
    "</order>",
  );
  return `${lines.join("\n")}\n`;
}

/**
 * Build the project document and write it with `cards.xml` into the job
 * directory, each through a temporary file and rename, so a reader never sees
 * a partial file and both are retained whatever a later step does. Nothing is
 * written when the project cannot be built.
 */
export async function writePrintProject(
  job: PrintProjectJob,
  resolution: PrintImageResolution,
): Promise<WritePrintProjectResult> {
  const built = buildPrintProject(job, resolution);
  if (built.kind !== "project") return built;
  // The job directory holds the user's artwork and order; keep it private to the user.
  await mkdir(job.job_dir, { recursive: true, mode: 0o700 });
  const project_path = join(job.job_dir, PRINT_PROJECT_FILENAME);
  const cards_xml_path = join(job.job_dir, PRINT_CARDS_XML_FILENAME);
  const encoder = new TextEncoder();
  await writeFileAtomically(
    project_path,
    encoder.encode(`${JSON.stringify(built.project, null, 2)}\n`),
  );
  await writeFileAtomically(
    cards_xml_path,
    encoder.encode(renderCardsXml(built.project, job.job_dir)),
  );
  return { kind: "written", project: built.project, project_path, cards_xml_path };
}
