import { describe, expect, it } from "vitest";
import type { Card, CardFace, CardGameplay, Deck } from "../types/index.js";
import type { CardLookup } from "../validate/index.js";
import { buildPrintManifest, type PrintManifest } from "./manifest.js";

function face(index: number, name: string): CardFace {
  return {
    face_index: index,
    source_path: index === 0 && name === "" ? "" : `/card_faces/${index}`,
    oracle_id: null,
    characteristics: {
      name,
      mana_cost: null,
      cmc: null,
      type_line: null,
      oracle_text: null,
      colors: null,
      color_indicator: null,
      power: null,
      toughness: null,
      loyalty: null,
      defense: null,
      keywords: null,
      produced_mana: null,
      printed_name: null,
      printed_text: null,
      printed_type_line: null,
    },
  };
}

function gameplay(
  relationship: CardGameplay["face_relationship"],
  faces: readonly CardFace[] | null,
  related: CardGameplay["related_cards"] = null,
): CardGameplay {
  return {
    version: 1,
    source: { scryfall_id: null, oracle_id: null },
    layout: relationship,
    color_identity: null,
    face_relationship: relationship,
    playability: "not_evaluated",
    characteristics: face(0, "").characteristics,
    faces,
    related_cards: related,
  };
}

function card(partial: Partial<Card> & { oracle_id: string; name: string }): Card {
  return {
    mana_cost: "",
    mv: 0,
    colors: [],
    color_identity: [],
    type_line: "Creature — Human",
    oracle_text: "",
    keywords: [],
    legalities: { commander: "legal" },
    prices: {},
    is_commander_eligible: false,
    roles: [],
    printings: [],
    gameplay: gameplay("single", [face(0, partial.name)]),
    ...partial,
  };
}

function lookupOf(...cards: Card[]): CardLookup {
  const byId = new Map(cards.map((c) => [c.oracle_id, c]));
  return (id) => byId.get(id) ?? null;
}

function deck(partial: Partial<Deck>): Deck {
  return {
    deck_id: "deck-1",
    name: "Print me",
    format: "commander",
    commanders: ["cmd"],
    command_zone_kind: "single",
    cards: [],
    computed_color_identity: [],
    version: 7,
    data_snapshot: "2026-10-18",
    ...partial,
  };
}

const commander = card({
  oracle_id: "cmd",
  name: "Leader",
  type_line: "Legendary Creature — Human",
  is_commander_eligible: true,
});
const partner = card({
  oracle_id: "cmd2",
  name: "Second Leader",
  type_line: "Legendary Creature — Elf",
  is_commander_eligible: true,
});
const background = card({
  oracle_id: "bg",
  name: "Noble Heritage",
  type_line: "Legendary Enchantment — Background",
});
const forest = card({ oracle_id: "forest", name: "Forest", type_line: "Basic Land — Forest" });
const bear = card({ oracle_id: "bear", name: "Grizzly Bears" });
const transformer = card({
  oracle_id: "dfc",
  name: "Defender // Awakened",
  gameplay: gameplay("transform", [face(0, "Defender"), face(1, "Awakened")]),
});
const modal = card({
  oracle_id: "mdfc",
  name: "Tide // Shore",
  gameplay: gameplay("modal", [face(0, "Tide"), face(1, "Shore")]),
});
const split = card({
  oracle_id: "split",
  name: "Flame // Mist",
  gameplay: gameplay("split", [face(0, "Flame"), face(1, "Mist")]),
});
const tokenMaker = card({
  oracle_id: "maker",
  name: "Token Maker",
  gameplay: gameplay(
    "single",
    [face(0, "Token Maker")],
    [
      {
        id: "p-maker",
        component: "combo_piece",
        name: "Token Maker",
        type_line: "Creature — Human",
        uri: "https://api.scryfall.com/cards/p-maker",
      },
      {
        id: "t-soldier",
        component: "token",
        name: "Soldier",
        type_line: "Token Creature — Soldier",
        uri: "https://api.scryfall.com/cards/t-soldier",
      },
    ],
  ),
});
const otherMaker = card({
  oracle_id: "maker2",
  name: "Other Maker",
  gameplay: gameplay(
    "single",
    [face(0, "Other Maker")],
    [
      {
        id: "t-soldier",
        component: "token",
        name: "Soldier",
        type_line: "Token Creature — Soldier",
        uri: "https://api.scryfall.com/cards/t-soldier",
      },
    ],
  ),
});
const companion = card({
  oracle_id: "comp",
  name: "Lurrus",
  type_line: "Legendary Creature — Cat Nightmare",
});

const lookup = lookupOf(
  commander,
  partner,
  background,
  forest,
  bear,
  transformer,
  modal,
  split,
  tokenMaker,
  otherMaker,
  companion,
);

