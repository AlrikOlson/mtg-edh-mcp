import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  FILLER_MAX_FRAME_BYTES,
  FILLER_PROTOCOL_VERSION,
  FILLER_WIRE,
  FillerReplySchema,
  FillerRequestSchema,
  encodeFillerReply,
  serveFillerFrames,
  type FillerFillRequest,
  type FillerProbe,
  type FillerReply,
  type FillerRequest,
} from "./fillerProtocol.js";

const fill: FillerFillRequest = {
  job_dir: "/jobs/one",
  profile_dir: "/profile",
  browser: "chromium",
  headless: true,
  site_url: null,
};

const probe: FillerProbe = {
  protocol_version: FILLER_PROTOCOL_VERSION,
  platform: "darwin",
  playwright_version: "1.64.1",
  chromium: { available: true, executable: "/cache/chromium" },
  chrome: { available: false, executable: null },
  install_command: "npx playwright install chromium",
};

function collect(output: PassThrough): FillerReply[] {
  const chunk: unknown = output.read();
  const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : "";
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => FillerReplySchema.parse(JSON.parse(line)));
}

describe("filler frames", () => {
  it("encodes a request as one JSON line and decodes replies by line", () => {
    const request: FillerRequest = { request_id: "f1", message: { type: "fill", data: fill } };
    const bytes = FILLER_WIRE.encodeRequest(request);
    expect(bytes.subarray(-1).toString()).toBe("\n");
    expect(FillerRequestSchema.parse(JSON.parse(bytes.toString("utf8").trim()))).toEqual(request);

    const decoder = FILLER_WIRE.createDecoder();
    const event: FillerReply = {
      request_id: "f1",
      message: {
        type: "event",
        data: { step: "place_front", slots_filled: 2, slots_total: 6, message: "slot 2" },
      },
    };
    const frame = encodeFillerReply(event);
    expect(decoder.push(frame.subarray(0, 7))).toEqual([]);
    expect(decoder.push(Buffer.concat([frame.subarray(7), frame]))).toEqual([event, event]);
    expect(FILLER_WIRE.replyRequestId(event)).toBe("f1");
    expect(() => decoder.finish()).not.toThrow();
  });

  it("names the fill request as the run and spells the cancel frame", () => {
    expect(FILLER_WIRE.isRun({ type: "fill", data: fill })).toBe(true);
    expect(FILLER_WIRE.isRun({ type: "probe", data: {} })).toBe(false);
    expect(FILLER_WIRE.cancelMessage("f1")).toEqual({
      type: "cancel",
      data: { run_request_id: "f1" },
    });
  });

  it("rejects oversized, malformed and unknown frames", () => {
    const decoder = FILLER_WIRE.createDecoder();
    expect(() => decoder.push(Buffer.from("{not json}\n"))).toThrow("malformed_frame");
    expect(() => decoder.push(Buffer.from("{}\n"))).toThrow("closed_decoder");
    const unknown = FILLER_WIRE.createDecoder();
    expect(() =>
      unknown.push(
        Buffer.from(`${JSON.stringify({ request_id: "x", message: { type: "nope" } })}\n`),
      ),
    ).toThrow();
    const big = FILLER_WIRE.createDecoder();
    expect(() => big.push(Buffer.alloc(FILLER_MAX_FRAME_BYTES + 1, 0x61))).toThrow(
      "oversized_frame",
    );
    expect(() =>
      FILLER_WIRE.encodeRequest({
        request_id: "f1",
        message: { type: "fill", data: { ...fill, job_dir: "x".repeat(FILLER_MAX_FRAME_BYTES) } },
      }),
    ).toThrow("oversized_frame");
    const partial = FILLER_WIRE.createDecoder();
    partial.push(Buffer.from('{"request_id":"a"'));
    expect(() => partial.finish()).toThrow("truncated_frame");
  });
});

describe("serveFillerFrames", () => {
  it("answers a probe, streams a fill's events and outcome, releases on stdin end, and rejects a malformed line", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const seen: string[] = [];
    const served = serveFillerFrames(input, output, {
      probe: async () => probe,
      fill: async (request, emit, hold) => {
        seen.push(request.job_dir);
        emit({ step: "upload_front", slots_filled: 0, slots_total: 6, message: "uploading" });
        await hold.whenRequested;
        return {
          type: "filled",
          data: { ssid: "ABC", project_name: "p", slots_total: 6, review_url: null },
        };
      },
    });
    input.write(`${JSON.stringify({ request_id: "p1", message: { type: "probe", data: {} } })}\n`);
    input.write("garbage\n");
    input.write(
      FILLER_WIRE.encodeRequest({ request_id: "f1", message: { type: "fill", data: fill } }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    input.end();
    await served;
    const replies = collect(output);
    expect(replies.map((reply) => [reply.request_id, reply.message.type])).toEqual([
      ["p1", "probe_result"],
      [null, "invalid"],
      ["f1", "event"],
      ["f1", "outcome"],
      ["f1", "released"],
    ]);
    expect(replies[0]?.message).toEqual({ type: "probe_result", data: probe });
    expect(seen).toEqual(["/jobs/one"]);
  });

  it("turns a cancel frame into an aborted fill and still releases", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const served = serveFillerFrames(input, output, {
      probe: async () => probe,
      fill: async (_request, _emit, hold) => {
        await new Promise<void>((resolve) =>
          hold.signal.addEventListener("abort", () => resolve()),
        );
        return { type: "cancelled", data: { step: "place_front" } };
      },
    });
    input.write(
      FILLER_WIRE.encodeRequest({ request_id: "f1", message: { type: "fill", data: fill } }),
    );
    input.write(
      FILLER_WIRE.encodeRequest({
        request_id: "f1.cancel",
        message: FILLER_WIRE.cancelMessage("f1"),
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    input.end();
    await served;
    const replies = collect(output);
    expect(replies.map((reply) => [reply.request_id, reply.message.type])).toEqual([
      ["f1", "outcome"],
      ["f1", "released"],
      ["f1.cancel", "outcome"],
    ]);
    expect(replies[0]?.message).toEqual({
      type: "outcome",
      data: { type: "cancelled", data: { step: "place_front" } },
    });
  });
});
