import { describe, it, expect } from "vitest";
import type { Card, Deck, DeckCardEntry, Role } from "../types/index.js";
import {
  CacheStore,
  GAME_CHANGERS_URL,
  GameChangersClient,
  classifyBracket,
  parseGameChangers,
  type CardLookup,
} from "./index.js";

function card(p: Partial<Card> & { oracle_id: string; name: string }): Card {
  return {
    mana_cost: "",
    mv: 0,
    colors: [],
    color_identity: [],
    type_line: "Artifact",
    oracle_text: "",
    keywords: [],
    legalities: { commander: "legal" },
    prices: {},
    is_commander_eligible: false,
    roles: [],
    printings: [],
    ...p,
  };
}

const ATRAXA = card({
  oracle_id: "o-atraxa",
  name: "Atraxa, Praetors' Voice",
  type_line: "Legendary Creature — Phyrexian Angel Horror",
});
const SOL = card({
  oracle_id: "o-sol",
  name: "Sol Ring",
  mv: 1,
  oracle_text: "{T}: Add {C}{C}.",
  roles: ["ramp", "mana_rock"] as Role[],
});
const TUTOR = card({
  oracle_id: "o-dt",
  name: "Demonic Tutor",
  mv: 2,
  type_line: "Sorcery",
  oracle_text: "Search your library for a card, put that card into your hand, then shuffle.",
  roles: ["tutor"] as Role[],
});
const RIFT = card({
  oracle_id: "o-rift",
  name: "Cyclonic Rift",
  mv: 2,
  type_line: "Instant",
  oracle_text:
    "Return target nonland permanent you don't control to its owner's hand. Overload {6}{U}{U}.",
});
const ARMAGEDDON = card({
  oracle_id: "o-arma",
  name: "Armageddon",
  mv: 4,
  type_line: "Sorcery",
  oracle_text: "Destroy all lands.",
});

const CARDS: Record<string, Card> = {
  "o-atraxa": ATRAXA,
  "o-sol": SOL,
  "o-dt": TUTOR,
  "o-rift": RIFT,
  "o-arma": ARMAGEDDON,
};
const lookup: CardLookup = (id) => CARDS[id] ?? null;

function deck(cards: DeckCardEntry[], commanders: string[] = ["o-atraxa"]): Deck {
  return {
    deck_id: "d1",
    name: "T",
    format: "commander",
    commanders,
    command_zone_kind: "single",
    cards,
    computed_color_identity: [],
    version: 1,
    data_snapshot: "2026-06-27",
  };
}

describe("classifyBracket", () => {
  const gc = new Set(["Cyclonic Rift"]);

  it("bracket 2 when there are no Game Changers / MLD", () => {
    const r = classifyBracket(deck([{ oracle_id: "o-sol", qty: 1 }]), lookup, gc);
    expect(r.bracket).toBe(2);
    expect(r.pushers.game_changers).toEqual([]);
    expect(r.pushers.fast_mana).toEqual(["Sol Ring"]);
  });

  it("bracket 3 with a Game Changer + reports tutors/fast mana", () => {
    const r = classifyBracket(
      deck([
        { oracle_id: "o-sol", qty: 1 },
        { oracle_id: "o-dt", qty: 1 },
        { oracle_id: "o-rift", qty: 1 },
      ]),
      lookup,
      gc,
    );
    expect(r.bracket).toBe(3);
    expect(r.pushers.game_changers).toEqual(["Cyclonic Rift"]);
    expect(r.pushers.tutors).toEqual(["Demonic Tutor"]);
    expect(r.pushers.fast_mana).toEqual(["Sol Ring"]);
  });

  it("bracket 4 when mass land denial is present", () => {
    const r = classifyBracket(deck([{ oracle_id: "o-arma", qty: 1 }]), lookup, gc);
    expect(r.bracket).toBe(4);
    expect(r.pushers.mld).toEqual(["Armageddon"]);
  });
});

