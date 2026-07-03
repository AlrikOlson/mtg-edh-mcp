/**
 * Deck durability (release-deck-persistence): persist the {@link DeckStore}
 * to one JSON file so decks survive engine restarts.
 *
 * Writes are SYNCHRONOUS and atomic (tmp + rename): deck payloads are
 * kilobytes, and the stdio sidecar exits via `process.exit(0)` when its stdin
 * closes — an async debounced write would be dropped on that path. A trailing
 * debounce coalesces mutation bursts (the Oracle agent applies change-sets as
 * a sequence of tool calls); a sync `process.on("exit")` flush catches
 * whatever is still pending.
 *
 * Loading is best-effort: a missing or corrupt file never blocks boot — the
 * store simply starts empty (and the corrupt file is preserved as `.corrupt`
 * for post-mortem rather than silently overwritten).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { DeckStore, DeckStoreDump } from "./deckStore.js";

const DEBOUNCE_MS = 250;

/** Shape guard for a parsed decks file (tolerant — content is trusted-local). */
function isDump(value: unknown): value is DeckStoreDump {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return Array.isArray(v.decks) && Array.isArray(v.snapshots);
}

export class DeckPersister {
  private dirty = false;
  private timer: NodeJS.Timeout | undefined;
  private detach: (() => void) | undefined;
  private store: DeckStore | undefined;

  constructor(private readonly filePath: string) {}

  /**
   * Load the persisted dump into `store` (best-effort), then subscribe to its
   * dirty events for write-through. Also installs a sync exit-flush.
   */
  attach(store: DeckStore): void {
    this.store = store;
    const dump = this.load();
    if (dump) store.hydrate(dump);
    this.detach = store.onDirty(() => this.schedule());
    process.on("exit", () => this.flush());
  }

  /** Read + parse the decks file; quarantine a corrupt one instead of crashing. */
  load(): DeckStoreDump | undefined {
    if (!existsSync(this.filePath)) return undefined;
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, "utf8"));
      if (isDump(parsed)) return parsed;
      throw new Error("unexpected shape");
    } catch (err) {
      try {
        renameSync(this.filePath, `${this.filePath}.corrupt`);
      } catch {
        // Quarantine is best-effort too.
      }
      console.error(
        `decks file ${this.filePath} was unreadable and has been set aside (.corrupt): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return undefined;
    }
  }

  private schedule(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, DEBOUNCE_MS);
    // Never keep the event loop alive just for a pending flush; the exit
    // handler covers the tail write.
    this.timer.unref();
  }

  /** Write the current store contents now (atomic tmp + rename). No-op when clean. */
  flush(): void {
    if (!this.dirty || !this.store) return;
    this.dirty = false;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.store.dump()));
      renameSync(tmp, this.filePath);
    } catch (err) {
      // A failed write must never take down a tool call; retry on next dirty.
      this.dirty = true;
      console.error(
        `deck persistence write failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Unsubscribe from the store (tests). The exit hook stays; flush() is idempotent. */
  close(): void {
    this.detach?.();
    if (this.timer) clearTimeout(this.timer);
    this.flush();
  }
}
