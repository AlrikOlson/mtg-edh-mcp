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
