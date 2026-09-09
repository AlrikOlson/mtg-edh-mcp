import { describe, expect, it } from "vitest";
import { modelCardMana } from "./manaModel.js";
import { manaCard, manaFixtures as f } from "./manaModel.fixture.js";
import { sequenceMana, replayManaSequence, type SequenceCard } from "./manaSequence.js";

const physical = (key: keyof typeof f, id: string = key): SequenceCard => ({
  id,
  model: modelCardMana(f[key]),
});
const spell = (cost: string, id = "target"): SequenceCard => ({
  id,
  model: modelCardMana(
    manaCard(id, { mana_cost: cost, type_line: "Sorcery", oracle_text: "Draw a card." }),
  ),
});
const targetOptions = (turns: number, handSize: number, id = "target") => ({
  maxTurns: turns,
  handSize,
  target: { oracle_id: id },
});

describe("deterministic legal mana sequencing", () => {
  it("cannot use abundant wrong colors or colored mana for true colorless", () => {
    expect(
      sequenceMana(
        [physical("forest"), physical("forest", "f2"), spell("{U}")],
        [],
        targetOptions(2, 3),
      ).status,
    ).toBe("failure");
    expect(sequenceMana([physical("island"), spell("{C}")], [], targetOptions(1, 2)).status).toBe(
      "failure",
    );
    expect(
      sequenceMana([physical("wastes"), spell("{C}")], [], targetOptions(1, 2)).target_cast_turn,
    ).toBe(1);
  });
  it("searches flexible alternatives without using the same dual twice", () => {
    expect(
      sequenceMana([physical("tropical"), spell("{G}{U}")], [], targetOptions(1, 2)).status,
    ).toBe("failure");
    expect(
      sequenceMana(
        [physical("tropical"), physical("forest"), spell("{G}{U}")],
        [],
        targetOptions(2, 3),
      ).target_cast_turn,
    ).toBe(2);
  });
  it("delays tapped lands and paid tapped artifacts", () => {
    expect(
      sequenceMana([physical("guildgate"), spell("{U}")], [], targetOptions(2, 2)).target_cast_turn,
    ).toBe(2);
    const library = [
      physical("wastes"),
      physical("wastes", "w2"),
      physical("diamond"),
      spell("{U}"),
    ];
    expect(sequenceMana(library, [], targetOptions(3, 4)).target_cast_turn).toBe(3);
  });
  it("pays Sol Ring before using its mana, keeps excess mana, and does not spend a land twice", () => {
    const library = [physical("wastes"), physical("ring"), physical("ring", "r2"), spell("{3}")];
    const options = targetOptions(2, 4);
    const result = sequenceMana(library, [], options);
    expect(result.target_cast_turn).toBe(1);
    expect(result.first_spell_turn).toBe(1);
    expect(result.turns[0]?.actions.filter((a) => a.kind === "play")).toHaveLength(3);
    expect(replayManaSequence(library, [], options, result).ok).toBe(true);
    expect(sequenceMana([physical("ring"), spell("{1}")], [], targetOptions(1, 2)).status).toBe(
      "failure",
    );
    expect(
      sequenceMana([physical("wastes"), physical("ring"), spell("{3}")], [], targetOptions(1, 3))
        .status,
    ).toBe("failure");
  });
  it("pays Signet activation from available mana before crediting output", () => {
    const library = [
      physical("wastes"),
      physical("wastes", "w2"),
      physical("signet"),
      spell("{W}{U}"),
    ];
    expect(sequenceMana(library, [], targetOptions(3, 4)).target_cast_turn).toBe(3);
    const withRing = [physical("wastes"), physical("ring"), physical("signet"), spell("{W}{U}")];
    expect(sequenceMana(withRing, [], targetOptions(1, 4)).status).toBe("failure");
  });
  it("does not tap a newly paid mana creature", () => {
    const library = [physical("forest"), physical("elves"), spell("{G}{G}")];
    expect(sequenceMana(library, [], targetOptions(2, 3)).target_cast_turn).toBe(2);
    expect(sequenceMana(library, [], targetOptions(1, 3)).status).toBe("failure");
  });
  it("can pay a commander without drawing it, but library spells must be drawn", () => {
    const commander = spell("{G}");
    expect(
      sequenceMana([physical("forest")], [commander], {
        ...targetOptions(1, 1),
        target: { oracle_id: "target", zone: "command" },
      }).target_cast_turn,
    ).toBe(1);
    expect(
      sequenceMana([physical("forest"), commander], [], targetOptions(1, 1)).target_cast_turn,
    ).toBe(null);
    expect(
      sequenceMana([physical("forest"), commander], [], {
        ...targetOptions(1, 1),
        onThePlay: false,
      }).target_cast_turn,
    ).toBe(1);
  });
  it("reserves named spell MDFCs and chooses a single land face for other MDFCs", () => {
    const options = targetOptions(3, 2, f.tangled.oracle_id);
    const result = sequenceMana([physical("tangled"), physical("forest")], [], options);
    expect(result.status).toBe("failure");
    expect(result.turns.map((t) => t.lands_in_play)).toEqual([1, 1, 1]);
    expect(sequenceMana([physical("pathway"), spell("{U}")], [], targetOptions(1, 2)).status).toBe(
      "failure",
    );
  });
  it("fetches only a physical remaining basic, enters tapped and removes its draw copy", () => {
    const library = [physical("wilds"), spell("{G}"), physical("forest")];
    const options = targetOptions(3, 2);
    const result = sequenceMana(library, [], options);
    expect(result.target_cast_turn).toBe(2);
    expect(result.turns.map((t) => t.lands_in_play)).toEqual([1, 1, 1]);
    expect(result.turns.map((t) => t.drawn)).toEqual([null, null, null]);
    expect(replayManaSequence(library, [], options, result).ok).toBe(true);
    expect(
      sequenceMana([physical("wilds"), spell("{G}"), physical("tropical")], [], options)
        .target_cast_turn,
    ).toBe(2);
    expect(sequenceMana([physical("wilds"), spell("{G}")], [], targetOptions(2, 2)).status).toBe(
      "failure",
    );
  });
  it("rejects altered payments, duplicate activations, invented draws and false success", () => {
    const library = [physical("forest"), spell("{G}")];
    const options = targetOptions(2, 2);
    const result = sequenceMana(library, [], options);
    for (const alter of [
      (r: typeof result) => {
        if (r.turns[0]?.cast) r.turns[0].cast.payment = ["U"];
      },
      (r: typeof result) => {
        const a = r.turns[0]?.actions.find((a) => a.kind === "activate");
        if (a) r.turns[0]?.actions.push(a);
      },
      (r: typeof result) => {
        if (r.turns[0]) r.turns[0].drawn = "target";
      },
      (r: typeof result) => {
        r.target_cast_turn = 2;
      },
    ]) {
      const changed = structuredClone(result);
      alter(changed);
      expect(replayManaSequence(library, [], options, changed).ok).toBe(false);
    }
  });
  it("is deterministic, counts the first supported spell, and keeps land turns after success", () => {
    const library = [physical("forest"), physical("elves"), physical("forest", "f2")];
    const result = sequenceMana(library, [], { handSize: 2, maxTurns: 3 });
    expect(result.first_spell_turn).toBe(1);
    expect(result.turns.map((t) => t.lands_in_play)).toEqual([1, 2, 2]);
    expect(sequenceMana(library, [], { handSize: 2, maxTurns: 3 })).toEqual(result);
  });
  it("reports unsupported targets and bounds without claiming an impossible result", () => {
    expect(sequenceMana([physical("forest"), spell("{X}")], [], targetOptions(2, 2)).status).toBe(
      "unsupported",
    );
    const result = sequenceMana([physical("tropical"), spell("{G}{U}")], [], {
      ...targetOptions(2, 2),
      maxWork: 1,
    });
    expect(result.status).toBe("truncated");
    expect(result.work).toBeLessThanOrEqual(1);
    expect(sequenceMana([physical("forest"), physical("forest")], [], {}).status).toBe(
      "unsupported",
    );
  });
});

