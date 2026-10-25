/**
 * Proxy Order Helper tools (chunk print-mcp-tools): `print_prepare`,
 * `print_update`, `print_start` and `print_status` over the shared
 * {@link PrintOrderService}. The tools translate the wire to the service and
 * back; every decision (what to print, which image, the job's status, the
 * browser fill) stays with the owners the service calls. Decks and the card
 * lookup come from the server's own session-scoped deck store and index, so
 * one principal never sees another's decks or jobs.
 *
 * `print_start` answers as soon as the fill is under way: the browser fill
 * outlives the request, and `print_status` reports its progress, completion
 * or failure. The request's cancellation never cancels a fill.
 */
import { z } from "zod";
import type { DeckStore } from "../deck/index.js";
import type { CardIndex } from "../index/index.js";
import {
  PRINT_STOCKS,
  PrintImageRefSchema,
  type PrintJobRecord,
  type PrintSettings,
} from "../print/jobStore.js";
import {
  manifestAttention,
  type PrintContext,
  type PrintOrderService,
  type PrintReview,
  type UpdatePrintInput,
} from "../print/service.js";
import { StructuredError } from "../types/errors.js";
import { mutates, READS_LOCAL, type ToolDefinition } from "./registry.js";

export const PRINT_PREPARE_TOOL = "print_prepare";
export const PRINT_UPDATE_TOOL = "print_update";
export const PRINT_START_TOOL = "print_start";
export const PRINT_STATUS_TOOL = "print_status";
export const PRINT_TOOLS = [
  PRINT_PREPARE_TOOL,
  PRINT_UPDATE_TOOL,
  PRINT_START_TOOL,
  PRINT_STATUS_TOOL,
] as const;

const WORKFLOW = "FLOW: deck_get -> print_prepare -> print_update -> print_start -> print_status.";

const JOB_ID = z.uuid();
const SETTINGS_SHAPE = {
  stock: z.enum(PRINT_STOCKS).optional(),
  foil: z.boolean().optional(),
  /** The global card back; null keeps the printer's default. */
  card_back: PrintImageRefSchema.nullable().optional(),
};
const FACES_SHAPE = z.strictObject({
  front: PrintImageRefSchema.nullable().optional(),
  back: PrintImageRefSchema.nullable().optional(),
});

function settingsOf(args: Record<string, unknown>): Partial<PrintSettings> | undefined {
  const parsed = z.object(SETTINGS_SHAPE).parse(args);
  const settings: Partial<PrintSettings> = {};
  if (parsed.stock !== undefined) settings.stock = parsed.stock;
  if (parsed.foil !== undefined) settings.foil = parsed.foil;
  if (parsed.card_back !== undefined) settings.card_back = parsed.card_back;
  return Object.keys(settings).length > 0 ? settings : undefined;
}

function printError(code: string, message: string, details: Record<string, unknown> = {}) {
  const payload = { code, message, ...details };
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function notFound(jobId: string) {
  return printError("PRINT_JOB_NOT_FOUND", `no print job ${jobId} for this caller`);
}

/** The job as clients see it; the principal is implied by the caller, never echoed. */
function presentJob(job: PrintJobRecord, review: PrintReview | null): Record<string, unknown> {
  return {
    job_id: job.job_id,
    status: job.status,
    deck: {
      deck_id: job.deck_id,
      deck_name: job.deck_name,
      version: job.deck_version,
      data_snapshot: job.data_snapshot,
    },
    total: job.manifest.total,
    settings: job.settings,
    complete: review?.complete ?? null,
    cards: review?.slots ?? null,
    card_back: review?.card_back ?? null,
    tokens: job.manifest.extras.tokens,
    attention: [...manifestAttention(job), ...(review?.attention ?? [])],
    progress: job.progress,
    failure: job.failure,
    project_name: job.project_name,
    job_dir: job.job_dir,
    created_at: job.created_at,
    updated_at: job.updated_at,
  };
}

function summarizeJob(job: PrintJobRecord): Record<string, unknown> {
  return {
    job_id: job.job_id,
    status: job.status,
    deck_id: job.deck_id,
    deck_name: job.deck_name,
    deck_version: job.deck_version,
    total: job.manifest.total,
    updated_at: job.updated_at,
  };
}

function text(message: string, structured: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: message }], structuredContent: structured };
}

