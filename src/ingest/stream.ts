/**
 * Streaming reader for a staged bulk file (spec §3/§9 seam).
 *
 * Staged bulk files are large (default_cards is ~550MB decompressed), so we
 * stream one card at a time rather than buffering. Two on-disk shapes exist and
 * both are read here, discriminated by sniffing the first non-whitespace byte:
 *
 *  - JSONL (`[type].jsonl`, current): one card object per line, as staged from
 *    Scryfall's gzipped-JSONL export;
 *  - a single JSON array (`[type].json`, legacy): the retired bulk format, still
 *    produced by fixtures and older staged versions.
 *
 * This is the typed seam p1-index consumes to build the SQLite/FTS index.
 */
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { createInterface } from "node:readline";
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
 * True when the file's first non-whitespace byte is `[`, i.e. a JSON array
 * rather than JSONL. Reads at most a leading kilobyte.
 */
async function isJsonArrayFile(filePath: string): Promise<boolean> {
  const handle = await open(filePath, "r");
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(1024), 0, 1024, 0);
    const head = buffer.subarray(0, bytesRead).toString("utf8").trimStart();
    return head.startsWith("[");
  } finally {
    await handle.close();
  }
}

/** Async-iterate the card objects of a JSONL file, one per line. */
async function* streamJsonLines<T>(filePath: string): AsyncGenerator<T> {
  const lines = createInterface({
    input: createReadStream(filePath),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of lines) {
      const trimmed = line.trim();
      // Tolerate blank lines and a stray array wrapper from mixed producers.
      if (trimmed.length === 0 || trimmed === "[" || trimmed === "]") continue;
      yield JSON.parse(trimmed.replace(/,$/, "")) as T;
    }
  } finally {
    lines.close();
  }
}

/** Async-iterate the card objects of a JSON-array file, one element at a time. */
async function* streamJsonArray<T>(filePath: string): AsyncGenerator<T> {
  const pipelineStream = buildPipeline(filePath);
  try {
    for await (const item of pipelineStream) {
      yield (item as { key: number; value: T }).value;
    }
  } finally {
    pipelineStream.destroy();
  }
}

/**
 * Async-iterate the card objects in a staged bulk file, whichever shape it has.
 * Read/parse errors propagate, so the iterator rejects (never hangs) on
 * truncated or malformed input.
 */
export async function* streamCards<T = unknown>(filePath: string): AsyncGenerator<T> {
  const iterator = (await isJsonArrayFile(filePath))
    ? streamJsonArray<T>(filePath)
    : streamJsonLines<T>(filePath);
  yield* iterator;
}

/** Back-compat alias for {@link streamCards}; both shapes are handled. */
export const streamCardArray = streamCards;

/** Collect a staged file into an array (convenience for small files/tests). */
export async function readCardArray<T = unknown>(filePath: string): Promise<T[]> {
  const out: T[] = [];
  for await (const card of streamCards<T>(filePath)) {
    out.push(card);
  }
  return out;
}
