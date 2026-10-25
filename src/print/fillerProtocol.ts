/**
 * The frame vocabulary between the MCP server and the print helper's browser
 * filler worker (chunk print-mpc-filler). One JSON document per line on stdio,
 * bounded like the engine worker's frames and supervised by the same
 * {@link WorkerSupervisor} through {@link FILLER_WIRE}.
 *
 * Requests: `probe` (which browsers the worker can launch), `fill` (one job:
 * its directory, the persistent profile directory, the browser to use) and
 * `cancel` for the live fill. Replies: `probe_result`, streamed `event`s with
 * the step and slot progress, the `outcome` (filled, failed with evidence, or
 * cancelled), and `released` once the worker has let go of the browser. The
 * outcome is not the end of a fill: the worker keeps the browser open for the
 * user to review and pay, and `released` is what ends the request. An
 * `invalid` reply with a null request id answers a line the worker could not
 * read.
 *
 * {@link serveFillerFrames} is the worker side of this contract, written over
 * plain streams so it is testable without a process or a browser.
 */
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { z } from "zod";
import { LineFrameDecoder, encodeJsonFrame, parseJsonFrame } from "../engine/framing.js";
import type { WorkerFrameReader, WorkerWire } from "../engine/supervisor.js";

export const FILLER_PROTOCOL_VERSION = 1;
/** Frames carry paths and short messages; a screenshot never travels inline. */
export const FILLER_MAX_FRAME_BYTES = 64 * 1024;
/** What installs Playwright's bundled Chromium when no browser is present. */
export const BROWSER_INSTALL_COMMAND = "npx playwright install chromium";

export const FillerBrowserSchema = z.enum(["chrome", "chromium"]);
/** `chrome`: the system Google Chrome through Playwright's channel; `chromium`: Playwright's bundled build. */
export type FillerBrowser = z.infer<typeof FillerBrowserSchema>;

export const FILL_STEPS = [
  "sign_in",
  "find_saved_project",
  "define_project",
  "reopen_project",
  "fronts_mode",
  "upload_front",
  "place_front",
  "save_project",
  "to_backs",
  "backs_mode",
  "upload_back",
  "place_back",
  "to_review",
] as const;
export const FillStepSchema = z.enum(FILL_STEPS);
export type FillStep = z.infer<typeof FillStepSchema>;

export const FillerFillRequestSchema = z.strictObject({
  /** The stored job's directory holding project.json and the images. */
  job_dir: z.string().min(1),
  /** The persistent browser profile that keeps the printer login. */
  profile_dir: z.string().min(1),
  browser: FillerBrowserSchema,
  /** Headless only for tests against a fixture site; the user must see the real browser. */
  headless: z.boolean(),
  /** Override of the printer's base URL for a fixture site; null for the real printer. */
  site_url: z.string().url().nullable(),
});
export type FillerFillRequest = z.infer<typeof FillerFillRequestSchema>;

export const FillerRequestMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("probe"), data: z.strictObject({}) }),
  z.strictObject({ type: z.literal("fill"), data: FillerFillRequestSchema }),
  z.strictObject({
    type: z.literal("cancel"),
    data: z.strictObject({ run_request_id: z.string().min(1) }),
  }),
]);
export type FillerRequestMessage = z.infer<typeof FillerRequestMessageSchema>;

export const FillerRequestSchema = z.strictObject({
  request_id: z.string().min(1),
  message: FillerRequestMessageSchema,
});
export type FillerRequest = z.infer<typeof FillerRequestSchema>;

const BrowserAvailabilitySchema = z.strictObject({
  available: z.boolean(),
  executable: z.string().nullable(),
});

export const FillerProbeSchema = z.strictObject({
  protocol_version: z.literal(FILLER_PROTOCOL_VERSION),
  platform: z.string(),
  playwright_version: z.string(),
  chromium: BrowserAvailabilitySchema,
  chrome: BrowserAvailabilitySchema,
  /** What installs the bundled browser when neither is present. */
  install_command: z.string(),
});
export type FillerProbe = z.infer<typeof FillerProbeSchema>;