export function makePrintTools(
  service: PrintOrderService,
  deckStore: DeckStore,
  index: CardIndex,
  session: string,
): ToolDefinition[] {
  const context: PrintContext = {
    deck: (deckId) => deckStore.get(deckId, session) ?? null,
    lookup: (id) => index.getCard(id),
  };
  return [
    {
      name: PRINT_PREPARE_TOOL,
      config: {
        annotations: mutates({ destructive: false, idempotent: true, openWorld: true }),
        title: "Prepare a deck for printing",
        description:
          "Turn a saved deck into a reviewable MakePlayingCards print job: physical cards counted, an image fetched per face, attention listed.\n" +
          "USE: 'prepare this deck for printing'; the same deck version returns its open job. NOT: artwork changes (print_update); the browser fill (print_start).\n" +
          `${WORKFLOW}\n` +
          "ARGS: deck_id; expected_version (conflict guard); stock, foil, card_back (image ref or null) for a new job, else the saved preset.\n" +
          "RETURNS: job_id, status, created, deck (pinned version), total, settings, complete, cards[] (slot, name, front/back refs, ready flags), card_back, tokens[] (not printed), attention[], job_dir.",
        inputSchema: {
          deck_id: z.string(),
          expected_version: z.number().int().nonnegative().optional(),
          ...SETTINGS_SHAPE,
        },
        strictInput: true,
      },
      handler: async (args) => {
        const deckId = String(args.deck_id);
        const expected = z.number().int().optional().parse(args.expected_version);
        const result = await service.prepare(session, context, {
          deck_id: deckId,
          expected_version: expected,
          settings: settingsOf(args),
        });
        switch (result.kind) {
          case "deck_not_found":
            throw new StructuredError("DECK_NOT_FOUND", `unknown deck '${deckId}'`);
          case "conflict":
            return text(
              `version conflict on ${deckId}: expected v${result.expected_version}, current v${result.current_version}`,
              {
                ok: false,
                conflict: true,
                deck_id: deckId,
                expected_version: result.expected_version,
                current_version: result.current_version,
              },
            );
          case "prepared": {
            const view = presentJob(result.job, result.review);
            const pending = (view.attention as unknown[]).length;
            return text(
              `print_prepare: job ${result.job.job_id} ${result.created ? "created" : "already open"} for ${result.job.deck_name} v${result.job.deck_version}: ${result.job.manifest.total} cards, ${pending} attention item(s)`,
              { ...view, created: result.created },
            );
          }
          default: {
            const never: never = result;
            throw new Error(`unknown prepare result ${JSON.stringify(never)}`);
          }
        }
      },
    },
    {
      name: PRINT_UPDATE_TOOL,
      config: {
        annotations: mutates({ destructive: false, idempotent: true, openWorld: true }),
        title: "Change a print job's artwork or settings",
        description:
          "Change slot artwork, the card back, stock or foil on a print job that has not started, then resolve images again.\n" +
          "USE: another printing, a local image file or a card back after reviewing print_prepare. NOT: changing the deck (deck_* tools, then prepare again); a started job.\n" +
          `${WORKFLOW}\n` +
          "ARGS: job_id; images {slot: {front?, back?} | null}, refs {kind:'printing', scryfall_id} | {kind:'file', path} | {kind:'community', id}; card_back; stock; foil; remember:true saves these as the preset.\n" +
          "RETURNS: the job view of print_prepare with new cards[], card_back, attention[]. A started job answers PRINT_JOB_LOCKED.",
        inputSchema: {
          job_id: JOB_ID,
          images: z.record(z.string().regex(/^\d+$/), FACES_SHAPE.nullable()).optional(),
          ...SETTINGS_SHAPE,
          remember: z.boolean().optional(),
        },
        strictInput: true,
      },
      handler: async (args) => {
        const jobId = JOB_ID.parse(args.job_id);
        const input: UpdatePrintInput = {
          images: z.record(z.string(), FACES_SHAPE.nullable()).optional().parse(args.images),
          settings: settingsOf(args),
          remember: args.remember === true,
        };
        const result = await service.update(session, context, jobId, input);
        switch (result.kind) {
          case "not_found":
            return notFound(jobId);
          case "locked":
            return printError(
              "PRINT_JOB_LOCKED",
              `print job ${jobId} is ${result.status}; its images and settings can no longer change`,
              { status: result.status },
            );
          case "unknown_slot":
            return printError(
              "PRINT_UNKNOWN_SLOT",
              `print job ${jobId} has no slot ${result.slot}`,
              {
                slot: result.slot,
              },
            );
          case "updated": {
            const view = presentJob(result.job, result.review);
            return text(
              `print_update: job ${jobId} ${result.review.complete ? "ready" : `has ${result.review.attention.length} face(s) without an image`}`,
              view,
            );
          }
          default: {
            const never: never = result;
            throw new Error(`unknown update result ${JSON.stringify(never)}`);
          }
        }
      },
    },
    {
      name: PRINT_START_TOOL,
      config: {
        annotations: mutates({ destructive: false, idempotent: false, openWorld: true }),
        title: "Fill the printer project in a browser",
        description:
          "Write the print project for a reviewed job and fill it into the user's MakePlayingCards account in a browser they can watch; a failed fill resumes the same project.\n" +
          "USE: after review, when attention[] is empty. NOT: paying (the user does that on the printer's preview page); a job with faces still missing images.\n" +
          `${WORKFLOW}\n` +
          "ARGS: job_id.\n" +
          "RETURNS: job_id, status (starting); the fill continues after this call. Refusals: PRINT_ATTENTION, PRINT_FILLER_UNAVAILABLE (attention[] with the install command), PRINT_FILLER_BUSY (an earlier browser is still open), PRINT_JOB_INVALID_STATUS, PRINT_ORDER_TOO_LARGE.",
        inputSchema: { job_id: JOB_ID },
        strictInput: true,
      },
      handler: async (args) => {
        // The request signal is deliberately ignored: the fill outlives its request.
        const jobId = JOB_ID.parse(args.job_id);
        const result = await service.start(session, context, jobId);
        switch (result.kind) {
          case "started":
            return text(
              `print_start: job ${jobId} is ${result.job.status}; the browser is filling project ${result.job.project_name}. Poll print_status.`,
              { job_id: jobId, status: result.job.status, project_name: result.job.project_name },
            );
          case "attention":
            return printError(
              "PRINT_ATTENTION",
              `print job ${jobId} has ${result.review.attention.length} face(s) without an image; resolve them with print_update first`,
              { status: result.job.status, attention: result.review.attention },
            );
          case "not_found":
            return notFound(jobId);
          case "invalid_status":
            return printError(
              "PRINT_JOB_INVALID_STATUS",
              `print job ${jobId} is ${result.status} and cannot be started`,
              { status: result.status },
            );
          case "too_large":
            return printError(
              "PRINT_ORDER_TOO_LARGE",
              `${result.quantity} cards exceed the printer's largest project of ${result.max}`,
              { quantity: result.quantity, max: result.max },
            );
          case "invalid":
            return printError("PRINT_PROJECT_INVALID", result.message);
          case "no_project":
            return printError("PRINT_PROJECT_MISSING", result.message);
          case "unavailable":
            return printError(
              "PRINT_FILLER_UNAVAILABLE",
              "the browser filler cannot run yet; see attention",
              { attention: result.attention },
            );
          case "busy":
            return printError(
              "PRINT_FILLER_BUSY",
              "a browser from an earlier fill is still open; close it (or finish checkout) and start again",
            );
          default: {
            const never: never = result;
            throw new Error(`unknown start result ${JSON.stringify(never)}`);
          }
        }
      },
    },
    {
      name: PRINT_STATUS_TOOL,
      config: {
        annotations: READS_LOCAL,
        title: "Read a print job",
        description:
          "Read one print job of this caller, or list the caller's jobs.\n" +
          "USE: reviewing a prepared job, polling a fill, finding retained files after a failure. NOT: changing anything (print_update, print_start).\n" +
          `${WORKFLOW}\n` +
          "ARGS: job_id (omit to list jobs, newest first).\n" +
          "RETURNS: with job_id: the job view (status, cards[], attention[] incl. worker_missing/browser_missing while startable), drift (pinned vs live deck version), notices[], progress, failure (step, message), fill (ssid, review_url, instructions), evidence (job_dir, project, cards_xml, screenshot, fill_state). Without: jobs[].",
        inputSchema: { job_id: JOB_ID.optional() },
        strictInput: true,
      },
      handler: async (args) => {
        if (args.job_id === undefined) {
          const jobs = service.list(session).map(summarizeJob);
          return text(`print_status: ${jobs.length} job(s)`, { jobs });
        }
        const jobId = JOB_ID.parse(args.job_id);
        const result = await service.status(session, context, jobId);
        if (result.kind === "not_found") return notFound(jobId);
        const view = presentJob(result.job, result.review);
        return text(
          `print_status: job ${jobId} ${result.job.status}${result.job.progress ? ` (${result.job.progress.slots_filled}/${result.job.progress.slots_total} slots)` : ""}`,
          {
            ...view,
            attention: result.attention,
            drift: result.deck,
            notices: result.notices,
            fill: result.fill,
            evidence: result.evidence,
          },
        );
      },
    },
  ];
}
