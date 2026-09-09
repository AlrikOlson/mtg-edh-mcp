import { TextDecoder } from "node:util";
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

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function parseJson(bytes: Uint8Array): unknown {
  if (bytes.byteLength > MAX_FRAME_BYTES) throw new Error("oversized_frame");
  try {
    return JSON.parse(utf8.decode(bytes));
  } catch {
    throw new Error("malformed_frame");
  }
}

/** Decode one frame body (the LF delimiter is excluded). */
export function decodeRequestFrame(bytes: Uint8Array): Request {
  return RequestSchema.parse(parseJson(bytes));
}

export function decodeResponseFrame(bytes: Uint8Array): Response {
  return ResponseSchema.parse(parseJson(bytes));
}

export function encodeRequestFrame(request: Request): Buffer {
  const body = Buffer.from(JSON.stringify(RequestSchema.parse(request)), "utf8");
  if (body.length > MAX_FRAME_BYTES) throw new Error("oversized_frame");
  return Buffer.concat([body, Buffer.from("\n")]);
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

/** Bounded LF framing. Once framing fails the connection must be discarded. */
export class WorkerFrameDecoder {
  private pending = Buffer.alloc(0);
  private failed = false;

  push(chunk: Uint8Array): Response[] {
    if (this.failed) throw new Error("closed_decoder");
    const responses: Response[] = [];
    let offset = 0;
    try {
      while (offset < chunk.length) {
        const end = chunk.indexOf(10, offset);
        const stop = end < 0 ? chunk.length : end;
        const part = chunk.subarray(offset, stop);
        if (this.pending.length + part.length > MAX_FRAME_BYTES) {
          throw new Error("oversized_frame");
        }
        this.pending = Buffer.concat([this.pending, part]);
        if (end < 0) break;
        responses.push(decodeResponseFrame(this.pending));
        this.pending = Buffer.alloc(0);
        offset = end + 1;
      }
      return responses;
    } catch (error) {
      this.failed = true;
      this.pending = Buffer.alloc(0);
      throw error;
    }
  }

  finish(): void {
    if (this.failed) throw new Error("closed_decoder");
    this.failed = true;
    if (this.pending.length !== 0) {
      this.pending = Buffer.alloc(0);
      throw new Error("truncated_frame");
    }
  }
}
