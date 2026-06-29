import { describe, it, expect } from "vitest";
import { CacheStore, SpellbookClient, parseCombos } from "./index.js";

const RESPONSE = {
  results: {
    included: [
      {
        id: "1-2",
        uses: [{ card: { name: "Thassa's Oracle" } }, { card: { name: "Demonic Consultation" } }],
        produces: [{ feature: { name: "Win the game" } }],
        description: "Exile your library with Consultation, then cast Thassa's Oracle.",
      },
    ],
    almostIncluded: [
      {
        id: "3-4",
        uses: [{ card: { name: "Isochron Scepter" } }, { card: { name: "Dramatic Reversal" } }],
        produces: [{ feature: { name: "Infinite mana" } }],
        description: "Imprint Reversal, activate Scepter with nonland mana rocks.",
      },
    ],
  },
};

describe("parseCombos", () => {
  it("parses included + almostIncluded variants with pieces/produces/steps", () => {
    const r = parseCombos(RESPONSE);
    expect(r.included).toHaveLength(1);
    expect(r.included[0]).toMatchObject({
      id: "1-2",
      pieces: ["Thassa's Oracle", "Demonic Consultation"],
      produces: ["Win the game"],
      source: "commander_spellbook",
      confidence: "included",
    });
    expect(r.included[0]?.steps).toContain("Thassa's Oracle");
    expect(r.almostIncluded[0]).toMatchObject({ id: "3-4", confidence: "almost" });
  });

  it("is defensive against a malformed payload", () => {
    expect(parseCombos({})).toEqual({ included: [], almostIncluded: [] });
    expect(parseCombos(null)).toEqual({ included: [], almostIncluded: [] });
  });
});

describe("SpellbookClient", () => {
  it("POSTs find-my-combos and caches by deck contents", async () => {
    let calls = 0;
    let lastInit: RequestInit | undefined;
    const client = new SpellbookClient(new CacheStore({ now: () => 1000 }), {
      fetchJson: async (_url, init) => {
        calls += 1;
        lastInit = init;
        return RESPONSE;
      },
    });
    const r1 = await client.findMyCombos(["Talrand, Sky Summoner"], ["Sol Ring", "Sol Ring"]);
    await client.findMyCombos(["Talrand, Sky Summoner"], ["Sol Ring", "Sol Ring"]);
    expect(calls).toBe(1); // cached on the second identical query
    expect(lastInit?.method).toBe("POST");
    expect(r1.included).toHaveLength(1);

    // Contract guard (review #5): the live API requires {card, quantity} OBJECTS,
    // not bare name strings (the latter 400s). This assertion is what was missing
    // — the old test only checked the HTTP method, so the drift went undetected.
    const body = JSON.parse(String(lastInit?.body)) as {
      commanders: Array<{ card: string; quantity: number }>;
      main: Array<{ card: string; quantity: number }>;
    };
    expect(body.commanders).toEqual([{ card: "Talrand, Sky Summoner", quantity: 1 }]);
    expect(body.main).toEqual([{ card: "Sol Ring", quantity: 2 }]); // deduped + counted
  });

  it("throws UPSTREAM_UNAVAILABLE when the fetch fails with nothing cached", async () => {
    const client = new SpellbookClient(new CacheStore({ now: () => 1000 }), {
      fetchJson: async () => {
        throw new Error("offline");
      },
    });
    await expect(client.findMyCombos(["X"], ["Y"])).rejects.toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
    });
  });
});

// Live contract smoke (review #5): hits the real Commander Spellbook API to catch
// a future request-schema drift. Hermetic by default — set MTG_LIVE_SMOKE=1 to run.
describe.skipIf(!process.env.MTG_LIVE_SMOKE)("SpellbookClient (live)", () => {
  it("finds a known infinite combo from the live endpoint", async () => {
    const client = new SpellbookClient(new CacheStore({ now: () => 1000 }));
    const r = await client.findMyCombos([], ["Isochron Scepter", "Dramatic Reversal", "Sol Ring"]);
    expect(r.included.length).toBeGreaterThan(0);
    expect(r.included[0]?.pieces.length).toBeGreaterThan(0);
  }, 20_000);
});
