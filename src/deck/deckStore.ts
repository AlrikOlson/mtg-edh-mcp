/**
 * In-memory versioned deck store (spec §2/§4).
 *
 * Long-lived, session-scoped Deck objects. Every mutation bumps `version`
 * (optimistic concurrency) and emits an onChange event so the server can notify
 * deck:// subscribers. Per-principal isolation across HTTP sessions is a separate
 * concern (p7-multitenancy); here decks are keyed by a `sessionId` that defaults
 * to "local" (the single stdio session).
 */
import { randomUUID } from "node:crypto";
import type { UserDataDriver } from "../storage/driver.js";
import { parseDeckStoreDump } from "./persistence.js";
import { StructuredError } from "../types/index.js";
import type { CommandZoneKind, Deck, Format } from "../types/index.js";

export const DEFAULT_SESSION = "local";

export interface CreateDeckInput {
  name: string;
  format?: Format;
  commanders?: readonly string[];
  command_zone_kind?: CommandZoneKind;
  /**
   * Color identity computed from the commanders (the tool layer owns the card
   * lookup). When omitted with commanders set, identity stays [] until
   * deck_set_commander — which historically rejected every colored card on the
   * next import, so the deck_create tool always passes it now.
   */
  computedColorIdentity?: Deck["computed_color_identity"];
  /** data_snapshot to stamp on the deck (from the server's snapshot provider). */
  dataSnapshot?: string;
}

/** Called after every mutation with the deck id, new version, and owning session. */
export type DeckChangeListener = (deckId: string, version: number, sessionId: string) => void;

export interface DeckStoreOptions {
  /** Durable shared backend; omitted for isolated in-memory use. */
  driver?: UserDataDriver;
  /** Injectable id generator (tests pass a deterministic one). */
  newId?: () => string;
  /** Injectable snapshot-id generator (tests pass a deterministic one). */
  newSnapshotId?: () => string;
}

/** A captured, immutable point-in-time copy of a deck (spec §5B). */
export interface DeckSnapshot {
  snapshot_id: string;
  /** The deck's `version` at capture time. */
  version: number;
  /** Deep copy of the deck as it was when snapshotted. */
  deck: Deck;
}

/** Durable outcome retained for idempotent plan retries, even after later deck deletion. */
export interface DeckPlanReceipt {
  plan_id: string;
  request_hash: string;
  deck: Deck;
  snapshot_id?: string;
}

export interface CommitDeckPlanInput {
  plan_id: string;
  request_hash: string;
  desired: Deck;
  deck_id?: string;
  expected_version?: number;
}

/**
 * Serialized store contents (release-deck-persistence). Map keys embed the
 * sessionId, so a dump/hydrate round-trip preserves per-principal isolation.
 */
export interface DeckStoreDump {
  decks: Array<[string, Deck]>;
  snapshots: Array<[string, DeckSnapshot]>;
  /** Optional for legacy dumps created before deck change plans. */
  plan_receipts?: Array<[string, DeckPlanReceipt]>;
}

export class DeckStore {
  private decks = new Map<string, Deck>();
  private snapshots = new Map<string, DeckSnapshot>();
  private planReceipts = new Map<string, DeckPlanReceipt>();
  private readonly listeners = new Set<DeckChangeListener>();
  private readonly dirtyListeners = new Set<() => void>();
  private readonly newId: () => string;
  private readonly newSnapshotId: () => string;
  private readonly driver?: UserDataDriver;
  private active = false;
  private dirty = false;
  private events: Array<[string, number, string]> = [];

  constructor(options: DeckStoreOptions = {}) {
    this.newId = options.newId ?? (() => randomUUID());
    this.newSnapshotId = options.newSnapshotId ?? (() => randomUUID());
    this.driver = options.driver;
  }

  /** Serializes read/check/write under one lock; nested synchronous calls reuse it. */
  transaction<T>(callback: () => T): T {
    if (this.active) return callback();
    const previous = this.copyDump();
    const execute = (): T => {
      this.refresh();
      this.active = true;
      this.dirty = false;
      this.events = [];
      const result = callback();
      if (result instanceof Promise) throw new Error("DeckStore transactions must be synchronous");
      if (this.dirty) this.driver?.saveDecks(this.copyDump());
      return result;
    };
    let result: T;
    try {
      result = this.driver ? this.driver.transaction(execute) : execute();
    } catch (error) {
      this.replace(previous);
      this.events = [];
      this.dirty = false;
      throw error;
    } finally {
      this.active = false;
    }
    const events = this.events;
    const dirty = this.dirty;
    this.events = [];
    this.dirty = false;
    // Observers run after durable commit. A broken observer cannot turn an
    // acknowledged commit into a tool error or prevent other notifications.
    const notify = (): void => {
      for (const event of events)
        for (const listener of this.listeners) this.notify(() => listener(...event));
      if (dirty) for (const listener of this.dirtyListeners) this.notify(listener);
    };
    if (this.driver) this.driver.afterCommit(notify);
    else notify();
    return result;
  }

