import { describe, it, expect } from "vitest";
import { classifyRoles, type RoleInput } from "./index.js";

function c(partial: Partial<RoleInput> & { name: string }): RoleInput {
  return {
    type_line: "",
    oracle_text: "",
    keywords: [],
    mana_cost: "",
    ...partial,
  };
}

describe("classifyRoles", () => {
  it("Sol Ring -> ramp + mana_rock", () => {
    const roles = classifyRoles(
      c({ name: "Sol Ring", type_line: "Artifact", oracle_text: "{T}: Add {C}{C}." }),
    );
    expect(roles).toContain("ramp");
    expect(roles).toContain("mana_rock");
    expect(roles).not.toContain("mana_dork");
  });

  it("Llanowar Elves -> ramp + mana_dork", () => {
    const roles = classifyRoles(
      c({
        name: "Llanowar Elves",
        type_line: "Creature — Elf Druid",
        oracle_text: "{T}: Add {G}.",
      }),
    );
    expect(roles).toContain("ramp");
    expect(roles).toContain("mana_dork");
    expect(roles).not.toContain("mana_rock");
  });

  it("Cultivate -> ramp (land search), not tutor", () => {
    const roles = classifyRoles(
      c({
        name: "Cultivate",
        type_line: "Sorcery",
        oracle_text:
          "Search your library for up to two basic land cards, reveal those cards, put one onto the battlefield tapped and the other into your hand, then shuffle.",
      }),
    );
    expect(roles).toContain("ramp");
    expect(roles).not.toContain("tutor");
  });

  it("Demonic Tutor -> tutor", () => {
    const roles = classifyRoles(
      c({
        name: "Demonic Tutor",
        type_line: "Sorcery",
        oracle_text: "Search your library for a card, put that card into your hand, then shuffle.",
      }),
    );
    expect(roles).toContain("tutor");
  });

  it("Counterspell -> counterspell", () => {
    const roles = classifyRoles(
      c({ name: "Counterspell", type_line: "Instant", oracle_text: "Counter target spell." }),
    );
    expect(roles).toEqual(["counterspell"]);
  });

  it("Swords to Plowshares -> spot_removal", () => {
    const roles = classifyRoles(
      c({
        name: "Swords to Plowshares",
        type_line: "Instant",
        oracle_text: "Exile target creature. Its controller gains life equal to its power.",
      }),
    );
    expect(roles).toContain("spot_removal");
    expect(roles).not.toContain("board_wipe");
  });

  it("Wrath of God -> board_wipe (not spot_removal)", () => {
    const roles = classifyRoles(
      c({
        name: "Wrath of God",
        type_line: "Sorcery",
        oracle_text: "Destroy all creatures. They can't be regenerated.",
      }),
    );
    expect(roles).toContain("board_wipe");
    expect(roles).not.toContain("spot_removal");
  });

  it("a basic land -> land", () => {
    const roles = classifyRoles(
      c({ name: "Forest", type_line: "Basic Land — Forest", oracle_text: "({T}: Add {G}.)" }),
    );
    expect(roles).toContain("land");
  });

  it("a fixing land that taps for any color -> fixing", () => {
    const roles = classifyRoles(
      c({
        name: "Command Tower",
        type_line: "Land",
        oracle_text: "{T}: Add one mana of any color in your commander's color identity.",
      }),
    );
    expect(roles).toContain("fixing");
  });

  it("a draw spell -> card_draw + card_advantage", () => {
    const roles = classifyRoles(
      c({ name: "Divination", type_line: "Sorcery", oracle_text: "Draw two cards." }),
    );
    expect(roles).toContain("card_draw");
    expect(roles).toContain("card_advantage");
  });

  it("a vanilla creature -> no roles", () => {
    const roles = classifyRoles(
      c({ name: "Grizzly Bears", type_line: "Creature — Bear", oracle_text: "" }),
    );
    expect(roles).toEqual([]);
  });

  it("returns roles in canonical ROLES order", () => {
    const roles = classifyRoles(
      c({ name: "Sol Ring", type_line: "Artifact", oracle_text: "{T}: Add {C}{C}." }),
    );
    // ramp (index 0) precedes mana_rock (index 1)
    expect(roles).toEqual(["ramp", "mana_rock"]);
  });
});
