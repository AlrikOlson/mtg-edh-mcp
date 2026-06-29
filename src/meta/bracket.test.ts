import { describe, it, expect } from "vitest";
import type { Card, Deck, DeckCardEntry, Role } from "../types/index.js";
import {
  CacheStore,
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

  it("throws UPSTREAM_UNAVAILABLE when the fetch fails cold", async () => {
    const client = new GameChangersClient(new CacheStore({ now: () => 1000 }), {
      fetchJson: async () => {
        throw new Error("offline");
      },
    });
    await expect(client.list()).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
  });
});
