import { describe, it, expect } from "vitest";
import type { Card, Color, DeckCardEntry, Role } from "../types/index.js";
import { analyzeManaBase, analyzeRoleCoverage, type CardLookup } from "./index.js";

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

const FOREST = card({
  oracle_id: "o-forest",
  name: "Forest",
  type_line: "Basic Land — Forest",
  oracle_text: "({T}: Add {G}.)",
  roles: ["land"] as Role[],
});
const TOWER = card({
  oracle_id: "o-tower",
  name: "Command Tower",
  type_line: "Land",
  oracle_text: "{T}: Add one mana of any color in your commander's color identity.",
  roles: ["land", "fixing"] as Role[],
});
const ELF = card({
  oracle_id: "o-elf",
  name: "Llanowar Elves",
  type_line: "Creature — Elf Druid",
  oracle_text: "{T}: Add {G}.",
  roles: ["ramp", "mana_dork"] as Role[],
});
const TEMPLE = card({
  oracle_id: "o-temple",
  name: "Temple of Mystery",
  type_line: "Land",
  oracle_text: "Temple of Mystery enters the battlefield tapped. {T}: Add {G} or {U}.",
  roles: ["land", "fixing"] as Role[],
});

const lookup: CardLookup = (id) =>
  ({ "o-forest": FOREST, "o-tower": TOWER, "o-elf": ELF, "o-temple": TEMPLE })[id] ?? null;

describe("analyzeManaBase", () => {
  it("counts per-color sources, land split, fixing, and under-supported colors", () => {
    // 4 Forest + 1 Command Tower + 1 Llanowar Elves, mono-green identity.
    const deck: DeckCardEntry[] = [
      { oracle_id: "o-forest", qty: 4 },
      { oracle_id: "o-tower", qty: 1 },
      { oracle_id: "o-elf", qty: 1 },
    ];
    const r = analyzeManaBase(deck, lookup, { identity: ["G"] as Color[] });
    expect(r.sources.G).toBe(6); // 4 forest + tower(any->G) + elf
    expect(r.total_lands).toBe(5); // 4 forest + tower (elf is a creature)
    expect(r.untapped_lands).toBe(5);
    expect(r.tapped_lands).toBe(0);
    expect(r.fixing_sources).toBe(1); // command tower (any color)
    expect(r.under_supported).toEqual(["G"]); // 6 < default threshold 10
  });

  it("honors a custom threshold and counts tapped lands", () => {
    const deck: DeckCardEntry[] = [
      { oracle_id: "o-forest", qty: 4 },
      { oracle_id: "o-temple", qty: 1 },
    ];
    const r = analyzeManaBase(deck, lookup, { identity: ["G", "U"] as Color[], threshold: 4 });
    expect(r.total_lands).toBe(5);
    expect(r.tapped_lands).toBe(1); // Temple enters tapped
    expect(r.untapped_lands).toBe(4);
    expect(r.sources.G).toBe(5); // 4 forest + temple
    expect(r.sources.U).toBe(1); // temple
    expect(r.fixing_sources).toBe(1); // temple produces 2 colors
    expect(r.under_supported).toEqual(["U"]); // G=5>=4 ok, U=1<4 under
  });
});

describe("analyzeRoleCoverage", () => {
  const deck: DeckCardEntry[] = [
    { oracle_id: "o-forest", qty: 4 },
    { oracle_id: "o-elf", qty: 1 },
  ];
  it("reports under/ok/over vs default bands", () => {
    const { counts, gaps } = analyzeRoleCoverage(deck, lookup);
    expect(counts.land).toBe(4);
    expect(counts.ramp).toBe(1);
    const ramp = gaps.find((g) => g.role === "ramp");
    expect(ramp).toMatchObject({ have: 1, status: "under" });
    const land = gaps.find((g) => g.role === "land");
    expect(land?.status).toBe("under"); // 4 < 33
    const tutor = gaps.find((g) => g.role === "tutor");
    expect(tutor?.status).toBe("ok"); // 0 within 0..10
  });

  it("honors custom bands", () => {
    const { gaps } = analyzeRoleCoverage(deck, lookup, { ramp: { min: 1, max: 3 } });
    expect(gaps).toEqual([{ role: "ramp", have: 1, want_min: 1, want_max: 3, status: "ok" }]);
  });
});
