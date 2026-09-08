import { afterEach, describe, expect, it, vi } from "vitest";
import { CacheStore } from "./cache.js";
import { EdhrecClient } from "./edhrec.js";
import { SpellbookClient } from "./spellbook.js";
import { GameChangersClient } from "./bracket.js";

afterEach(() => vi.restoreAllMocks());

const sources = [
  {
    name: "EDHREC",
    payload: { panels: { taglinks: [{ value: "Artifacts" }] } },
    create(cache: CacheStore) {
      const client = new EdhrecClient(cache, { ttlMs: 1 });
      return () => client.profile("Test Commander");
    },
  },
  {
    name: "Commander Spellbook",
    payload: { results: { included: [{ id: "combo-1" }], almostIncluded: [] } },
    create(cache: CacheStore) {
      const client = new SpellbookClient(cache, { ttlMs: 1 });
      return () => client.findMyCombos([], ["Sol Ring"]);
    },
  },
  {
    name: "Game Changers",
    payload: { data: [{ name: "Test Card" }] },
    create(cache: CacheStore) {
      const client = new GameChangersClient(cache, { ttlMs: 1 });
      return () => client.list();
    },
  },
];

describe.each(sources)("$name deadline and recovery", ({ payload, create }) => {
  it("supplies a 30-second signal and serves stale data when the next request times out", async () => {
    let now = 0;
    let controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => controller.signal);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
      expect(init?.signal).toBe(controller.signal);
      if (init?.signal?.aborted) return Promise.reject(init.signal.reason);
      return Promise.resolve(Response.json(payload));
    });
    const call = create(new CacheStore({ now: () => now }));
    const first = await call();
    now = 2;
    controller = new AbortController();
    controller.abort(new DOMException("Request timed out", "TimeoutError"));
    expect(await call()).toEqual(first);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(timeout.mock.calls).toEqual([[30_000], [30_000]]);
  });

  it("reports a structured error when a cold request times out", async () => {
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(
      AbortSignal.abort(new DOMException("Request timed out", "TimeoutError")),
    );
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
      expect(init?.signal?.aborted).toBe(true);
      return Promise.reject(init?.signal?.reason);
    });
    await expect(create(new CacheStore())()).rejects.toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
    });
  });
});
