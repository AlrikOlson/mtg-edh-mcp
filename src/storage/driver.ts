import type { DeckStoreDump } from "../deck/deckStore.js";

/** Shared synchronous unit of work for the deck and collection stores. */
export interface UserDataDriver {
  transaction<T>(callback: () => T): T;
  afterCommit(callback: () => void): void;
  loadDecks(): DeckStoreDump;
  saveDecks(dump: DeckStoreDump): void;
  getCollection(sessionId: string): string[];
  setCollection(sessionId: string, oracleIds: readonly string[]): void;
}

/** The indexed columns of a print job row; `payload` is the owner's validated record. */
export interface PrintJobRow {
  job_id: string;
  principal: string;
  deck_id: string;
  deck_version: number;
  status: string;
  created_at: string;
  updated_at: string;
  payload: unknown;
}

/**
 * Durable print jobs and presets (schema version 2). Payloads are returned as
 * parsed JSON; the print job store owns their shape and validates every read.
 */
export interface PrintDataDriver {
  transaction<T>(callback: () => T): T;
  getPrintJob(principal: string, jobId: string): unknown;
  /** The principal's job for a deck version whose status is still open, or null. */
  findOpenPrintJob(principal: string, deckId: string, deckVersion: number): unknown;
  /** The principal's jobs, newest first, bounded. */
  listPrintJobs(principal: string, limit: number): unknown[];
  insertPrintJob(row: PrintJobRow): void;
  /** Replace a stored job; false when the principal has no such job. */
  updatePrintJob(
    principal: string,
    jobId: string,
    status: string,
    updatedAt: string,
    payload: unknown,
  ): boolean;
  getPrintPreset(principal: string): unknown;
  setPrintPreset(principal: string, payload: unknown): void;
}
