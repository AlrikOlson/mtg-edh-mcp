/** The shared whole-deck legality composition; individual rule modules own decisions. */
import type { Deck, Violation } from "../types/index.js";
import { validateCore, type CardLookup } from "./coreRules.js";
import { validateCommander } from "./commanderRules.js";
import { validateCompanion } from "./companionRules.js";

export function validateDeck(deck: Deck, lookup: CardLookup): Violation[] {
  return [
    ...validateCore(deck, lookup),
    ...validateCommander(deck, lookup),
    ...validateCompanion(deck, lookup),
  ];
}