/**
 * Boundary guard for the official tier thresholds (Commander Brackets Beta,
 * verified incl. the Feb 2026 update): Core=0 GC, Upgraded=1–3 GC, Optimized=4+
 * GC or any mass land denial; tutors never gate. If WotC changes these, this
 * test should fail rather than the classifier drifting silently.
 */
describe("classifyBracket tier boundaries (Feb 2026 Brackets Beta)", () => {
  const gcCards = ["A", "B", "C", "D"].map((n) =>
    card({ oracle_id: `gc-${n}`, name: `Changer ${n}` }),
  );
  const look: CardLookup = (id) => gcCards.find((c) => c.oracle_id === id) ?? null;
  const mk = (ids: string[]): Deck =>
    deck(
      ids.map((oracle_id) => ({ oracle_id, qty: 1 })),
      [],
    );

  it("3 Game Changers stays Upgraded (bracket 3)", () => {
    const gc = new Set(["Changer A", "Changer B", "Changer C"]);
    expect(classifyBracket(mk(["gc-A", "gc-B", "gc-C"]), look, gc).bracket).toBe(3);
  });

  it("4 Game Changers crosses to Optimized (bracket 4)", () => {
    const gc = new Set(["Changer A", "Changer B", "Changer C", "Changer D"]);
    expect(classifyBracket(mk(["gc-A", "gc-B", "gc-C", "gc-D"]), look, gc).bracket).toBe(4);
  });

  it("tutors alone never gate — a tutor-heavy, GC-free deck stays Core (bracket 2)", () => {
    const tutors = [0, 1, 2, 3, 4].map((i) =>
      card({
        oracle_id: `t-${i}`,
        name: `Tutor ${i}`,
        type_line: "Sorcery",
        roles: ["tutor"] as Role[],
      }),
    );
    const tlook: CardLookup = (id) => tutors.find((c) => c.oracle_id === id) ?? null;
    const r = classifyBracket(mk(tutors.map((t) => t.oracle_id)), tlook, new Set<string>());
    expect(r.bracket).toBe(2);
    expect(r.pushers.tutors).toHaveLength(5);
  });
});

describe("classifyBracket combos + extra turns (P11)", () => {
  const noGc = new Set<string>();
  const oracle = card({
    oracle_id: "ora",
    name: "Thassa's Oracle",
    mv: 2,
    type_line: "Creature — God",
  });
  const consult = card({
    oracle_id: "con",
    name: "Demonic Consultation",
    mv: 1,
    type_line: "Instant",
  });
  const bigA = card({
    oracle_id: "ba",
    name: "Heavy Piece A",
    mv: 4,
    type_line: "Creature",
  });
  const bigB = card({
    oracle_id: "bb",
    name: "Heavy Piece B",
    mv: 5,
    type_line: "Creature",
  });
  const warp1 = card({
    oracle_id: "tw1",
    name: "Time Warp",
    mv: 5,
    type_line: "Sorcery",
    oracle_text: "Target player takes an extra turn after this one.",
  });
  const warp2 = card({
    oracle_id: "tw2",
    name: "Temporal Manipulation",
    mv: 5,
    type_line: "Sorcery",
    oracle_text: "Take an extra turn after this one.",
  });
  const CC: Record<string, Card> = {
    ora: oracle,
    con: consult,
    ba: bigA,
    bb: bigB,
    tw1: warp1,
    tw2: warp2,
  };
  const look: CardLookup = (id) => CC[id] ?? null;
  const mk = (ids: string[]): Deck =>
    deck(
      ids.map((oracle_id) => ({ oracle_id, qty: 1 })),
      [],
    );

  it("a late two-card combo (combined MV > 5) blocks Core but stays Upgraded (3)", () => {
    const r = classifyBracket(mk(["ba", "bb"]), look, noGc, [{ pieces: ["ba", "bb"] }]);
    expect(r.bracket).toBe(3);
    expect(r.pushers.combos).toEqual(["Heavy Piece A + Heavy Piece B"]);
  });

  it("an early two-card combo (combined MV <= 5) reaches Optimized (4)", () => {
    const r = classifyBracket(mk(["ora", "con"]), look, noGc, [{ pieces: ["ora", "con"] }]);
    expect(r.bracket).toBe(4); // 2 + 1 = 3 <= EARLY_COMBO_MV
  });

  it("a chain of extra-turn cards reaches Optimized (4)", () => {
    const r = classifyBracket(mk(["tw1", "tw2"]), look, noGc);
    expect(r.pushers.extra_turns).toHaveLength(2);
    expect(r.bracket).toBe(4);
  });

  it("a single extra-turn card is reported but does not gate (stays Core)", () => {
    const r = classifyBracket(mk(["tw1"]), look, noGc);
    expect(r.pushers.extra_turns).toEqual(["Time Warp"]);
    expect(r.bracket).toBe(2);
  });

  it("does not infer early assembly when supplied mana or face evidence cannot support it", () => {
    for (const combo of [
      { pieces: ["ora", "con"], mana_value_needed: 8 },
      { pieces: ["ora", "con"], mana_value_needed: null },
      {
        pieces: ["ora", "con"],
        mana_value_needed: 0,
        uses_nondefault_face: true,
      },
    ]) {
      expect(classifyBracket(mk(["ora", "con"]), look, noGc, [combo]).bracket).toBe(3);
    }
  });

  it("does not describe unchecked combo evidence as absence", () => {
    const result = classifyBracket(mk(["ba"]), look, noGc);
    expect(result).toMatchObject({
      provisional: true,
      combo_evidence: { status: "not_checked", absence_confirmed: false },
    });
    expect(result.rationale).toContain("absence is not established");
  });

  it("no combos passed → back-compatible, no combo pushers", () => {
    const r = classifyBracket(mk(["ba"]), look, noGc);
    expect(r.bracket).toBe(2);
    expect(r.pushers.combos).toEqual([]);
  });
});

