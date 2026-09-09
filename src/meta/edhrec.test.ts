import { describe, it, expect } from "vitest";
import { CacheStore, EdhrecClient, slugify, parseProfile, parseThemes } from "./index.js";
import { StructuredError } from "../types/index.js";
import { edhrecMetrics } from "./edhrec.js";

const FIXTURE = {
  container: {
    json_dict: {
      cardlists: [
        {
          header: "Top Cards",
          cardviews: [
            { name: "Sol Ring", inclusion: 900, synergy: 0.05 },
            { name: "Arcane Signet", inclusion: 800, synergy: 0.2 },
          ],
        },
        {
          header: "Creatures",
          cardviews: [{ name: "Talrand, Sky Summoner", inclusion: 500, synergy: 0.9 }],
        },
      ],
    },
  },
  panels: { taglinks: [{ value: "Spellslinger" }, { value: "Counters" }] },
};

describe("slugify", () => {
  it("matches EDHREC commander slugs", () => {
    expect(slugify("Atraxa, Praetors' Voice")).toBe("atraxa-praetors-voice");
    expect(slugify("Sol Ring")).toBe("sol-ring");
    expect(slugify("Jodah, the Unifier")).toBe("jodah-the-unifier");
  });
});

describe("parseProfile / parseThemes", () => {
  it("flattens cardlists into {name, category, inclusion, synergy}", () => {
    const profile = parseProfile(FIXTURE);
    expect(profile.cards).toHaveLength(3);
    expect(profile.cards[0]).toEqual({
      name: "Sol Ring",
      category: "Top Cards",
      inclusion: 900,
      synergy: 0.05,
    });
    expect(profile.cards[2]?.category).toBe("Creatures");
    expect(profile.themes).toEqual(["Spellslinger", "Counters"]);
  });

  it("is defensive against a malformed payload", () => {
    expect(parseProfile({}).cards).toEqual([]);
    expect(parseThemes(null)).toEqual([]);
    expect(parseProfile({ container: { json_dict: { cardlists: "nope" } } }).cards).toEqual([]);
  });

  it("normalizes current deck counts while preserving raw metric provenance and scale", async () => {
    const client = new EdhrecClient(new CacheStore({ now: () => 1000 }), {
      fetchJson: async () => ({
        container: {
          json_dict: {
            cardlists: [
              {
                header: "Test",
                cardviews: [
                  {
                    name: "Wizard's Staff",
                    num_decks: 96,
                    potential_decks: 703,
                    synergy: -0.125,
                    lift: -1.5,
                  },
                ],
              },
            ],
          },
        },
      }),
    });
    const profile = await client.profileWithSource("Talrand, Sky Summoner");
    const card = profile.cards[0]!;
    expect(card).toMatchObject({
      inclusion: 96,
      inclusion_provider_field: "num_decks",
      num_decks: 96,
      potential_decks: 703,
      synergy: -0.125,
      lift: -1.5,
    });
    expect(edhrecMetrics(card, profile.source)).toEqual([
      {
        name: "inclusion",
        provider_field: "num_decks",
        value: 96,
        scale: "deck_count",
        source: profile.source,
      },
      {
        name: "potential_decks",
        provider_field: "potential_decks",
        value: 703,
        scale: "deck_count",
        source: profile.source,
      },
      {
        name: "synergy",
        provider_field: "synergy",
        value: -0.125,
        scale: "proportion_difference",
        source: profile.source,
      },
      {
        name: "lift",
        provider_field: "lift",
        value: -1.5,
        scale: "unknown",
        source: profile.source,
      },
    ]);
  });

  it("retains legacy inclusion priority and both raw counts when provider fields disagree", async () => {
    const client = new EdhrecClient(new CacheStore(), {
      fetchJson: async () => ({
        container: {
          json_dict: {
            cardlists: [
              {
                cardviews: [
                  {
                    name: "Sol Ring",
                    inclusion: 900,
                    num_decks: 800,
                    synergy: 0,
                  },
                ],
              },
            ],
          },
        },
      }),
    });
    const profile = await client.profileWithSource("Talrand, Sky Summoner");
    const card = profile.cards[0]!;
    expect(card.inclusion).toBe(900);
    expect(edhrecMetrics(card, profile.source)).toEqual([
      {
        name: "inclusion",
        provider_field: "inclusion",
        value: 900,
        scale: "deck_count",
        source: profile.source,
      },
      {
        name: "inclusion",
        provider_field: "num_decks",
        value: 800,
        scale: "deck_count",
        source: profile.source,
      },
      {
        name: "synergy",
        provider_field: "synergy",
        value: 0,
        scale: "proportion_difference",
        source: profile.source,
      },
    ]);
  });

  it("rejects malformed metrics without replacing missing evidence with measured zero", async () => {
    const client = new EdhrecClient(new CacheStore(), {
      fetchJson: async () => ({
        container: {
          json_dict: {
            cardlists: [
              {
                cardviews: [
                  {
                    name: "Missing",
                    inclusion: -1,
                    num_decks: 1.5,
                    potential_decks: Infinity,
                    synergy: "0.2",
                    lift: NaN,
                  },
                  { name: "Zero", num_decks: 0, potential_decks: 0, synergy: 0, lift: 0 },
                ],
              },
            ],
          },
        },
      }),
    });
    const profile = await client.profileWithSource("Talrand, Sky Summoner");
    expect(edhrecMetrics(profile.cards[0]!, profile.source)).toEqual([]);
    expect(edhrecMetrics(profile.cards[1]!, profile.source).map((metric) => metric.value)).toEqual([
      0, 0, 0, 0,
    ]);
  });
});

