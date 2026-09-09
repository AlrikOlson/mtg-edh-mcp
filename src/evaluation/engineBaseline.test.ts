import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { digestEvaluation } from "./registration.js";
import {
  loadEngineBaseline,
  validateEngineBaseline,
  type EngineBaseline,
} from "./engineBaseline.js";

async function changed(change: (value: EngineBaseline) => void) {
  const value = structuredClone(await loadEngineBaseline());
  change(value);
  return validateEngineBaseline(value);
}

describe("frozen engine MVP baseline", () => {
  it("preserves the complete captured fixture through its audit projection", async () => {
    const raw: unknown = JSON.parse(
      await readFile(
        new URL("../../docs/evaluation/engine-mvp/corpus-v1.json", import.meta.url),
        "utf8",
      ),
    );
    expect(await loadEngineBaseline()).toEqual(raw);
  });

  it("rejects rehashed quantity redistribution that keeps every identity and total", async () => {
    expect(
      await changed((value) => {
        const forest = value.deck.cards.find((card) => card.name === "Forest");
        const swamp = value.deck.cards.find((card) => card.name === "Swamp");
        if (!forest || !swamp) throw new Error("Missing captured basics");
        forest.qty -= 1;
        swamp.qty += 1;
        value.integrity.deck = digestEvaluation(value.deck);
      }),
    ).toContain("frozen corpus changed");
  });

  it("rejects changed mirror metadata even when embedded hashes are recomputed", async () => {
    expect(
      await changed((value) => {
        value.pod.kind = "mixed_decks";
        value.integrity.pod = digestEvaluation(value.pod);
      }),
    ).toContain("frozen corpus changed");
  });

  it("rejects rehashed benchmark targets and seed selection", async () => {
    expect(
      await changed((value) => {
        value.registration.seeds = [42];
        value.registration.limits.max_game_wall_ms *= 10;
        value.integrity.registration = digestEvaluation(value.registration);
      }),
    ).toContain("frozen corpus changed");
  });

  it("retains the exact captured deck and all canonical gameplay records", async () => {
    const value = await loadEngineBaseline();
    expect(validateEngineBaseline(value)).toEqual([]);
    expect(value.source.final_deck.sha256).toBe(
      "78f4902da75187845104d41f5a972d55be22515f1f44e42450b34637e05713c0",
    );
    expect(digestEvaluation(value.records)).toBe(
      "8f610fa5c0854791d79c7bfa0b41db53c1880e2f06c7a13f040ad3c8f8477893",
    );
    expect(value.records).toHaveLength(77);
    expect(value.deck.cards.reduce((sum, card) => sum + card.qty, 0)).toBe(99);
    expect(value.pod.initial_physical_cards).toBe(400);
  });

  it("rejects replacing a difficult card while preserving deck size", async () => {
    expect(
      await changed((value) => {
        const card = value.deck.cards.find((entry) => entry.name === "Living Death");
        if (!card) throw new Error("Missing fixed benchmark card");
        card.oracle_id = value.deck.commanders[0] ?? "";
      }),
    ).toContain("deck changed");
  });

  it("rejects duplicate definitions and missing source identities", async () => {
    expect(
      await changed((value) => {
        value.records.pop();
      }),
    ).toContain("record identities");
    expect(
      await changed((value) => {
        const first = value.records[0];
        if (!first) throw new Error("Missing fixture record");
        value.records.push(first);
      }),
    ).toContain("record identities");
  });

  it("rejects changed Oracle text even when an identity is unchanged", async () => {
    expect(
      await changed((value) => {
        const record = value.records[0];
        if (!record) throw new Error("Missing fixture record");
        record.gameplay.characteristics.oracle_text = "";
      }),
    ).toContain("records changed");
  });

  it("rejects missing or truncated Oracle paragraph obligations", async () => {
    expect(
      await changed((value) => {
        const row = value.requirements[0];
        if (!row) throw new Error("Missing requirement");
        row.spans.pop();
      }),
    ).toContain("Oracle span coverage");
  });

  it("requires named owners and nonempty scenario obligations", async () => {
    expect(
      await changed((value) => {
        const row = value.requirements[0];
        if (!row) throw new Error("Missing requirement");
        row.owners = ["invented-engine"];
        row.scenarios = [];
      }),
    ).toContain("requirement obligations");
  });

  it("retains all token requirements without claiming captured token definitions", async () => {
    const value = await loadEngineBaseline();
    expect(value.generated_objects.map((entry) => entry.name).sort()).toEqual([
      "Beast",
      "Goat",
      "Goblin Army",
      "Insect",
      "Skeleton Pirate",
      "Treasure",
      "Zombie",
    ]);
    expect(
      value.generated_objects.every(
        (entry) =>
          entry.coverage_status === "not_assessed" && !entry.full_canonical_token_record_captured,
      ),
    ).toBe(true);
    expect(
      await changed((copy) => {
        copy.generated_objects.pop();
      }),
    ).toContain("generated objects changed");
  });

  it("rejects an incorrect physical-instance count in the registered pod", async () => {
    expect(
      await changed((value) => {
        value.pod.initial_physical_cards = 100;
      }),
    ).toContain("pod identity");
  });

  it("rejects seed selection and budget drift after preregistration", async () => {
    expect(
      await changed((value) => {
        value.registration.seeds.pop();
      }),
    ).toContain("registration changed");
    expect(
      await changed((value) => {
        value.registration.limits.max_game_wall_ms *= 2;
      }),
    ).toContain("registration changed");
  });

  it("preserves all imported gameplay fields in the evaluation projection", async () => {
    const value = await loadEngineBaseline();
    const record = value.records.find((entry) => entry.name === "Muldrotha, the Gravetide");
    expect(record?.gameplay.playability).toBe("not_evaluated");
    expect(record?.gameplay.color_identity).toEqual(["B", "G", "U"]);
    expect(value.status).toBe("preregistered-not-executed");
  });
});