describe("parseGameChangers", () => {
  it("accepts arrays of names, {cards:[{name}]}, and is defensive", () => {
    expect([...parseGameChangers(["Sol Ring", "Mana Crypt"])]).toEqual(["Sol Ring", "Mana Crypt"]);
    expect([...parseGameChangers({ cards: [{ name: "Sol Ring" }] })]).toEqual(["Sol Ring"]);
    expect([...parseGameChangers(null)]).toEqual([]);
  });
});

describe("GameChangersClient", () => {
  it("fetches + caches the list", async () => {
    let calls = 0;
    const client = new GameChangersClient(new CacheStore({ now: () => 1000 }), {
      fetchJson: async () => {
        calls += 1;
        return ["Cyclonic Rift"];
      },
    });
    const a = await client.list();
    await client.list();
    expect(calls).toBe(1);
    expect(a.has("Cyclonic Rift")).toBe(true);
  });

  it("reads the Scryfall search shape and follows next_page", async () => {
    const seen: string[] = [];
    const client = new GameChangersClient(new CacheStore({ now: () => 1000 }), {
      fetchJson: async (url: string) => {
        seen.push(url);
        return seen.length === 1
          ? {
              object: "list",
              has_more: true,
              next_page: "https://api.scryfall.com/cards/search?page=2",
              data: [{ name: "Ad Nauseam" }, { name: "Ancient Tomb" }],
            }
          : {
              object: "list",
              has_more: false,
              data: [{ name: "Aura Shards" }],
            };
      },
    });

    const names = await client.list();
    expect([...names]).toEqual(["Ad Nauseam", "Ancient Tomb", "Aura Shards"]);
    expect(seen[0]).toBe(GAME_CHANGERS_URL);
    expect(seen[1]).toBe("https://api.scryfall.com/cards/search?page=2");
  });

  it("throws UPSTREAM_UNAVAILABLE when the fetch fails cold", async () => {
    const client = new GameChangersClient(new CacheStore({ now: () => 1000 }), {
      fetchJson: async () => {
        throw new Error("offline");
      },
    });
    await expect(client.list()).rejects.toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
    });
  });
});
