/** Session-scoped ownership membership, optionally backed by durable user data. */
import type { UserDataDriver } from "../storage/driver.js";

export const DEFAULT_SESSION = "local";

export class CollectionStore {
  private owned = new Map<string, Set<string>>();
  private active = false;

  constructor(private readonly driver?: UserDataDriver) {}

  transaction<T>(callback: () => T): T {
    if (this.driver) return this.driver.transaction(callback);
    if (this.active) return callback();
    const previous = structuredClone(this.owned);
    this.active = true;
    try {
      const result = callback();
      if (result instanceof Promise)
        throw new Error("CollectionStore transactions must be synchronous");
      return result;
    } catch (error) {
      this.owned = previous;
      throw error;
    } finally {
      this.active = false;
    }
  }

  set(oracleIds: Iterable<string>, sessionId: string = DEFAULT_SESSION): Set<string> {
    return this.transaction(() => {
      const set = new Set(oracleIds);
      if (this.driver) this.driver.setCollection(sessionId, [...set]);
      else this.owned.set(sessionId, new Set(set));
      return set;
    });
  }

  add(oracleIds: Iterable<string>, sessionId: string = DEFAULT_SESSION): Set<string> {
    return this.transaction(() => this.set([...this.get(sessionId), ...oracleIds], sessionId));
  }

  get(sessionId: string = DEFAULT_SESSION): Set<string> {
    return new Set(
      this.driver ? this.driver.getCollection(sessionId) : (this.owned.get(sessionId) ?? []),
    );
  }

  has(oracleId: string, sessionId: string = DEFAULT_SESSION): boolean {
    return this.get(sessionId).has(oracleId);
  }

  size(sessionId: string = DEFAULT_SESSION): number {
    return this.get(sessionId).size;
  }

  clear(sessionId: string = DEFAULT_SESSION): void {
    this.set([], sessionId);
  }
}
