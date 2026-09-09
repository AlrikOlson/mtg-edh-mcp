import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  RequestSchema,
  ResponseSchema,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  ENGINE_VERSION,
  SCHEMA_SHA256,
} from "./protocol.generated.js";
import {
  assertCompatibleHello,
  decodeRequestFrame,
  decodeResponseFrame,
  encodeRequestFrame,
  WorkerFrameDecoder,
} from "./protocol.js";

const request = {
  request_id: "hello-1",
  message: {
    type: "hello" as const,
    data: {
      protocol_version: PROTOCOL_VERSION,
      engine_version: ENGINE_VERSION,
      schema_sha256: SCHEMA_SHA256,
    },
  },
};
const response = {
  request_id: "hello-1",
  message: {
    type: "hello" as const,
    data: {
      ...request.message.data,
      max_frame_bytes: MAX_FRAME_BYTES,
      admission: false,
      execution: false,
      decisions: false,
      cancellation: false,
    },
  },
};
const body = (value: unknown) => Buffer.from(JSON.stringify(value));
const fixtureCase = z.object({
  name: z.string(),
  direction: z.enum(["request", "response"]),
  value: z.unknown(),
});
const fixture = z
  .object({
    valid: z.array(fixtureCase),
    invalid: z.array(fixtureCase),
    raw: z.array(z.string()),
  })
  .parse(
    JSON.parse(
      await readFile(new URL("../../engine/contract/fixtures.json", import.meta.url), "utf8"),
    ),
  );

describe("generated worker contract independent fixtures", () => {
  for (const testCase of fixture.valid)
    it("accepts " + testCase.name, () => {
      const schema = testCase.direction === "request" ? RequestSchema : ResponseSchema;
      expect(schema.safeParse(testCase.value).success).toBe(true);
    });
  for (const testCase of fixture.invalid)
    it("rejects " + testCase.name, () => {
      const schema = testCase.direction === "request" ? RequestSchema : ResponseSchema;
      expect(schema.safeParse(testCase.value).success).toBe(false);
    });
});

it("round trips the request and validates the correlated handshake", () => {
  expect(decodeRequestFrame(encodeRequestFrame(request).subarray(0, -1))).toEqual(request);
  expect(() => assertCompatibleHello(response, "hello-1")).not.toThrow();
  expect(() => assertCompatibleHello(response, "other")).toThrow("invalid_handshake");
  for (const field of [
    "protocol_version",
    "engine_version",
    "schema_sha256",
    "max_frame_bytes",
  ] as const) {
    const changed = structuredClone(response);
    if (field === "protocol_version" || field === "max_frame_bytes") changed.message.data[field]++;
    else changed.message.data[field] += "x";
    expect(() => assertCompatibleHello(changed, "hello-1")).toThrow("incompatible_version");
  }
});

it("rejects malformed UTF-8, invalid JSON, and excessive bytes", () => {
  expect(() => decodeResponseFrame(Buffer.from([0xff]))).toThrow("malformed_frame");
  expect(() => decodeResponseFrame(Buffer.from("{"))).toThrow("malformed_frame");
  expect(() => decodeRequestFrame(Buffer.alloc(MAX_FRAME_BYTES + 1, 32))).toThrow(
    "oversized_frame",
  );
  expect(() =>
    decodeRequestFrame(
      Buffer.concat([body(request), Buffer.alloc(MAX_FRAME_BYTES - body(request).length, 32)]),
    ),
  ).not.toThrow();
});

it("frames fragmented/coalesced replies and permits CRLF JSON whitespace", () => {
  const decoder = new WorkerFrameDecoder();
  const frame = Buffer.concat([body(response), Buffer.from("\r\n")]);
  expect(decoder.push(frame.subarray(0, 9))).toEqual([]);
  expect(decoder.push(Buffer.concat([frame.subarray(9), frame]))).toEqual([response, response]);
  expect(() => decoder.finish()).not.toThrow();
});

it("makes oversized, malformed and truncated streams terminal", () => {
  for (const first of [Buffer.alloc(MAX_FRAME_BYTES + 1, 32), Buffer.from("{\n")]) {
    const decoder = new WorkerFrameDecoder();
    expect(() => decoder.push(first)).toThrow();
    expect(() => decoder.push(Buffer.concat([body(response), Buffer.from("\n")]))).toThrow(
      "closed_decoder",
    );
  }
  const partial = new WorkerFrameDecoder();
  partial.push(body(response));
  expect(() => partial.finish()).toThrow("truncated_frame");
});

it("accepts equivalent JSON integer spellings without precision loss", () => {
  for (const spelling of ["1.0", "1e0", "1"]) {
    const raw = JSON.stringify(request).replace(
      '"protocol_version":1',
      '"protocol_version":' + spelling,
    );
    expect(decodeRequestFrame(Buffer.from(raw)).message).toEqual(request.message);
  }
});

it("matches raw integer, duplicate-key and BOM parsing rules", () => {
  for (const raw of fixture.raw) expect(() => decodeRequestFrame(Buffer.from(raw))).not.toThrow();
  const duplicate = JSON.stringify(request).replace(
    '"request_id":"hello-1"',
    '"request_id":"first","request_id":"hello-1"',
  );
  expect(decodeRequestFrame(Buffer.from(duplicate)).request_id).toBe("hello-1");
  expect(() =>
    decodeRequestFrame(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body(request)])),
  ).toThrow("malformed_frame");
});
