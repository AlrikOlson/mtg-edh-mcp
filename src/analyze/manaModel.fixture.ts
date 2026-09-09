/** Canonical source fixtures: no network, flattened role or produced_mana inference. */
import { mapScryfallCard, type ScryfallCardRaw } from "../index/map.js";

export function manaCard(name: string, raw: Partial<ScryfallCardRaw> = {}) {
  return mapScryfallCard({
    id: `printing-${name}`,
    oracle_id: name,
    name,
    layout: "normal",
    mana_cost: "",
    type_line: "Land",
    oracle_text: "",
    ...raw,
  });
}

export const manaFixtures = {
  plains: manaCard("Plains", { type_line: "Basic Land — Plains", oracle_text: "({T}: Add {W}.)" }),
  island: manaCard("Island", { type_line: "Basic Land — Island", oracle_text: "({T}: Add {U}.)" }),
  swamp: manaCard("Swamp", { type_line: "Basic Land — Swamp", oracle_text: "({T}: Add {B}.)" }),
  mountain: manaCard("Mountain", {
    type_line: "Basic Land — Mountain",
    oracle_text: "({T}: Add {R}.)",
  }),
  forest: manaCard("Forest", { type_line: "Basic Land — Forest", oracle_text: "({T}: Add {G}.)" }),
  wastes: manaCard("Wastes", { type_line: "Basic Land", oracle_text: "{T}: Add {C}." }),
  tropical: manaCard("Tropical Island", {
    type_line: "Land — Forest Island",
    oracle_text: "({T}: Add {G} or {U}.)",
  }),
  guildgate: manaCard("Azorius Guildgate", {
    type_line: "Land — Gate",
    oracle_text: "Azorius Guildgate enters tapped.\n{T}: Add {W} or {U}.",
  }),
  ring: manaCard("Sol Ring", {
    mana_cost: "{1}",
    type_line: "Artifact",
    oracle_text: "{T}: Add {C}{C}.",
  }),
  diamond: manaCard("Sky Diamond", {
    mana_cost: "{2}",
    type_line: "Artifact",
    oracle_text: "Sky Diamond enters tapped.\n{T}: Add {U}.",
  }),
  elves: manaCard("Llanowar Elves", {
    mana_cost: "{G}",
    type_line: "Creature — Elf Druid",
    oracle_text: "{T}: Add {G}.",
  }),
  birds: manaCard("Birds of Paradise", {
    mana_cost: "{G}",
    type_line: "Creature — Bird",
    oracle_text: "Flying\n{T}: Add one mana of any color.",
  }),
  signet: manaCard("Azorius Signet", {
    mana_cost: "{2}",
    type_line: "Artifact",
    oracle_text: "{1}, {T}: Add {W}{U}.",
  }),
  tower: manaCard("Command Tower", {
    oracle_text: "{T}: Add one mana of any color in your commander's color identity.",
  }),
  wilds: manaCard("Evolving Wilds", {
    oracle_text:
      "{T}, Sacrifice Evolving Wilds: Search your library for a basic land card, put it onto the battlefield tapped, then shuffle.",
  }),
  pathway: manaCard("Barkchannel Pathway // Tidechannel Pathway", {
    layout: "modal_dfc",
    card_faces: [
      {
        name: "Barkchannel Pathway",
        type_line: "Land",
        mana_cost: "",
        oracle_text: "{T}: Add {G}.",
      },
      {
        name: "Tidechannel Pathway",
        type_line: "Land",
        mana_cost: "",
        oracle_text: "{T}: Add {U}.",
      },
    ],
  }),
  tangled: manaCard("Tangled Florahedron // Tangled Vale", {
    layout: "modal_dfc",
    card_faces: [
      {
        name: "Tangled Florahedron",
        type_line: "Creature — Elemental",
        mana_cost: "{1}{G}",
        oracle_text: "{T}: Add {G}.",
      },
      {
        name: "Tangled Vale",
        type_line: "Land",
        mana_cost: "",
        oracle_text: "Tangled Vale enters tapped.\n{T}: Add {G}.",
      },
    ],
  }),
  ziggurat: manaCard("Ancient Ziggurat", {
    oracle_text: "{T}: Add one mana of any color. Spend this mana only to cast a creature spell.",
  }),
  pool: manaCard("Reflecting Pool", {
    oracle_text: "{T}: Add one mana of any type that a land you control could produce.",
  }),
  shock: manaCard("Breeding Pool", {
    type_line: "Land — Forest Island",
    oracle_text:
      "({T}: Add {G} or {U}.)\nAs Breeding Pool enters, you may pay 2 life. If you don't, it enters tapped.",
  }),
  check: manaCard("Glacial Fortress", {
    oracle_text:
      "Glacial Fortress enters tapped unless you control a Plains or an Island.\n{T}: Add {W} or {U}.",
  }),
  force: manaCard("Force of Will", {
    mana_cost: "{3}{U}{U}",
    type_line: "Instant",
    oracle_text:
      "You may pay 1 life and exile a blue card from your hand rather than pay this spell's mana cost.\nCounter target spell.",
  }),
};