export const FillerEventSchema = z.strictObject({
  step: FillStepSchema,
  slots_filled: z.number().int().nonnegative(),
  slots_total: z.number().int().nonnegative(),
  message: z.string(),
});
export type FillerEvent = z.infer<typeof FillerEventSchema>;

export const FillerOutcomeSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("filled"),
    data: z.strictObject({
      ssid: z.string().nullable(),
      project_name: z.string(),
      slots_total: z.number().int().nonnegative(),
      review_url: z.string().nullable(),
    }),
  }),
  z.strictObject({
    type: z.literal("failed"),
    data: z.strictObject({
      step: FillStepSchema.nullable(),
      message: z.string(),
      /** Absolute path of the screenshot in the job directory, when one could be taken. */
      screenshot: z.string().nullable(),
      /** How to finish by hand: the saved project, the retained files, the fallback. */
      instructions: z.string(),
    }),
  }),
  z.strictObject({
    type: z.literal("cancelled"),
    data: z.strictObject({ step: FillStepSchema.nullable() }),
  }),
]);
export type FillerOutcome = z.infer<typeof FillerOutcomeSchema>;
export type FillerFilled = Extract<FillerOutcome, { type: "filled" }>["data"];
export type FillerFailed = Extract<FillerOutcome, { type: "failed" }>["data"];

export const FillerReplyMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("probe_result"), data: FillerProbeSchema }),
  z.strictObject({ type: z.literal("event"), data: FillerEventSchema }),
  z.strictObject({ type: z.literal("outcome"), data: FillerOutcomeSchema }),
  z.strictObject({ type: z.literal("released"), data: z.strictObject({}) }),
  z.strictObject({ type: z.literal("invalid"), data: z.strictObject({ message: z.string() }) }),
]);
export type FillerReplyMessage = z.infer<typeof FillerReplyMessageSchema>;

export const FillerReplySchema = z.strictObject({
  request_id: z.string().nullable(),
  message: FillerReplyMessageSchema,
});
export type FillerReply = z.infer<typeof FillerReplySchema>;

export function decodeFillerReply(bytes: Uint8Array): FillerReply {
  return FillerReplySchema.parse(parseJsonFrame(bytes, FILLER_MAX_FRAME_BYTES));
}

export function encodeFillerReply(reply: FillerReply): Buffer {
  return encodeJsonFrame(FillerReplySchema.parse(reply), FILLER_MAX_FRAME_BYTES);
}

export function encodeFillerRequest(request: FillerRequest): Buffer {
  return encodeJsonFrame(FillerRequestSchema.parse(request), FILLER_MAX_FRAME_BYTES);
}

/** The filler's frames for the shared supervisor. */
export const FILLER_WIRE: WorkerWire<FillerRequestMessage, FillerReply> = Object.freeze({
  createDecoder: (): WorkerFrameReader<FillerReply> =>
    new LineFrameDecoder(decodeFillerReply, FILLER_MAX_FRAME_BYTES),
  encodeRequest: (frame: { request_id: string; message: FillerRequestMessage }): Buffer =>
    encodeFillerRequest(frame),
  replyRequestId: (reply: FillerReply): string | null => reply.request_id,
  isRun: (message: FillerRequestMessage): boolean => message.type === "fill",
  cancelMessage: (runRequestId: string): FillerRequestMessage => ({
    type: "cancel",
    data: { run_request_id: runRequestId },
  }),
});

/** What the loop hands a fill so it can stop early and know when the parent lets go. */
export interface FillerHold {
  /** Aborted when the parent cancels the fill or ends the worker's input. */
  readonly signal: AbortSignal;
  /** Resolves at the same moment the signal aborts. */
  readonly whenRequested: Promise<void>;
}

