import { LineFrameDecoder, encodeJsonFrame, parseJsonFrame } from "./framing.js";
import {
  RequestSchema,
  ResponseSchema,
  PROTOCOL_VERSION,
  ENGINE_VERSION,
  SCHEMA_SHA256,
  MAX_FRAME_BYTES,
  type Request,
  type Response,
} from "./protocol.generated.js";

function parseJson(bytes: Uint8Array): unknown {
  return parseJsonFrame(bytes, MAX_FRAME_BYTES);
}

/** Decode one frame body (the LF delimiter is excluded). */
export function decodeRequestFrame(bytes: Uint8Array): Request {
  return RequestSchema.parse(parseJson(bytes));
}

export function decodeResponseFrame(bytes: Uint8Array): Response {
  return ResponseSchema.parse(parseJson(bytes));
}

export function encodeRequestFrame(request: Request): Buffer {
  return encodeJsonFrame(RequestSchema.parse(request), MAX_FRAME_BYTES);
}

export function assertCompatibleHello(response: Response, requestId: string): void {
  if (response.request_id !== requestId || response.message.type !== "hello") {
    throw new Error("invalid_handshake");
  }
  const hello = response.message.data;
  if (
    hello.protocol_version !== PROTOCOL_VERSION ||
    hello.engine_version !== ENGINE_VERSION ||
    hello.schema_sha256 !== SCHEMA_SHA256 ||
    hello.max_frame_bytes !== MAX_FRAME_BYTES
  )
    throw new Error("incompatible_version");
}

/** Bounded LF framing of engine responses. Once framing fails the connection must be discarded. */
export class WorkerFrameDecoder extends LineFrameDecoder<Response> {
  constructor() {
    super(decodeResponseFrame, MAX_FRAME_BYTES);
  }
}
