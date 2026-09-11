/** Static evidence integrity only; all payment execution lives in canonical Rust. */
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { loadEngineBaseline, validateEngineBaseline } from "./engineBaseline.js";

const corpus = await loadEngineBaseline();
const fixture = z
  .object({
    version: z.literal(1),
    provenance: z.string().min(1),
    cases: z
      .array(
        z
          .object({
            id: z.string().min(1),
            expected: z.union([z.null(), z.object({ life: z.number() }).passthrough()]),
          })
          .passthrough(),
      )
      .min(1),
  })
  .strict()
  .parse(
    JSON.parse(
      await readFile(
        new URL("../../docs/evaluation/engine-mvp/mana-source-fixtures-v1.json", import.meta.url),
        "utf8",
      ),
    ),
  );
const coverage = z
  .object({
    version: z.literal(1),
    scope: z.literal("primitive-conformance-only"),
    cards: z.array(
      z
        .object({
          oracle_id: z.string(),
          name: z.string(),
          oracle_text: z.string(),
          spans: z.array(
            z
              .object({
                face_index: z.number(),
                start: z.number(),
                end: z.number(),
              })
              .strict(),
          ),
          scenario_refs: z.array(z.string()).min(1),
          remaining_bindings: z
            .array(
              z
                .object({
                  owner: z.enum([
                    "engine-mvp-lands",
                    "engine-mvp-commander",
                    "engine-mvp-multiplayer",
                    "engine-mvp-zones",
                    "engine-mvp-effects",
                    "engine-mvp-graveyard",
                    "engine-mvp-cost-choices",
                    "engine-mvp-combat-objects",
                    "engine-mvp-layers",
                  ]),
                  requirement: z.string().min(1),
                })
                .strict(),
            )
            .min(1),
        })
        .strict(),
    ),
  })
  .strict()
  .parse(
    JSON.parse(
      await readFile(
        new URL("../../docs/evaluation/engine-mvp/mana-source-coverage-v1.json", import.meta.url),
        "utf8",
      ),
    ),
  );

describe("independent canonical mana source evidence", () => {
  it("covers every frozen mana-producing identity, including generated Treasure text", () => {
    expect(validateEngineBaseline(corpus)).toEqual([]);
    // This is a fixed-fixture inventory check, never a runtime mana-ability classifier.
    const sources = corpus.records.filter((record) =>
      record.gameplay.characteristics.oracle_text.includes("Add "),
    );
    expect(coverage.cards.map((card) => card.oracle_id).sort()).toEqual(
      sources.map((card) => card.oracle_id).sort(),
    );
    for (const card of coverage.cards) {
      const record = sources.find((source) => source.oracle_id === card.oracle_id);
      const requirement = corpus.requirements.find((row) => row.oracle_id === card.oracle_id);
      expect(card.name).toBe(record?.name);
      expect(card.oracle_text).toBe(record?.gameplay.characteristics.oracle_text);
      expect(card.spans).toEqual(requirement?.spans);
    }
  });

  it("links real independently executed scenarios without duplicate or missing IDs", () => {
    const ids = fixture.cases.map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(fixture.cases.some((row) => row.expected === null)).toBe(true);
    expect(fixture.cases.some((row) => row.expected !== null)).toBe(true);
    for (const card of coverage.cards) {
      expect(new Set(card.scenario_refs).size).toBe(card.scenario_refs.length);
      for (const ref of card.scenario_refs) expect(ids, card.name).toContain(ref);
    }
    for (const id of [
      "one-dual-not-two",
      "signet-not-self-funded",
      "signet-fee-before-output",
      "ordered-source-chain",
      "ring-excess",
      "new-creature-ineligible",
      "creature-next-own-turn",
      "restricted-creature-surplus",
      "restricted-not-activation-fee",
      "life-sacrifice-rollback",
      "treasure-cannot-double-spend",
      "orchard-ungrounded-cycle",
    ]) {
      expect(ids).toContain(id);
    }
  });
});
