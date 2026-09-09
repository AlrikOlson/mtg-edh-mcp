/** Recorded provider shape, with synthetic names to keep contract tests offline. */
export const SPELLBOOK_VARIANT_FIXTURE = {
  id: "fixture-commander-loop",
  status: "OK",
  uses: [
    {
      card: { id: 101, name: "Front // Back", oracleId: "fixture-oracle-id" },
      quantity: 2,
      zoneLocations: ["B", "G"],
      battlefieldCardState: "Untapped and without summoning sickness.",
      exileCardState: "",
      libraryCardState: "",
      graveyardCardState: "Above all other cards.",
      mustBeCommander: true,
      usedFace: 2,
    },
  ],
  requires: [
    {
      template: {
        id: 201,
        name: "A creature that can sacrifice itself",
        scryfallQuery: "t:creature o:sacrifice",
        scryfallApi: "https://api.scryfall.com/cards/search?q=t%3Acreature",
      },
      quantity: 1,
      zoneLocations: ["B"],
      battlefieldCardState: "Under your control.",
      exileCardState: "",
      libraryCardState: "",
      graveyardCardState: "",
      mustBeCommander: false,
    },
  ],
  produces: [
    { feature: { id: 301, name: "Infinite mana", uncountable: true, status: "S" }, quantity: 1 },
  ],
  manaNeeded: "{2}{U}",
  manaValueNeeded: 3,
  easyPrerequisites: "You control a creature.",
  notablePrerequisites: "Your life total is at least 5.",
  description: "1. Activate the ability.\n2. Repeat.",
  notes: "Each iteration requires an available target.",
};

export const SPELLBOOK_RESPONSE_FIXTURE = {
  count: 1,
  next: null,
  previous: null,
  results: {
    identity: "U",
    included: [SPELLBOOK_VARIANT_FIXTURE],
    includedByChangingCommanders: [],
    almostIncluded: [],
    almostIncludedByAddingColors: [],
    almostIncludedByChangingCommanders: [],
    almostIncludedByAddingColorsAndChangingCommanders: [],
  },
};