function manifestOf(d: Deck, options?: Parameters<typeof buildPrintManifest>[2]): PrintManifest {
  const result = buildPrintManifest(d, lookup, options);
  if (result.kind !== "manifest") throw new Error(`expected a manifest, got ${result.kind}`);
  return result.manifest;
}

describe("buildPrintManifest", () => {
  it("expands a repeated card into that many physical cards, in deck order, after the commander", () => {
    const m = manifestOf(
      deck({
        cards: [
          { oracle_id: "forest", qty: 3 },
          { oracle_id: "bear", qty: 1 },
        ],
      }),
    );
    expect(m.cards.map((c) => [c.slot, c.name, c.source])).toEqual([
      [1, "Leader", "commander"],
      [2, "Forest", "library"],
      [3, "Forest", "library"],
      [4, "Forest", "library"],
      [5, "Grizzly Bears", "library"],
    ]);
    expect(m.total).toBe(5);
    expect(m.attention).toEqual([]);
  });

  it("puts both faces of a transform or modal card on one physical card and keeps split cards single", () => {
    const m = manifestOf(
      deck({
        cards: [
          { oracle_id: "dfc", qty: 1 },
          { oracle_id: "mdfc", qty: 1 },
          { oracle_id: "split", qty: 1 },
        ],
      }),
    );
    const [, dfc, mdfc, flameMist] = m.cards;
    expect(dfc?.front).toEqual({ face_index: 0, source_path: "/card_faces/0", name: "Defender" });
    expect(dfc?.back).toEqual({ face_index: 1, source_path: "/card_faces/1", name: "Awakened" });
    expect(mdfc?.front.name).toBe("Tide");
    expect(mdfc?.back?.name).toBe("Shore");
    expect(flameMist?.front.name).toBe("Flame");
    expect(flameMist?.back).toBeNull();
    expect(m.total).toBe(4);
  });

  it("prints a single commander exactly once and never again from the library", () => {
    const m = manifestOf(deck({ cards: [{ oracle_id: "forest", qty: 2 }] }));
    expect(m.cards.filter((c) => c.oracle_id === "cmd")).toHaveLength(1);
    expect(m.cards[0]?.source).toBe("commander");
    expect(m.total).toBe(3);
  });

  it("prints partner and background commanders once each, in command-zone order", () => {
    const partners = manifestOf(
      deck({
        commanders: ["cmd", "cmd2"],
        command_zone_kind: "partner",
        cards: [{ oracle_id: "bear", qty: 1 }],
      }),
    );
    expect(partners.cards.map((c) => c.name)).toEqual(["Leader", "Second Leader", "Grizzly Bears"]);
    expect(partners.total).toBe(3);

    const withBackground = manifestOf(
      deck({ commanders: ["cmd", "bg"], command_zone_kind: "background", cards: [] }),
    );
    expect(withBackground.cards.map((c) => [c.name, c.source])).toEqual([
      ["Leader", "commander"],
      ["Noble Heritage", "commander"],
    ]);
    expect(withBackground.total).toBe(2);
  });

  it("flags a commander that also appears in the library instead of dropping either copy", () => {
    const m = manifestOf(deck({ cards: [{ oracle_id: "cmd", qty: 1 }] }));
    expect(m.cards.map((c) => c.source)).toEqual(["commander", "library"]);
    expect(m.attention).toEqual([
      expect.objectContaining({ kind: "commander_in_library", ref: "cmd", slots: [2] }),
    ]);
    expect(m.total).toBe(2);
  });

  it("lists a declared companion as an extra outside the main count", () => {
    const m = manifestOf(deck({ companion: "comp", cards: [{ oracle_id: "bear", qty: 1 }] }));
    expect(m.cards.map((c) => c.name)).toEqual(["Leader", "Grizzly Bears"]);
    expect(m.extras.companion).toEqual(
      expect.objectContaining({ oracle_id: "comp", name: "Lurrus", source: "companion", slot: 3 }),
    );
    expect(m.total).toBe(2);
  });

  it("offers tokens from related cards once each as unselected extras, selectable by id", () => {
    const d = deck({
      cards: [
        { oracle_id: "maker", qty: 2 },
        { oracle_id: "maker2", qty: 1 },
      ],
    });
    const offered = manifestOf(d);
    expect(offered.extras.tokens).toEqual([
      {
        related_id: "t-soldier",
        name: "Soldier",
        type_line: "Token Creature — Soldier",
        from_oracle_ids: ["maker", "maker2"],
        selected: false,
      },
    ]);
    expect(offered.total).toBe(4);

    const selected = manifestOf(d, { selected_tokens: ["t-soldier", "t-missing"] });
    expect(selected.extras.tokens[0]?.selected).toBe(true);
    expect(selected.total).toBe(4);
    expect(selected.attention).toEqual([
      expect.objectContaining({ kind: "unknown_token", ref: "t-missing" }),
    ]);
  });

  it("records the deck pin and reports a conflict when the pinned version differs", () => {
    const d = deck({ cards: [{ oracle_id: "bear", qty: 1 }] });
    const m = manifestOf(d, {
      pinned: { deck_id: "deck-1", version: 7, data_snapshot: "2026-10-18" },
    });
    expect([m.deck_id, m.deck_name, m.version, m.data_snapshot]).toEqual([
      "deck-1",
      "Print me",
      7,
      "2026-10-18",
    ]);

    const stale = buildPrintManifest(d, lookup, { pinned: { deck_id: "deck-1", version: 6 } });
    expect(stale).toEqual({
      kind: "conflict",
      conflict: {
        reason: "version",
        pinned: { deck_id: "deck-1", version: 6 },
        actual: { deck_id: "deck-1", version: 7, data_snapshot: "2026-10-18" },
      },
    });

    const otherDeck = buildPrintManifest(d, lookup, { pinned: { deck_id: "deck-2", version: 7 } });
    expect(otherDeck.kind === "conflict" && otherDeck.conflict.reason).toBe("deck_id");

    const movedSnapshot = buildPrintManifest(d, lookup, {
      pinned: { deck_id: "deck-1", version: 7, data_snapshot: "2026-10-17" },
    });
    expect(movedSnapshot.kind === "conflict" && movedSnapshot.conflict.reason).toBe(
      "data_snapshot",
    );
  });

  it("keeps illegal and unknown cards and names them in the attention list", () => {
    const m = manifestOf(
      deck({
        cards: [
          { oracle_id: "bear", qty: 2, illegal: true },
          { oracle_id: "ghost", qty: 1 },
        ],
      }),
    );
    expect(m.cards.map((c) => [c.slot, c.oracle_id, c.name, c.illegal])).toEqual([
      [1, "cmd", "Leader", false],
      [2, "bear", "Grizzly Bears", true],
      [3, "bear", "Grizzly Bears", true],
      [4, "ghost", "ghost", false],
    ]);
    expect(m.cards[3]?.front).toEqual({ face_index: 0, source_path: "", name: "ghost" });
    expect(m.attention).toEqual([
      expect.objectContaining({ kind: "illegal_card", ref: "bear", slots: [2, 3] }),
      expect.objectContaining({ kind: "unknown_card", ref: "ghost", slots: [4] }),
    ]);
    expect(m.total).toBe(4);
  });

  it("flags a double-faced card whose catalog record lacks its faces rather than inventing a back", () => {
    const faceless = card({
      oracle_id: "dfc",
      name: "Defender // Awakened",
      gameplay: gameplay("transform", null),
    });
    const result = buildPrintManifest(
      deck({ cards: [{ oracle_id: "dfc", qty: 1 }] }),
      lookupOf(commander, faceless),
    );
    if (result.kind !== "manifest") throw new Error("expected a manifest");
    expect(result.manifest.cards[1]?.front).toEqual({
      face_index: 0,
      source_path: "",
      name: "Defender // Awakened",
    });
    expect(result.manifest.cards[1]?.back).toBeNull();
    expect(result.manifest.attention).toEqual([
      expect.objectContaining({ kind: "missing_faces", ref: "dfc", slots: [2] }),
    ]);
  });

  it("flags an unknown companion and a card without a catalog record for the commander", () => {
    const result = buildPrintManifest(deck({ companion: "nope", cards: [] }), lookupOf());
    if (result.kind !== "manifest") throw new Error("expected a manifest");
    expect(result.manifest.cards).toEqual([
      expect.objectContaining({ slot: 1, oracle_id: "cmd", name: "cmd", source: "commander" }),
    ]);
    expect(result.manifest.extras.companion).toEqual(
      expect.objectContaining({ oracle_id: "nope", name: "nope", source: "companion" }),
    );
    expect(result.manifest.attention.map((a) => [a.kind, a.ref])).toEqual([
      ["unknown_card", "cmd"],
      ["unknown_companion", "nope"],
    ]);
    expect(result.manifest.total).toBe(1);
  });

  it("derives the total from quantities plus commanders without recounting the card list", () => {
    const m = manifestOf(
      deck({
        commanders: ["cmd", "cmd2"],
        command_zone_kind: "partner",
        companion: "comp",
        cards: [
          { oracle_id: "forest", qty: 30 },
          { oracle_id: "bear", qty: 4 },
          { oracle_id: "maker", qty: 1 },
        ],
      }),
      { selected_tokens: ["t-soldier"] },
    );
    expect(m.total).toBe(37);
    expect(m.cards).toHaveLength(37);
  });
});
