/* Manabase UI kit — Oracle agent script.
   The app is a thin MCP client; the agent runs the engine's real tools. There's
   no live backend here, so these are believable scripted sequences: each intent
   streams a series of tool-call captions, then proposes a change-set (adds/cuts
   with reasons) the user accepts or rejects. Shapes mirror card_search /
   deck_add / validate_deck / analyze_* outputs. */
(function () {
  const card = (name, type, cost, ci, roles, usd, reason) => ({
    name, typeLine: type, manaCost: cost, identity: ci, roles: roles || [], priceUsd: usd, reason,
  });

  window.MB_AGENT = {
    // The slim chip suggestions shown under the ask bar.
    suggestions: [
      { id: "proliferate", label: "Add proliferate payoffs under $5" },
      { id: "fixlegal", label: "Fix legality errors" },
      { id: "consistency", label: "Make the deck more consistent" },
    ],

    intents: {
      proliferate: {
        prompt: "Add proliferate payoffs under $5",
        steps: [
          { tool: "card_search", args: "id<=wubg o:proliferate mv<=5", result: "312 hits" },
          { tool: "card_search", args: "+ usd<=5 -in_deck", result: "41 hits" },
          { tool: "meta_recommendations", args: "Atraxa · proliferate", result: "scored 41" },
          { tool: "validate_card", args: "× 5 candidates", result: "5 legal in WUBG" },
        ],
        adds: [
          card("Evolution Sage", "Creature — Elf Druid", "{3}{G}", ["G"], ["payoff"], 2.50, "Proliferates on every landfall"),
          card("Flux Channeler", "Creature — Human Wizard", "{2}{U}", ["U"], ["payoff"], 1.80, "Proliferates on noncreature casts"),
          card("Inexorable Tide", "Enchantment", "{3}{U}{U}", ["U"], ["payoff"], 4.20, "Proliferate engine — every spell"),
          card("Contentious Plan", "Sorcery", "{1}{U}", ["U"], ["card_draw", "payoff"], 0.40, "Draw + proliferate, cheap"),
          card("Tezzeret's Gambit", "Sorcery", "{3}{U/P}", ["U"], ["card_draw", "payoff"], 1.10, "Draw two + proliferate"),
        ],
        cuts: [],
        summary: "+5 proliferate payoffs, all ≤ $5 and legal in WUBG. +$10.00, avg MV +0.04.",
      },

      fixlegal: {
        prompt: "Fix legality errors",
        steps: [
          { tool: "validate_deck", args: "Atraxa Superfriends", result: "1 error" },
          { tool: "card_search", args: "id<=wubg is:removal mv<=2", result: "63 hits" },
        ],
        adds: [
          card("Despark", "Instant", "{W}{B}", ["W", "B"], ["spot_removal"], 2.10, "On-color removal, fills the cut"),
        ],
        cuts: [
          { name: "Lightning Bolt", reason: "R not in deck identity WUBG — COLOR_IDENTITY error" },
        ],
        summary: "Cut Lightning Bolt (off-color), added Despark. Deck is now legal.",
      },

      consistency: {
        prompt: "Make the deck more consistent",
        steps: [
          { tool: "analyze_curve", args: "exclude_lands", result: "avg MV 3.42" },
          { tool: "analyze_role_coverage", args: "default bands", result: "card_draw under (7/8–12)" },
          { tool: "simulateDeck", args: "trials:1000 seed:1", result: "keepable 68.4%" },
        ],
        adds: [
          card("Mystic Remora", "Enchantment", "{U}", ["U"], ["card_draw", "card_advantage"], 3.00, "Early card-advantage engine"),
          card("Night's Whisper", "Sorcery", "{1}{B}", ["B"], ["card_draw"], 4.00, "Cheap two-card draw"),
        ],
        cuts: [
          { name: "Doubling Season", reason: "6-MV, lowers curve; draw fills its slot" },
        ],
        summary: "+2 card draw, −1 six-drop. Projected keepable 68.4% → 74.1%.",
      },
    },
  };
})();