it("retains only witnessed cast summaries when a later search truncates", () => {
  const library = [physical("wastes"), physical("ring"), physical("ring", "r2"), spell("{20}")];
  for (let maxWork = 1; maxWork < 70; maxWork++) {
    const options = { ...targetOptions(3, 4), maxWork };
    const result = sequenceMana(library, [], options);
    expect(result.replay.ok, `work ${maxWork}`).toBe(true);
    const firstRecordedSpell = result.turns.find(
      (turn) =>
        turn.cast || turn.actions.some((a) => a.kind === "play" && a.source_id.startsWith("r")),
    );
    expect(result.first_spell_turn).toBe(firstRecordedSpell?.turn ?? null);
    const tampered = structuredClone(result);
    tampered.target_cast_turn = 1;
    expect(replayManaSequence(library, [], options, tampered).ok).toBe(false);
  }
});

it("retains used override assumptions and rejects MDFC double spending in replay", () => {
  const reason = "Assume Reflecting Pool has an unconditional green output";
  const pool: SequenceCard = {
    id: "assumed-pool",
    model: modelCardMana(f.pool, {
      overrides: [
        {
          oracle_id: f.pool.oracle_id,
          face_index: 0,
          reason,
          source: {
            outputs: [["G"]],
            activation_cost: "{0}",
            enters_tapped: false,
            summoning_delay: false,
          },
        },
      ],
    }),
  };
  const options = targetOptions(1, 2);
  const result = sequenceMana([pool, spell("{G}")], [], options);
  expect(result.status).toBe("success");
  expect(result.assumptions).toContain(reason);
  const library = [physical("pathway"), spell("{G}")];
  const mdfc = sequenceMana(library, [], options);
  mdfc.turns[0]?.actions.unshift({ kind: "play", source_id: "pathway", face_index: 1 });
  expect(replayManaSequence(library, [], options, mdfc).ok).toBe(false);
});

it("finds a Signet activation allocation that preserves a second required blue mana", () => {
  const library = [physical("island"), physical("wastes"), physical("signet"), spell("{W}{U}{U}")];
  const result = sequenceMana(library, [], targetOptions(3, 4));
  expect(result.target_cast_turn).toBe(3);
  expect(
    result.turns[2]?.actions.find(
      (action) => action.kind === "activate" && action.source_id === "signet",
    ),
  ).toMatchObject({ payment: ["C"] });
  expect(result.replay.ok).toBe(true);
});
