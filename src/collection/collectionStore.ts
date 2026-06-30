/**
 * In-memory, session-scoped card collection (spec §12 — "collection awareness").
 *
 * A collection is the set of oracle_ids a user owns. It is OPTIONAL: nothing in
 * the core deckbuilding primitives depends on it. card_search can filter to the
 * owned set on request (owned_only), and the collection:// resource exposes it.
 *
 * Keyed by sessionId (mirroring {@link DeckStore}) so two principals over the
 * HTTP transport keep isolated collections; the stdio session defaults to
 * "local". Quantities are intentionally not tracked — ownership is membership.
 */
export const DEFAULT_SESSION = "local";

export class CollectionStore {
  private readonly owned = new Map<string, Set<string>>();

  /** Replace the session's owned set with these oracle_ids; returns the new set. */
  set(oracleIds: Iterable<string>, sessionId: string = DEFAULT_SESSION): Set<string> {
    const set = new Set(oracleIds);
    this.owned.set(sessionId, set);
    return set;
  }

  /** Add oracle_ids to the session's owned set (creating it if absent); returns the set. */
  add(oracleIds: Iterable<string>, sessionId: string = DEFAULT_SESSION): Set<string> {
    const set = this.owned.get(sessionId) ?? new Set<string>();
    for (const id of oracleIds) set.add(id);
    this.owned.set(sessionId, set);
    return set;
  }

  /** The session's owned set (a copy, empty when none was set). */
  get(sessionId: string = DEFAULT_SESSION): Set<string> {
    return new Set(this.owned.get(sessionId) ?? []);
  }

  /** Is this oracle_id in the session's collection? */
  has(oracleId: string, sessionId: string = DEFAULT_SESSION): boolean {
    return this.owned.get(sessionId)?.has(oracleId) ?? false;
  }

  /** Number of owned cards in the session. */
  size(sessionId: string = DEFAULT_SESSION): number {
    return this.owned.get(sessionId)?.size ?? 0;
  }

  /** Clear the session's collection. */
  clear(sessionId: string = DEFAULT_SESSION): void {
    this.owned.delete(sessionId);
  }
}