export interface FillerHandlers {
  probe(): Promise<FillerProbe>;
  /**
   * Perform one fill, streaming events, and return its outcome. The loop then
   * keeps the request open (the worker keeps its browser) until the parent
   * releases it or {@link FillerHandlers.hold} resolves.
   */
  fill(
    request: FillerFillRequest,
    emit: (event: FillerEvent) => void,
    hold: FillerHold,
  ): Promise<FillerOutcome>;
  /** After the outcome: resolves when the worker's own hold ends, such as the user closing the browser. */
  hold?(hold: FillerHold): Promise<void>;
}

/**
 * The worker side: read request frames from `input`, write reply frames to
 * `output`. Resolves once the input has ended and any live fill has been
 * released. A line that is not a valid request is answered with `invalid`
 * (null request id) and reading continues; the parent decides what to do.
 */
export async function serveFillerFrames(
  input: Readable,
  output: Writable,
  handlers: FillerHandlers,
): Promise<void> {
  const write = (reply: FillerReply): void => {
    output.write(encodeFillerReply(reply));
  };
  interface LiveFill {
    requestId: string;
    controller: AbortController;
    release: () => void;
  }
  const current: { live: LiveFill | null } = { live: null };
  let liveDone: Promise<void> = Promise.resolve();
  const pendingCancelAcks: FillerReply[] = [];
  const requestRelease = (): void => {
    if (!current.live) return;
    current.live.controller.abort();
    current.live.release();
  };

  const runFill = async (requestId: string, request: FillerFillRequest): Promise<void> => {
    const controller = new AbortController();
    let release: () => void = () => {};
    const whenRequested = new Promise<void>((resolve) => {
      release = resolve;
    });
    const hold: FillerHold = { signal: controller.signal, whenRequested };
    current.live = { requestId, controller, release };
    let outcome: FillerOutcome;
    try {
      outcome = await handlers.fill(
        request,
        (event) => write({ request_id: requestId, message: { type: "event", data: event } }),
        hold,
      );
    } catch (error) {
      outcome = {
        type: "failed",
        data: {
          step: null,
          message: error instanceof Error ? error.message : String(error),
          screenshot: null,
          instructions:
            "The filler stopped unexpectedly; open the saved project in your account to continue.",
        },
      };
    }
    write({ request_id: requestId, message: { type: "outcome", data: outcome } });
    if (!controller.signal.aborted) {
      await Promise.race([whenRequested, handlers.hold?.(hold) ?? new Promise<void>(() => {})]);
    }
    write({ request_id: requestId, message: { type: "released", data: {} } });
    current.live = null;
    for (const ack of pendingCancelAcks.splice(0)) write(ack);
  };

  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.length === 0) continue;
    let request: FillerRequest;
    try {
      request = FillerRequestSchema.parse(
        parseJsonFrame(Buffer.from(line, "utf8"), FILLER_MAX_FRAME_BYTES),
      );
    } catch (error) {
      write({
        request_id: null,
        message: {
          type: "invalid",
          data: { message: error instanceof Error ? error.message : String(error) },
        },
      });
      continue;
    }
    const { request_id, message } = request;
    switch (message.type) {
      case "probe": {
        const result = await handlers.probe();
        write({ request_id, message: { type: "probe_result", data: result } });
        break;
      }
      case "fill": {
        if (current.live) {
          write({
            request_id,
            message: { type: "invalid", data: { message: "a fill is already live" } },
          });
          break;
        }
        liveDone = runFill(request_id, message.data);
        break;
      }
      case "cancel": {
        const ack: FillerReply = {
          request_id,
          message: { type: "outcome", data: { type: "cancelled", data: { step: null } } },
        };
        if (current.live && current.live.requestId === message.data.run_request_id) {
          pendingCancelAcks.push(ack);
          requestRelease();
        } else {
          write({ request_id, message: { type: "invalid", data: { message: "cancel_late" } } });
        }
        break;
      }
      default: {
        const never: never = message;
        throw new Error(`unknown request ${JSON.stringify(never)}`);
      }
    }
  }
  // Input ended: the parent is letting go of the worker and its browser.
  requestRelease();
  await liveDone;
}