describe("EdhrecClient", () => {
  it("attaches EDHREC provenance and preserves stale fetch time independently of card snapshots", async () => {
    let now = 1000;
    let down = false;
    const client = new EdhrecClient(new CacheStore({ now: () => now }), {
      ttlMs: 100,
      fetchJson: async () => {
        if (down) throw new Error("offline");
        return FIXTURE;
      },
    });
    const profile = await client.profileWithSource("Talrand, Sky Summoner");
    expect(profile.source).toMatchObject({
      name: "EDHREC",
      url: "https://json.edhrec.com/pages/commanders/talrand-sky-summoner.json",
      fetched_at: "1970-01-01T00:00:01.000Z",
      status: "fresh",
      age_ms: 0,
    });
    now += 200;
    down = true;
    const stale = await client.profileWithSource("Talrand, Sky Summoner");
    expect(stale.cards).toEqual(profile.cards);
    expect(stale.source).toMatchObject({
      status: "stale",
      age_ms: 200,
      fetched_at: profile.source.fetched_at,
      refresh_failed: true,
    });
    expect(await client.profile("Talrand, Sky Summoner")).toEqual(parseProfile(FIXTURE));
  });

  it("caches a commander page (one fetch within TTL)", async () => {
    let calls = 0;
    const client = new EdhrecClient(new CacheStore({ now: () => 1000 }), {
      fetchJson: async () => {
        calls += 1;
        return FIXTURE;
      },
    });
    await client.profile("Talrand, Sky Summoner");
    await client.themes("Talrand, Sky Summoner");
    expect(calls).toBe(1); // second call served from cache
  });

  it("throws UPSTREAM_UNAVAILABLE when the fetch fails with nothing cached", async () => {
    const client = new EdhrecClient(new CacheStore({ now: () => 1000 }), {
      fetchJson: async () => {
        throw new Error("offline");
      },
    });
    await expect(client.profile("Talrand, Sky Summoner")).rejects.toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
    });
    await expect(client.profile("Talrand, Sky Summoner")).rejects.toBeInstanceOf(StructuredError);
  });
});
