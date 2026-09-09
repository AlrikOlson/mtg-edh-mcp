import { describe, it, expect } from "vitest";
import { CacheStore, SpellbookClient, parseCombos } from "./index.js";
import { SPELLBOOK_RESPONSE_FIXTURE, SPELLBOOK_VARIANT_FIXTURE } from "./spellbook.fixture.js";

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
    for (const payload of [
      {},
      null,
      [],
      { results: { included: "wrong" } },
      { included: [null] },
    ]) {
      expect(() => parseCombos(payload)).toThrow();
    }
  });

  it("preserves all execution evidence independently from legacy name projections", () => {
    const result = parseCombos(SPELLBOOK_RESPONSE_FIXTURE);
    expect(result.included[0]).toMatchObject({
      status: "OK",
      pieces: ["Front // Back"],
      produces: ["Infinite mana"],
      uses: [
        {
          card: { id: 101, name: "Front // Back", oracle_id: "fixture-oracle-id" },
          quantity: 2,
          zone_locations: ["B", "G"],
          must_be_commander: true,
          used_face: 2,
          battlefield_card_state: "Untapped and without summoning sickness.",
          graveyard_card_state: "Above all other cards.",
          missing_fields: [],
        },
      ],
      requires: [
        {
          template: {
            id: 201,
            name: "A creature that can sacrifice itself",
            scryfall_query: "t:creature o:sacrifice",
          },
          quantity: 1,
          zone_locations: ["B"],
          must_be_commander: false,
        },
      ],
      outputs: [
        {
          feature: { id: 301, name: "Infinite mana", uncountable: true, status: "S" },
          quantity: 1,
        },
      ],
      mana_needed: "{2}{U}",
      mana_value_needed: 3,
      easy_prerequisites: "You control a creature.",
      notable_prerequisites: "Your life total is at least 5.",
      description: "1. Activate the ability.\n2. Repeat.",
      notes: "Each iteration requires an available target.",
      provider_category: "included",
      url: "https://commanderspellbook.com/combo/fixture-commander-loop/",
      source_url: "https://backend.commanderspellbook.com/find-my-combos",
      missing_fields: [],
    });
    expect(result.coverage).toMatchObject({
      status: "complete",
      provider_non_exhaustive: true,
      next: null,
      total_count: 1,
    });
  });

  it("retains all six provider categories and reports pagination as partial", () => {
    const variant = SPELLBOOK_VARIANT_FIXTURE;
    const result = parseCombos({
      next: "https://backend.commanderspellbook.com/find-my-combos?offset=1",
      results: {
        included: [variant],
        includedByChangingCommanders: [variant],
        almostIncluded: [variant],
        almostIncludedByAddingColors: [variant],
        almostIncludedByChangingCommanders: [variant],
        almostIncludedByAddingColorsAndChangingCommanders: [variant],
      },
    });
    expect(result.includedByChangingCommanders[0]?.provider_category).toBe(
      "included_by_changing_commanders",
    );
    expect(result.almostIncludedByAddingColors[0]?.provider_category).toBe(
      "almost_included_by_adding_colors",
    );
    expect(result.almostIncludedByChangingCommanders[0]?.provider_category).toBe(
      "almost_included_by_changing_commanders",
    );
    expect(result.almostIncludedByAddingColorsAndChangingCommanders[0]?.provider_category).toBe(
      "almost_included_by_adding_colors_and_changing_commanders",
    );
    expect(result.coverage.status).toBe("partial");
  });

  it("distinguishes missing sparse evidence from explicit nullable example fields", () => {
    const sparse = parseCombos(RESPONSE);
    expect(sparse.coverage.status).toBe("partial");
    expect(sparse.included[0]?.missing_fields).toEqual(
      expect.arrayContaining(["status", "requires", "mana_needed"]),
    );
    expect(sparse.included[0]?.uses[0]).toMatchObject({
      quantity: null,
      must_be_commander: null,
      used_face: null,
    });
    expect(sparse.included[0]?.uses[0]?.missing_fields).toEqual(
      expect.arrayContaining(["quantity", "must_be_commander", "used_face"]),
    );
    const example = parseCombos({
      included: [
        {
          ...SPELLBOOK_VARIANT_FIXTURE,
          status: "E",
          manaNeeded: null,
          description: null,
          uses: [
            { ...SPELLBOOK_VARIANT_FIXTURE.uses[0], usedFace: null, battlefieldCardState: null },
          ],
        },
      ],
    }).included[0];
    expect(example).toMatchObject({ status: "E", mana_needed: null, description: null });
    expect(example?.uses[0]?.used_face).toBeNull();
    expect(example?.uses[0]?.missing_fields).not.toContain("used_face");
    expect(example?.uses[0]?.battlefield_card_state).toBeNull();
  });

  it("accepts snake_case provider fields without conflating null and blank text", () => {
    const variant = parseCombos({
      almost_included: [
        {
          id: "snake",
          uses: [
            {
              card: { name: "Card", oracle_id: null },
              quantity: 1,
              zone_locations: ["H"],
              must_be_commander: false,
              used_face: null,
            },
          ],
          requires: [],
          produces: [],
          mana_needed: "",
          easy_prerequisites: null,
          notable_prerequisites: "",
          description: "",
          status: "OK",
        },
      ],
    }).almostIncluded[0];
    expect(variant).toMatchObject({
      mana_needed: "",
      easy_prerequisites: null,
      notable_prerequisites: "",
      requires: [],
    });
    expect(variant?.missing_fields).not.toContain("requires");
    expect(variant?.uses[0]).toMatchObject({
      quantity: 1,
      zone_locations: ["H"],
      must_be_commander: false,
    });
  });

  it("keeps null ingredient collections unknown and encodes provider links", () => {
    const variant = parseCombos({
      included: [{ id: "variant/with?query", uses: null, requires: null, produces: null }],
    }).included[0];
    expect(variant?.url).toBe("https://commanderspellbook.com/combo/variant%2Fwith%3Fquery/");
    expect(variant?.missing_fields).toEqual(
      expect.arrayContaining(["uses", "requires", "produces"]),
    );
    expect(variant?.requires).toEqual([]);
  });

  it("keeps missing or inconsistent pagination evidence partial", () => {
    for (const pagination of [
      { count: undefined, next: null },
      { count: null, next: null },
      { count: 1, next: undefined },
      { count: 2, next: null },
      { count: 0, next: null },
    ]) {
      expect(parseCombos({ ...SPELLBOOK_RESPONSE_FIXTURE, ...pagination }).coverage.status).toBe(
        "partial",
      );
    }
  });

  it("reports sparse and nullable produced effects as incomplete evidence", () => {
    const sparse = parseCombos({
      ...SPELLBOOK_RESPONSE_FIXTURE,
      results: {
        ...SPELLBOOK_RESPONSE_FIXTURE.results,
        included: [
          { ...SPELLBOOK_VARIANT_FIXTURE, produces: [{ feature: { name: "Infinite mana" } }] },
        ],
      },
    });
    expect(sparse.coverage.status).toBe("partial");
    expect(sparse.included[0]?.outputs[0]?.missing_fields).toEqual(
      expect.arrayContaining(["quantity", "feature.id", "feature.status"]),
    );
    expect(sparse.included[0]?.missing_fields).toContain("outputs.0.quantity");
    const nullable = parseCombos({
      ...SPELLBOOK_RESPONSE_FIXTURE,
      results: {
        ...SPELLBOOK_RESPONSE_FIXTURE.results,
        included: [
          {
            ...SPELLBOOK_VARIANT_FIXTURE,
            produces: [
              {
                feature: { id: null, name: null, uncountable: null, status: null },
                quantity: null,
              },
            ],
          },
        ],
      },
    });
    expect(nullable.coverage.status).toBe("partial");
    expect(nullable.included[0]?.outputs[0]).toMatchObject({ quantity: null, missing_fields: [] });
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

  it("reports fresh, cached and stale observations when invalid refreshes fail validation", async () => {
    let now = 1000;
    let calls = 0;
    const client = new SpellbookClient(new CacheStore({ now: () => now }), {
      ttlMs: 100,
      fetchJson: async () =>
        ++calls === 1 ? SPELLBOOK_RESPONSE_FIXTURE : { results: { included: [null] } },
    });
    expect((await client.findMyCombos([], ["Card"])).freshness).toMatchObject({
      status: "fresh",
      age_ms: 0,
    });
    now = 1050;
    expect((await client.findMyCombos([], ["Card"])).freshness).toMatchObject({
      status: "cached",
      age_ms: 50,
    });
    now = 1200;
    const stale = await client.findMyCombos([], ["Card"]);
    expect(stale.included[0]?.id).toBe(SPELLBOOK_VARIANT_FIXTURE.id);
    expect(stale.freshness).toMatchObject({ status: "stale", age_ms: 200, refresh_failed: true });
    now = 1300;
    expect((await client.findMyCombos([], ["Card"])).freshness).toMatchObject({
      status: "stale",
      age_ms: 300,
    });
    expect(calls).toBe(3);
  });

  it("rejects malformed first fetches without caching a successful empty result", async () => {
    const cache = new CacheStore();
    const client = new SpellbookClient(cache, { fetchJson: async () => ({ error: "down" }) });
    await expect(client.findMyCombos([], ["Card"])).rejects.toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
    });
    expect(cache.size).toBe(0);
  });

  it("keys caches by quantities and exact card boundaries while ignoring order", async () => {
    let calls = 0;
    const client = new SpellbookClient(new CacheStore(), {
      fetchJson: async () => {
        calls += 1;
        return RESPONSE;
      },
    });
    await client.findMyCombos([], ["A", "B"]);
    await client.findMyCombos([], ["B", "A"]);
    await client.findMyCombos([], ["A,B"]);
    await client.findMyCombos([], ["A", "A", "B"]);
    expect(calls).toBe(3);
  });

  it("sends large quantities compactly and shares caches with equivalent string inputs", async () => {
    let calls = 0;
    let body: unknown;
    const client = new SpellbookClient(new CacheStore(), {
      fetchJson: async (_url, init) => {
        calls += 1;
        body = JSON.parse(String(init?.body));
        return RESPONSE;
      },
    });
    await client.findMyCombos([], [{ card: "Card", quantity: 1_000_000 }]);
    expect(body).toEqual({ commanders: [], main: [{ card: "Card", quantity: 1_000_000 }] });
    await client.findMyCombos([], ["Card", "Card"]);
    await client.findMyCombos([], [{ card: "Card", quantity: 2 }]);
    await client.findMyCombos([], ["Card", { card: "Card", quantity: 1 }]);
    expect(calls).toBe(2);
  });

  it("rejects unsafe, nonpositive and fractional quantities before fetching", async () => {
    let calls = 0;
    const client = new SpellbookClient(new CacheStore(), {
      fetchJson: async () => {
        calls += 1;
        return RESPONSE;
      },
    });
    for (const quantity of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Infinity]) {
      await expect(client.findMyCombos([], [{ card: "Card", quantity }])).rejects.toThrow();
    }
    await expect(
      client.findMyCombos([], [{ card: "Card", quantity: Number.MAX_SAFE_INTEGER }, "Card"]),
    ).rejects.toThrow();
    expect(calls).toBe(0);
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