  private notify(listener: () => void): void {
    try {
      listener();
    } catch (error) {
      console.error(
        `deck notification failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private refresh(): void {
    if (!this.active && this.driver) this.replace(this.driver.loadDecks());
  }

  private replace(dump: DeckStoreDump): void {
    this.decks = new Map(structuredClone(dump.decks));
    this.snapshots = new Map(structuredClone(dump.snapshots));
    this.planReceipts = new Map(structuredClone(dump.plan_receipts ?? []));
  }

  private copyDump(): DeckStoreDump {
    return structuredClone({
      decks: [...this.decks],
      snapshots: [...this.snapshots],
      ...(this.planReceipts.size > 0 ? { plan_receipts: [...this.planReceipts] } : {}),
    });
  }

  /** Subscribe to committed create/delete/update/snapshot changes. */
  onDirty(listener: () => void): () => void {
    this.dirtyListeners.add(listener);
    return () => this.dirtyListeners.delete(listener);
  }

  dump(): DeckStoreDump {
    this.refresh();
    return this.copyDump();
  }

  /** Atomically replace all deck state; migration input is strictly validated. */
  hydrate(dump: DeckStoreDump): void {
    const validated = parseDeckStoreDump(dump);
    this.transaction(() => {
      this.replace(validated);
      this.dirty = true;
    });
  }

  private key(sessionId: string, deckId: string): string {
    return `${sessionId}\0${deckId}`;
  }

  private snapshotKey(sessionId: string, deckId: string, snapshotId: string): string {
    return `${sessionId}\0${deckId}\0${snapshotId}`;
  }

  onChange(listener: DeckChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private validatePlanIdentifier(value: string, field: string): void {
    if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
      throw new StructuredError("INVALID_QUERY", `${field} must be nonempty and contain no NUL`);
    }
  }

  getPlanReceipt(planId: string, sessionId: string = DEFAULT_SESSION): DeckPlanReceipt | undefined {
    this.validatePlanIdentifier(sessionId, "sessionId");
    this.validatePlanIdentifier(planId, "plan_id");
    this.refresh();
    return structuredClone(this.planReceipts.get(this.key(sessionId, planId)));
  }

  /**
   * Commit an already validated complete plan under the shared durable lock.
   * Receipt lookup precedes deck/version checks, so a retry returns the original
   * outcome after later edits or deletion. No receipt is recorded on failure.
   */
  commitPlan(
    input: CommitDeckPlanInput,
    sessionId: string = DEFAULT_SESSION,
  ): { receipt: DeckPlanReceipt; replayed: boolean } {
    return this.transaction(() => {
      const previous = this.getPlanReceipt(input.plan_id, sessionId);
      this.validatePlanIdentifier(input.request_hash, "request_hash");
      if (previous) {
        if (previous.request_hash !== input.request_hash) {
          throw new StructuredError(
            "INVALID_QUERY",
            `plan '${input.plan_id}' was already committed with a different request`,
          );
        }
        return { receipt: previous, replayed: true };
      }

      let deck: Deck;
      let snapshotId: string | undefined;
      if (input.deck_id !== undefined) {
        this.validatePlanIdentifier(input.deck_id, "deck_id");
        const current = this.get(input.deck_id, sessionId);
        if (!current) {
          throw new StructuredError("DECK_NOT_FOUND", `unknown deck '${input.deck_id}'`);
        }
        if (
          !Number.isSafeInteger(input.expected_version) ||
          input.expected_version !== current.version
        ) {
          throw new StructuredError(
            "INVALID_QUERY",
            `expected_version must match deck '${input.deck_id}' version ${current.version}`,
          );
        }
        snapshotId = this.snapshot(input.deck_id, sessionId).snapshot_id;
        deck = this.update(input.deck_id, () => structuredClone(input.desired), sessionId);
      } else {
        if (input.expected_version !== undefined) {
          throw new StructuredError(
            "INVALID_QUERY",
            "expected_version is only valid for existing decks",
          );
        }
        const deckId = this.newId();
        this.validatePlanIdentifier(deckId, "allocated deck_id");
        const key = this.key(sessionId, deckId);
        if (this.decks.has(key)) throw new Error(`duplicate deck id '${deckId}'`);
        deck = { ...structuredClone(input.desired), deck_id: deckId, version: 1 };
        this.decks.set(key, structuredClone(deck));
        this.dirty = true;
      }
      const receipt: DeckPlanReceipt = {
        plan_id: input.plan_id,
        request_hash: input.request_hash,
        deck: structuredClone(deck),
        ...(snapshotId !== undefined ? { snapshot_id: snapshotId } : {}),
      };
      this.planReceipts.set(this.key(sessionId, input.plan_id), structuredClone(receipt));
      this.dirty = true;
      return { receipt, replayed: false };
    });
  }

  create(input: CreateDeckInput, sessionId: string = DEFAULT_SESSION): Deck {
    return this.transaction(() => {
      const deck: Deck = {
        deck_id: this.newId(),
        name: input.name,
        format: input.format ?? "commander",
        commanders: input.commanders ? [...input.commanders] : [],
        command_zone_kind: input.command_zone_kind ?? "single",
        cards: [],
        computed_color_identity: input.computedColorIdentity
          ? [...input.computedColorIdentity]
          : [],
        version: 1,
        data_snapshot: input.dataSnapshot ?? "",
      };
      const key = this.key(sessionId, deck.deck_id);
      if (this.decks.has(key)) throw new Error(`duplicate deck id '${deck.deck_id}'`);
      this.decks.set(key, structuredClone(deck));
      this.dirty = true;
      return deck;
    });
  }

  get(deckId: string, sessionId: string = DEFAULT_SESSION): Deck | undefined {
    this.refresh();
    return structuredClone(this.decks.get(this.key(sessionId, deckId)));
  }

  list(sessionId: string = DEFAULT_SESSION): Deck[] {
    this.refresh();
    const prefix = `${sessionId}\0`;
    return [...this.decks]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, deck]) => structuredClone(deck));
  }

  delete(deckId: string, sessionId: string = DEFAULT_SESSION): boolean {
    return this.transaction(() => {
      const deleted = this.decks.delete(this.key(sessionId, deckId));
      if (deleted) this.dirty = true;
      return deleted;
    });
  }

  update(deckId: string, mutator: (deck: Deck) => Deck, sessionId: string = DEFAULT_SESSION): Deck {
    return this.transaction(() => {
      const key = this.key(sessionId, deckId);
      const current = this.decks.get(key);
      if (!current) throw new StructuredError("DECK_NOT_FOUND", `unknown deck '${deckId}'`);
      const next: Deck = {
        ...mutator(structuredClone(current)),
        deck_id: deckId,
        version: current.version + 1,
      };
      this.decks.set(key, structuredClone(next));
      this.events.push([next.deck_id, next.version, sessionId]);
      this.dirty = true;
      return next;
    });
  }

  setName(deckId: string, name: string, sessionId: string = DEFAULT_SESSION): Deck {
    return this.update(deckId, (deck) => ({ ...deck, name }), sessionId);
  }

  snapshot(deckId: string, sessionId: string = DEFAULT_SESSION): DeckSnapshot {
    return this.transaction(() => {
      const deck = this.get(deckId, sessionId);
      if (!deck) throw new StructuredError("DECK_NOT_FOUND", `unknown deck '${deckId}'`);
      const snapshot: DeckSnapshot = {
        snapshot_id: this.newSnapshotId(),
        version: deck.version,
        deck,
      };
      const key = this.snapshotKey(sessionId, deckId, snapshot.snapshot_id);
      if (this.snapshots.has(key))
        throw new Error(`duplicate snapshot id '${snapshot.snapshot_id}'`);
      this.snapshots.set(key, structuredClone(snapshot));
      this.dirty = true;
      return snapshot;
    });
  }

  listSnapshots(deckId: string, sessionId: string = DEFAULT_SESSION): DeckSnapshot[] {
    this.refresh();
    const prefix = this.snapshotKey(sessionId, deckId, "");
    return [...this.snapshots]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, snapshot]) => structuredClone(snapshot));
  }

  getSnapshot(
    deckId: string,
    snapshotId: string,
    sessionId: string = DEFAULT_SESSION,
  ): DeckSnapshot | undefined {
    this.refresh();
    return structuredClone(this.snapshots.get(this.snapshotKey(sessionId, deckId, snapshotId)));
  }

  restore(deckId: string, snapshotId: string, sessionId: string = DEFAULT_SESSION): Deck {
    return this.transaction(() => {
      const snapshot = this.getSnapshot(deckId, snapshotId, sessionId);
      if (!snapshot)
        throw new StructuredError("DECK_NOT_FOUND", `unknown snapshot '${snapshotId}'`);
      return this.update(deckId, () => structuredClone(snapshot.deck), sessionId);
    });
  }
}
