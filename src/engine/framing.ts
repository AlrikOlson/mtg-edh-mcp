/**
 * Bounded LF framing shared by every worker wire: one JSON document per line,
 * a byte ceiling per frame, and a decoder that fails closed the moment a frame
 * is oversized or malformed, so a desynchronised stream is discarded rather
 * than guessed at. The engine worker and the print helper's browser filler
 * both frame their stdio this way; only the document schemas differ.
 */
import { TextDecoder } from "node:util";

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Parse one frame body as JSON; `oversized_frame` and `malformed_frame` are the only errors. */
export function parseJsonFrame(bytes: Uint8Array, maxFrameBytes: number): unknown {
  if (bytes.byteLength > maxFrameBytes) throw new Error("oversized_frame");
  try {
    return JSON.parse(utf8.decode(bytes));
  } catch {
    throw new Error("malformed_frame");
  }
}

/** Encode one document as a frame with its LF delimiter; throws `oversized_frame`. */
export function encodeJsonFrame(value: unknown, maxFrameBytes: number): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length > maxFrameBytes) throw new Error("oversized_frame");
  return Buffer.concat([body, Buffer.from("\n")]);
}

/**
 * Splits a byte stream into frames and decodes each with `decode`. Once a
 * frame fails the decoder is closed: every later call throws `closed_decoder`.
 * `finish` throws `truncated_frame` when bytes are left without a delimiter.
 */
export class LineFrameDecoder<T> {
  private pending = Buffer.alloc(0);
  private failed = false;

  constructor(
    private readonly decode: (bytes: Uint8Array) => T,
    private readonly maxFrameBytes: number,
  ) {}

  push(chunk: Uint8Array): T[] {
    if (this.failed) throw new Error("closed_decoder");
    const frames: T[] = [];
    let offset = 0;
    try {
      while (offset < chunk.length) {
        const end = chunk.indexOf(10, offset);
        const stop = end < 0 ? chunk.length : end;
        const part = chunk.subarray(offset, stop);
        if (this.pending.length + part.length > this.maxFrameBytes) {
          throw new Error("oversized_frame");
        }
        this.pending = Buffer.concat([this.pending, part]);
        if (end < 0) break;
        frames.push(this.decode(this.pending));
        this.pending = Buffer.alloc(0);
        offset = end + 1;
      }
      return frames;
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
