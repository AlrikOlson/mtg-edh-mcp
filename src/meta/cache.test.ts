import { describe, it, expect } from "vitest";
import { CacheStore } from "./index.js";
import { StructuredError } from "../types/index.js";

/** A clock whose value the test advances explicitly. Starts nonzero (1000). */
function clock(start = 1000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("CacheStore", () => {
  it("serves a hit within TTL without re-calling the fetcher", async () => {
    const c = clock();
    const cache = new CacheStore({ now: c.now });
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return `v${calls}`;
    };

    expect(await cache.fetch("k", 1000, fetcher)).toBe("v1");
    c.advance(500); // still within TTL
    expect(await cache.fetch("k", 1000, fetcher)).toBe("v1");
    expect(calls).toBe(1); // second call served from cache
  });

  it("refetches once the TTL has expired", async () => {
    const c = clock();
    const cache = new CacheStore({ now: c.now });
    let calls = 0;
    const fetcher = async () => `v${(calls += 1)}`;

    expect(await cache.fetch("k", 1000, fetcher)).toBe("v1");
    c.advance(1500); // past TTL
    expect(await cache.fetch("k", 1000, fetcher)).toBe("v2");
    expect(calls).toBe(2);
  });

  it("serves a stale value when the fetcher fails (graceful degradation)", async () => {
    const c = clock();
    const cache = new CacheStore({ now: c.now });
    let ok = true;
    const fetcher = async () => {
      if (!ok) throw new Error("network down");
      return "fresh";
    };

    expect(await cache.fetch("k", 1000, fetcher)).toBe("fresh");
    ok = false;
    c.advance(5000); // expired AND upstream now failing
    expect(await cache.fetch("k", 1000, fetcher)).toBe("fresh"); // stale served
  });

  it("throws UPSTREAM_UNAVAILABLE when the fetcher fails with nothing cached", async () => {
    const cache = new CacheStore({ now: clock().now });
    const fetcher = async (): Promise<string> => {
      throw new Error("boom");
    };
    await expect(cache.fetch("k", 1000, fetcher)).rejects.toBeInstanceOf(StructuredError);
    await expect(cache.fetch("k", 1000, fetcher)).rejects.toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
    });
  });

  it("keys are independent and TTL is per call", async () => {
    const c = clock();
    const cache = new CacheStore({ now: c.now });
    await cache.fetch("a", 1000, async () => "a1");
    await cache.fetch("b", 10, async () => "b1");
    c.advance(50); // a still fresh (1000), b expired (10)
    expect(await cache.fetch("a", 1000, async () => "a2")).toBe("a1");
    expect(await cache.fetch("b", 10, async () => "b2")).toBe("b2");
    expect(cache.size).toBe(2);
    expect(cache.has("a")).toBe(true);
  });

  it("invalidate drops entries", async () => {
    const cache = new CacheStore({ now: clock().now });
    await cache.fetch("k", 1000, async () => "v");
    expect(cache.has("k")).toBe(true);
    cache.invalidate("k");
    expect(cache.has("k")).toBe(false);
  });
});
