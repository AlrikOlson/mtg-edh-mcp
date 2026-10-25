/**
 * Catalog and image fixtures shared by the print tests that drive several
 * owners at once (the order service and the print_* tools). The card shapes
 * match manifest.test.ts and imageSelector.test.ts.
 */
import sharp from "sharp";
import type { Card, CardFace, CardGameplay, Printing } from "../types/index.js";
import type { CardLookup } from "../validate/index.js";
import type { FaceImageFetcher } from "./imageSelector.js";

export function face(index: number, name: string): CardFace {
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

export function gameplay(
  relationship: CardGameplay["face_relationship"],
  faces: readonly CardFace[] | null,
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
    related_cards: null,
  };
}

export function printing(
  scryfall_id: string,
  set: string,
  collector_number: string,
  released_at?: string,
): Printing {
  return {
    scryfall_id,
    set,
    set_name: set.toUpperCase(),
    collector_number,
    rarity: "rare",
    prices: {},
    ...(released_at === undefined ? {} : { released_at }),
  };
}

export function card(partial: Partial<Card> & { oracle_id: string; name: string }): Card {
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

export function lookupOf(...cards: Card[]): CardLookup {
  const byId = new Map(cards.map((c) => [c.oracle_id, c]));
  return (id) => byId.get(id) ?? null;
}

/** A solid PNG of the given size, as Scryfall's trimmed `png` version or a user file. */
export async function solidPng(
  width: number,
  height: number,
  rgb: [number, number, number] = [0, 0, 0],
): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: rgb[0], g: rgb[1], b: rgb[2], alpha: 1 },
    },
  })
    .png()
    .toBuffer();
}

export interface FetchCall {
  scryfall_id: string;
  face: "front" | "back";
}

/** A fake of LiveScryfallClient.getCardImage that serves `bytes` and records every call. */
export function fakeScryfall(bytes: Uint8Array, calls: FetchCall[] = []): FaceImageFetcher {
  return {
    getCardImage: (scryfall_id, options) => {
      calls.push({ scryfall_id, face: options?.face ?? "front" });
      return Promise.resolve(bytes);
    },
  };
}
