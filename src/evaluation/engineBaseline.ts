/** Frozen evaluation inputs only; this module implements no gameplay or support verdict. */
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { digestEvaluation } from "./registration.js";

// Validate only fields used by this audit. Passthrough retains CardGameplay unchanged;
// this projection is not a second canonical card model or a rules parser.
const characteristics = z.object({ oracle_text: z.string() }).passthrough();
const recordSchema = z
  .object({
    oracle_id: z.string(),
    name: z.string(),
    gameplay: z
      .object({
        version: z.literal(1),
        source: z.object({ oracle_id: z.string() }).passthrough(),
        layout: z.literal("normal"),
        playability: z.literal("not_evaluated"),
        color_identity: z.array(z.string()),
        characteristics,
        faces: z.array(
          z
            .object({
              face_index: z.number().int().nonnegative(),
              source_path: z.string(),
              characteristics,
            })
            .passthrough(),
        ),
      })
      .passthrough(),
    source_artifacts: z.array(z.unknown()),
  })
  .passthrough();
const corpusSchema = z
  .object({
    version: z.literal("engine-mvp-baseline-v1"),
    status: z.literal("preregistered-not-executed"),
    data_snapshot: z.string(),
    source: z
      .object({
        final_deck: z.object({
          name: z.string(),
          sha256: z.string(),
          json_pointer: z.string(),
        }),
        artifacts: z.array(
          z.object({
            name: z.string(),
            sha256: z.string(),
            data_snapshot: z.string(),
          }),
        ),
      })
      .passthrough(),
    deck: z
      .object({
        commanders: z.array(z.string()),
        cards: z.array(
          z.object({
            oracle_id: z.string(),
            name: z.string(),
            qty: z.number().int().positive(),
          }),
        ),
      })
      .passthrough(),
    pod: z
      .object({
        seats: z.number(),
        cards_per_seat: z.number(),
        initial_physical_cards: z.number(),
      })
      .passthrough(),
    records: z.array(recordSchema),
    requirements: z.array(
      z
        .object({
          oracle_id: z.string(),
          name: z.string(),
          owners: z.array(z.string()),
          scenarios: z.array(z.string()),
          spans: z.array(
            z.object({
              face_index: z.number(),
              start: z.number(),
              end: z.number(),
            }),
          ),
        })
        .passthrough(),
    ),
    generated_objects: z.array(
      z
        .object({
          name: z.string(),
          source_cards: z.array(z.object({ oracle_id: z.string(), name: z.string() })),
          requirement: z.string(),
          coverage_status: z.literal("not_assessed"),
          full_canonical_token_record_captured: z.literal(false),
        })
        .passthrough(),
    ),
    shared_requirements: z.array(z.unknown()),
    registration: z
      .object({
        seeds: z.array(z.number().int().nonnegative()),
        limits: z.object({ max_game_wall_ms: z.number().int().positive() }).passthrough(),
      })
      .passthrough(),
    integrity: z.record(z.string(), z.string()),
  })
  .passthrough();

// This literal lives outside the mutable fixture so rehashing a changed component cannot rebaseline v1.
const frozenCorpusDigest = "9943f2273bce833ae685e74798f636811260ca185b76efa88f39ec2544034498";

export type EngineBaseline = z.infer<typeof corpusSchema>;

export async function loadEngineBaseline(): Promise<EngineBaseline> {
  const raw: unknown = JSON.parse(
    await readFile(
      new URL("../../docs/evaluation/engine-mvp/corpus-v1.json", import.meta.url),
      "utf8",
    ),
  );
  const parsed = corpusSchema.parse(raw);
  if (digestEvaluation(raw) !== digestEvaluation(parsed)) {
    throw new Error("Baseline schema discarded frozen input fields");
  }
  return parsed;
}

/** Inventory integrity is not card support, rules conformance or engine release acceptance. */
export function validateEngineBaseline(value: EngineBaseline): string[] {
  const errors = new Set<string>();
  if (digestEvaluation(value) !== frozenCorpusDigest) errors.add("frozen corpus changed");
  const components = {
    deck: value.deck,
    pod: value.pod,
    records: value.records,
    requirements: value.requirements,
    "generated objects": value.generated_objects,
    registration: value.registration,
    source: value.source,
    "shared requirements": value.shared_requirements,
  };
  for (const [key, data] of Object.entries(components)) {
    if (value.integrity[key] !== digestEvaluation(data)) errors.add(key + " changed");
  }
  const ids = [...value.deck.commanders, ...value.deck.cards.map((card) => card.oracle_id)];
  const recordIds = value.records.map((record) => record.oracle_id);
  if (
    ids.length !== 77 ||
    new Set(ids).size !== 77 ||
    recordIds.length !== 77 ||
    new Set(recordIds).size !== 77 ||
    ids.some((id) => !recordIds.includes(id))
  ) {
    errors.add("record identities");
  }
  const count = value.deck.cards.reduce((sum, card) => sum + card.qty, 0);
  if (
    count !== 99 ||
    value.deck.commanders.length !== 1 ||
    value.pod.seats !== 4 ||
    value.pod.cards_per_seat !== 100 ||
    value.pod.initial_physical_cards !== 400
  ) {
    errors.add("pod identity");
  }
  const requirementIds = value.requirements.map((row) => row.oracle_id);
  if (
    requirementIds.length !== 77 ||
    new Set(requirementIds).size !== 77 ||
    ids.some((id) => !requirementIds.includes(id))
  )
    errors.add("requirement identities");
  const owners = new Set(
    [
      "decisions",
      "multiplayer",
      "commander",
      "mulligans",
      "effects",
      "zones",
      "layers",
      "lands",
      "graveyard",
      "alternate-costs",
      "combat-objects",
      "planeswalkers",
    ].map((name) => "engine-mvp-" + name),
  );
  for (const record of value.records) {
    if (record.gameplay.source.oracle_id !== record.oracle_id) errors.add("source identity");
    const row = value.requirements.find((entry) => entry.oracle_id === record.oracle_id);
    if (!row) continue;
    if (
      row.name !== record.name ||
      row.owners.length === 0 ||
      row.owners.some((owner) => !owners.has(owner)) ||
      row.scenarios.length === 0 ||
      row.scenarios.some((scenario) => scenario.trim().length < 20)
    ) {
      errors.add("requirement obligations");
    }
    const expected: { face_index: number; start: number; end: number }[] = [];
    for (const face of record.gameplay.faces) {
      let offset = 0;
      for (const paragraph of face.characteristics.oracle_text.split("\n")) {
        if (paragraph.length)
          expected.push({
            face_index: face.face_index,
            start: offset,
            end: offset + paragraph.length,
          });
        offset += paragraph.length + 1;
      }
    }
    if (
      record.gameplay.faces.length !== 1 ||
      record.gameplay.faces[0]?.characteristics.oracle_text !==
        record.gameplay.characteristics.oracle_text ||
      digestEvaluation(row.spans) !== digestEvaluation(expected)
    )
      errors.add("Oracle span coverage");
  }
  for (const token of value.generated_objects) {
    if (
      token.source_cards.length === 0 ||
      token.source_cards.some((card) => !ids.includes(card.oracle_id))
    ) {
      errors.add("generated object sources");
    }
  }
  if (value.source.artifacts.some((source) => source.data_snapshot !== value.data_snapshot)) {
    errors.add("snapshot provenance");
  }
  return [...errors];
}
