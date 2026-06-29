/**
 * Streaming reader for a staged bulk file (spec §3/§9 seam).
 *
 * Scryfall bulk files are a single JSON array of card objects (default_cards is
 * ~525MB), so we stream-parse one element at a time rather than buffering. This
 * is the typed seam p1-index consumes to build the SQLite/FTS index.
 */
import { createReadStream } from "node:fs";
import type { Duplex } from "node:stream";
import { chain } from "stream-chain";
import { parser } from "stream-json";
import { streamArray } from "stream-json/streamers/stream-array.js";

// stream-json 3.x factories are functional `Flushable`s, not Node streams; they
// are composed into a real Duplex by `chain`. The cast bridges stream-chain's
// and stream-json's independently-versioned types at this single boundary.
function buildPipeline(filePath: string): Duplex {
  return chain([createReadStream(filePath), parser(), streamArray()] as never) as unknown as Duplex;
}

/**
 * Async-iterate the card objects in a staged JSON-array file. `chain` propagates
 * read/parse errors to the composed stream, so the iterator rejects (never
 * hangs) on truncated or malformed input.
 */
export async function* streamCardArray<T = unknown>(filePath: string): AsyncGenerator<T> {
  const pipelineStream = buildPipeline(filePath);
  try {
    for await (const item of pipelineStream) {
      yield (item as { key: number; value: T }).value;
    }
  } finally {
    pipelineStream.destroy();
  }
}

/** Collect a staged file into an array (convenience for small files/tests). */
export async function readCardArray<T = unknown>(filePath: string): Promise<T[]> {
  const out: T[] = [];
  for await (const card of streamCardArray<T>(filePath)) {
    out.push(card);
  }
  return out;
}
