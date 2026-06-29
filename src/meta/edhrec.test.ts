import { describe, it, expect } from "vitest";
import { CacheStore, EdhrecClient, slugify, parseProfile, parseThemes } from "./index.js";
import { StructuredError } from "../types/index.js";

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
});

describe("EdhrecClient", () => {
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
