/* Manabase UI kit — sample data.
   Mirrors the engine's Card / CardRef / Deck / analysis shapes (src/types,
   src/analyze). Real Commander cards for an Atraxa Superfriends (WUBG) build.
   Art uses Scryfall's by-name art_crop endpoint; CardRow/CardTile fall back to
   identity-tinted placeholders if an image fails to load. */
(function () {
  const art = (name) =>
    `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(name)}&format=image&version=normal`;

  const C = (name, type, cost, ci, roles, usd, rank) => ({
    name, typeLine: type, manaCost: cost, identity: ci, roles: roles || [],
    priceUsd: usd, edhrecRank: rank, image: art(name),
  });

  // Commander
  const commander = C("Atraxa, Praetors' Voice", "Legendary Creature — Phyrexian Angel Horror",
    "{G}{W}{U}{B}", ["W", "U", "B", "G"], ["payoff"], 12.40, 84);

  // A representative 99 (98 cards here + the 1 force-added illegal below + the
  // commander = 100). Real Atraxa Superfriends — full roster so the live analysis
  // (curve / pips / coverage / composition) reads like an actual deck.
  const deck = [
    // ── Ramp (10) ──
    C("Sol Ring", "Artifact", "{1}", [], ["ramp", "mana_rock"], 1.49, 1),
    C("Arcane Signet", "Artifact", "{2}", [], ["ramp", "mana_rock", "fixing"], 0.95, 6),
    C("Fellwar Stone", "Artifact", "{2}", [], ["ramp", "mana_rock", "fixing"], 1.20, 200),
    C("Mind Stone", "Artifact", "{2}", [], ["ramp", "mana_rock"], 0.60, 180),
    C("Cultivate", "Sorcery", "{2}{G}", ["G"], ["ramp", "fixing"], 0.50, 21),
    C("Kodama's Reach", "Sorcery", "{2}{G}", ["G"], ["ramp", "fixing"], 1.00, 120),
    C("Farseek", "Sorcery", "{1}{G}", ["G"], ["ramp", "fixing"], 0.60, 60),
    C("Nature's Lore", "Sorcery", "{1}{G}", ["G"], ["ramp", "fixing"], 0.90, 75),
    C("Three Visits", "Sorcery", "{1}{G}", ["G"], ["ramp", "fixing"], 4.50, 300),
    C("Smothering Tithe", "Enchantment", "{3}{W}", ["W"], ["ramp", "payoff"], 24.00, 7),
    // ── Card draw (9) ──
    C("Rhystic Study", "Enchantment", "{2}{U}", ["U"], ["card_draw", "card_advantage"], 28.00, 2),
    C("Mystic Remora", "Enchantment", "{U}", ["U"], ["card_draw", "card_advantage"], 3.00, 40),
    C("Night's Whisper", "Sorcery", "{1}{B}", ["B"], ["card_draw"], 4.00, 55),
    C("Sign in Blood", "Sorcery", "{1}{B}", ["B"], ["card_draw"], 0.50, 150),
    C("Esper Sentinel", "Artifact Creature — Artificer", "{W}", ["W"], ["card_draw", "card_advantage"], 28.00, 15),
    C("Fact or Fiction", "Instant", "{3}{U}", ["U"], ["card_draw"], 0.80, 260),
    C("Read the Bones", "Sorcery", "{1}{B}{B}", ["B"], ["card_draw"], 0.50, 210),
    C("Tezzeret's Gambit", "Sorcery", "{3}{U/P}", ["U"], ["card_draw", "payoff"], 1.10, 690),
    C("Inspiring Call", "Instant", "{2}{G}", ["G"], ["card_draw", "protection"], 3.00, 500),
    // ── Spot removal (8) ──
    C("Swords to Plowshares", "Instant", "{W}", ["W"], ["spot_removal"], 1.20, 4),
    C("Path to Exile", "Instant", "{W}", ["W"], ["spot_removal"], 4.00, 30),
    C("Anguished Unmaking", "Instant", "{1}{W}{B}", ["W", "B"], ["spot_removal"], 3.00, 40),
    C("Despark", "Instant", "{W}{B}", ["W", "B"], ["spot_removal"], 2.10, 90),
    C("Beast Within", "Instant", "{2}{G}", ["G"], ["spot_removal"], 1.10, 35),
    C("Assassin's Trophy", "Instant", "{B}{G}", ["B", "G"], ["spot_removal"], 6.00, 45),
    C("Generous Gift", "Instant", "{2}{W}", ["W"], ["spot_removal"], 4.00, 50),
    C("Putrefy", "Instant", "{1}{B}{G}", ["B", "G"], ["spot_removal"], 1.00, 520),
    // ── Board wipes (4) ──
    C("Toxic Deluge", "Sorcery", "{2}{B}", ["B"], ["board_wipe"], 22.00, 18),
    C("Wrath of God", "Sorcery", "{2}{W}{W}", ["W"], ["board_wipe"], 6.00, 25),
    C("Cyclonic Rift", "Instant", "{6}{U}", ["U"], ["board_wipe", "protection"], 32.50, 12),
    C("Ezuri's Predation", "Sorcery", "{4}{G}{G}", ["G"], ["board_wipe", "payoff"], 6.00, 700),
    // ── Protection (2 more; +Inspiring Call/Cyclonic Rift/Ajani) ──
    C("Heroic Intervention", "Instant", "{1}{G}", ["G"], ["protection"], 8.00, 60),
    C("Teferi's Protection", "Instant", "{2}{W}", ["W"], ["protection"], 18.00, 33),
    // ── Tutors (3) ──
    C("Demonic Tutor", "Sorcery", "{1}{B}", ["B"], ["tutor"], 30.00, 3),
    C("Vampiric Tutor", "Instant", "{B}", ["B"], ["tutor"], 35.00, 8),
    C("Enlightened Tutor", "Instant", "{W}", ["W"], ["tutor"], 28.00, 70),
    // ── Counterspells (3) ──
    C("Counterspell", "Instant", "{U}{U}", ["U"], ["counterspell"], 0.80, 9),
    C("Swan Song", "Instant", "{U}", ["U"], ["counterspell"], 4.00, 28),
    C("Dovin's Veto", "Instant", "{W}{U}", ["W", "U"], ["counterspell"], 3.00, 80),
    // ── Planeswalkers (12) — superfriends core ──
    C("Teferi, Hero of Dominaria", "Legendary Planeswalker — Teferi", "{3}{W}{U}", ["W", "U"], ["card_advantage", "spot_removal"], 14.00, 70),
    C("Vraska, Golgari Queen", "Legendary Planeswalker — Vraska", "{3}{B}{G}", ["B", "G"], ["spot_removal", "card_advantage"], 6.50, 140),
    C("Elspeth, Sun's Champion", "Legendary Planeswalker — Elspeth", "{4}{W}{W}", ["W"], ["payoff"], 8.00, 150),
    C("Nissa, Who Shakes the World", "Legendary Planeswalker — Nissa", "{3}{G}{G}", ["G"], ["ramp", "payoff"], 10.00, 160),
    C("Liliana, Dreadhorde General", "Legendary Planeswalker — Liliana", "{4}{B}{B}", ["B"], ["card_advantage", "spot_removal"], 15.00, 90),
    C("Kaya, Orzhov Usurper", "Legendary Planeswalker — Kaya", "{1}{W}{B}", ["W", "B"], ["spot_removal"], 4.00, 300),
    C("Narset, Parter of Veils", "Legendary Planeswalker — Narset", "{1}{U}{U}", ["U"], ["card_advantage"], 10.00, 110),
    C("Ajani, the Greathearted", "Legendary Planeswalker — Ajani", "{2}{G}{W}", ["G", "W"], ["payoff", "protection"], 4.00, 260),
    C("Tamiyo, Field Researcher", "Legendary Planeswalker — Tamiyo", "{1}{G}{W}{U}", ["G", "W", "U"], ["card_advantage"], 3.00, 400),
    C("Karn Liberated", "Legendary Planeswalker — Karn", "{7}", [], ["spot_removal", "payoff"], 22.00, 130),
    C("Tezzeret the Seeker", "Legendary Planeswalker — Tezzeret", "{3}{U}{U}", ["U"], ["tutor", "payoff"], 8.00, 500),
    C("Vraska, Relic Seeker", "Legendary Planeswalker — Vraska", "{4}{B}{G}", ["B", "G"], ["spot_removal", "payoff"], 5.00, 480),
    // ── Counters / proliferate payoffs (11) ──
    C("Doubling Season", "Enchantment", "{4}{G}{G}", ["G"], ["payoff"], 45.00, 33),
    C("Deepglow Skate", "Creature — Fish", "{4}{U}", ["U"], ["payoff"], 3.40, 980),
    C("Evolution Sage", "Creature — Elf Druid", "{3}{G}", ["G"], ["payoff"], 2.50, 410),
    C("Flux Channeler", "Creature — Human Wizard", "{2}{U}", ["U"], ["payoff"], 1.80, 520),
    C("Vorinclex, Monstrous Raider", "Legendary Creature — Phyrexian Praetor", "{4}{G}{G}", ["G"], ["payoff"], 18.00, 145),
    C("Pir, Imaginative Rascal", "Legendary Creature — Human", "{2}{G}", ["G"], ["payoff"], 2.10, 1320),
    C("The Chain Veil", "Legendary Artifact", "{4}", [], ["payoff"], 12.00, 300),
    C("Oath of Teferi", "Legendary Enchantment", "{3}{W}{U}", ["W", "U"], ["payoff"], 3.00, 600),
    C("Atraxa's Skitterfang", "Creature — Phyrexian Insect", "{5}", [], ["payoff"], 1.50, 700),
    C("Carth the Lion", "Legendary Creature — Elf Warrior", "{3}{B}{G}", ["B", "G"], ["payoff", "card_advantage"], 9.00, 220),
    C("Inexorable Tide", "Enchantment", "{3}{U}{U}", ["U"], ["payoff"], 4.20, 1100),
    // ── Lands (36) ──
    C("Command Tower", "Land", "", [], ["land", "fixing"], 1.00, 5),
    C("Exotic Orchard", "Land", "", [], ["land", "fixing"], 1.50, 220),
    C("Reflecting Pool", "Land", "", [], ["land", "fixing"], 6.00, 240),
    C("City of Brass", "Land", "", [], ["land", "fixing"], 5.00, 280),
    C("Mana Confluence", "Land", "", [], ["land", "fixing"], 40.00, 110),
    C("Path of Ancestry", "Land", "", [], ["land", "fixing"], 1.00, 130),
    C("Breeding Pool", "Land — Forest Island", "", [], ["land", "fixing"], 14.00, 90),
    C("Watery Grave", "Land — Island Swamp", "", [], ["land", "fixing"], 13.00, 95),
    C("Overgrown Tomb", "Land — Swamp Forest", "", [], ["land", "fixing"], 12.00, 100),
    C("Hallowed Fountain", "Land — Plains Island", "", [], ["land", "fixing"], 13.00, 98),
    C("Temple Garden", "Land — Forest Plains", "", [], ["land", "fixing"], 12.00, 102),
    C("Godless Shrine", "Land — Plains Swamp", "", [], ["land", "fixing"], 12.00, 104),
    C("Drowned Catacomb", "Land", "", [], ["land", "fixing"], 6.00, 320),
    C("Glacial Fortress", "Land", "", [], ["land", "fixing"], 6.00, 330),
    C("Woodland Cemetery", "Land", "", [], ["land", "fixing"], 6.00, 340),
    C("Sunpetal Grove", "Land", "", [], ["land", "fixing"], 6.00, 350),
    C("Indatha Triome", "Land — Plains Swamp Forest", "", [], ["land", "fixing"], 5.00, 160),
    C("Zagoth Triome", "Land — Swamp Forest Island", "", [], ["land", "fixing"], 8.00, 158),
    C("Raffine's Tower", "Land — Plains Island Swamp", "", [], ["land", "fixing"], 4.00, 162),
    C("Spara's Headquarters", "Land — Forest Plains Island", "", [], ["land", "fixing"], 4.00, 164),
    C("Misty Rainforest", "Land", "", [], ["land", "fixing"], 22.00, 120),
    C("Verdant Catacombs", "Land", "", [], ["land", "fixing"], 20.00, 122),
    C("Marsh Flats", "Land", "", [], ["land", "fixing"], 16.00, 124),
    C("Karn's Bastion", "Land", "", [], ["land", "payoff"], 6.00, 250),
    C("Plains", "Basic Land — Plains", "", [], ["land"], 0.20, 9000),
    C("Plains", "Basic Land — Plains", "", [], ["land"], 0.20, 9001),
    C("Plains", "Basic Land — Plains", "", [], ["land"], 0.20, 9002),
    C("Island", "Basic Land — Island", "", [], ["land"], 0.20, 9003),
    C("Island", "Basic Land — Island", "", [], ["land"], 0.20, 9004),
    C("Island", "Basic Land — Island", "", [], ["land"], 0.20, 9005),
    C("Swamp", "Basic Land — Swamp", "", [], ["land"], 0.20, 9006),
    C("Swamp", "Basic Land — Swamp", "", [], ["land"], 0.20, 9007),
    C("Swamp", "Basic Land — Swamp", "", [], ["land"], 0.20, 9008),
    C("Forest", "Basic Land — Forest", "", [], ["land"], 0.20, 9009),
    C("Forest", "Basic Land — Forest", "", [], ["land"], 0.20, 9010),
    C("Forest", "Basic Land — Forest", "", [], ["land"], 0.20, 9011),
  ];

  // A few cards flagged illegal (force-added / out of identity) for the editor demo
  const illegal = [
    C("Lightning Bolt", "Instant", "{R}", ["R"], ["spot_removal"], 1.20, 5),
  ];

  // Search results (card_search output) — proliferate payoffs that fit WUBG
  const searchResults = [
    C("Evolution Sage", "Creature — Elf Druid", "{3}{G}", ["G"], ["payoff"], 2.50, 410),
    C("Flux Channeler", "Creature — Human Wizard", "{2}{U}", ["U"], ["payoff"], 1.80, 520),
    C("Karn's Bastion", "Land", "", [], ["land", "payoff"], 6.00, 250),
    C("Tezzeret's Gambit", "Sorcery", "{3}{U/P}", ["U"], ["card_draw", "payoff"], 1.10, 690),
    C("Inexorable Tide", "Enchantment", "{3}{U}{U}", ["U"], ["payoff"], 4.20, 1100),
    C("Deepglow Skate", "Creature — Fish", "{4}{U}", ["U"], ["payoff"], 3.40, 980),
    C("Contentious Plan", "Sorcery", "{1}{U}", ["U"], ["card_draw", "payoff"], 0.40, 1500),
    C("Pir, Imaginative Rascal", "Legendary Creature — Human", "{2}{G}", ["G"], ["payoff"], 2.10, 1320),
  ];

  // Recommendations (meta_recommendations) with synergy/inclusion
  const recommendations = [
    Object.assign(C("Atraxa's Skitterfang", "Creature", "{5}", [], ["payoff"], 1.50, 700), { inclusion: 0.62, synergy: 0.41 }),
    Object.assign(C("Carth the Lion", "Legendary Creature — Elf Warrior", "{3}{B}{G}", ["B", "G"], ["payoff"], 9.00, 220), { inclusion: 0.48, synergy: 0.55 }),
    Object.assign(C("The Chain Veil", "Legendary Artifact", "{4}", [], ["payoff"], 12.00, 300), { inclusion: 0.30, synergy: 0.62 }),
  ];

  // Collection (owned cards) — owned flag + qty
  const collection = [
    Object.assign({}, C("Sol Ring", "Artifact", "{1}", [], ["ramp", "mana_rock"], 1.49, 1), { owned: 4 }),
    Object.assign({}, C("Rhystic Study", "Enchantment", "{2}{U}", ["U"], ["card_draw"], 28.00, 2), { owned: 1 }),
    Object.assign({}, C("Counterspell", "Instant", "{U}{U}", ["U"], ["counterspell"], 0.80, 9), { owned: 3 }),
    Object.assign({}, C("Cultivate", "Sorcery", "{2}{G}", ["G"], ["ramp"], 0.50, 21), { owned: 2 }),
    Object.assign({}, C("Demonic Tutor", "Sorcery", "{1}{B}", ["B"], ["tutor"], 30.00, 3), { owned: 1 }),
    Object.assign({}, C("Beast Within", "Instant", "{2}{G}", ["G"], ["spot_removal"], 1.10, 30), { owned: 2 }),
    Object.assign({}, C("Llanowar Elves", "Creature — Elf Druid", "{G}", ["G"], ["ramp", "mana_dork"], 0.30, 90), { owned: 5 }),
    Object.assign({}, C("Wrath of God", "Sorcery", "{2}{W}{W}", ["W"], ["board_wipe"], 6.00, 25), { owned: 1 }),
  ];

  // analyze_* outputs
  const analysis = {
    curve: { "0": 3, "1": 9, "2": 16, "3": 18, "4": 12, "5": 7, "6": 4, "7+": 3 },
    pips: { W: 21, U: 24, B: 19, R: 0, G: 17 },
    sources: { W: 17, U: 19, B: 16, R: 0, G: 17 },
    threshold: 11,
    underSupported: [],
    composition: { Creature: 24, Instant: 11, Sorcery: 9, Artifact: 8, Enchantment: 10, Planeswalker: 6, Land: 36 },
    coverage: [
      { role: "ramp", have: 11, want_min: 8, want_max: 12, status: "ok" },
      { role: "card_draw", have: 7, want_min: 8, want_max: 12, status: "under" },
      { role: "spot_removal", have: 8, want_min: 5, want_max: 10, status: "ok" },
      { role: "board_wipe", have: 3, want_min: 2, want_max: 4, status: "ok" },
      { role: "protection", have: 2, want_min: 2, want_max: 8, status: "ok" },
      { role: "tutor", have: 4, want_min: 0, want_max: 10, status: "ok" },
      { role: "land", have: 36, want_min: 33, want_max: 38, status: "ok" },
    ],
    stats: { total_cards: 100, nonland_cards: 64, avg_mv: 3.18, avg_mv_nonland: 3.42, total_price_usd: 642.30, min_buy_usd: 511.80 },
    sim: {
      trials: 1000, keepable_rate: 0.684, mulligan_rate: 0.316, dead_on_arrival_rate: 0.142,
      avg_opening_lands: 2.9, first_spell_rate: 0.992, avg_turn_to_first_spell: 1.8,
      lands_by_turn: { 1: 0.9, 2: 1.7, 3: 2.5, 4: 3.2, 5: 3.9, 6: 4.5, 7: 5.0, 8: 5.4, 9: 5.8, 10: 6.1 },
    },
    bracket: {
      bracket: 3,
      pushers: {
        game_changers: ["Smothering Tithe", "Rhystic Study", "The Chain Veil"],
        fast_mana: ["Sol Ring"],
        tutors: ["Demonic Tutor", "Vampiric Tutor", "Enlightened Tutor"],
        mld: [],
        combos: [],
        extra_turns: [],
      },
    },
    violations: [
      { rule: "COLOR_IDENTITY", severity: "error", card: "Lightning Bolt", detail: "R not in deck identity WUBG", fix_hint: "Remove or change commander" },
      { rule: "CARD_COUNT", severity: "warning", detail: "99 cards + 1 commander = 100 — OK", fix_hint: "" },
    ],
  };

  window.MB = {
    snapshot: "2026-06-27",
    deckName: "Atraxa Superfriends",
    deckIdentity: ["W", "U", "B", "G"],
    commander, deck, illegal, searchResults, recommendations, collection, analysis,
    themes: ["Superfriends", "Proliferate", "+1/+1 Counters", "Planeswalkers", "Value"],
  };
})();
