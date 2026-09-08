/** Strict validation shared by legacy migration, SQLite reads, and recovery. */
import { z } from "zod";
import { ROLES } from "../types/card.js";
import type { DeckStoreDump } from "./deckStore.js";

const identifier = z
  .string()
  .min(1)
  .refine((value) => !value.includes("\0"), "identifier contains NUL");
const deckSchema = z
  .object({
    deck_id: identifier,
    name: z.string(),
    format: z.literal("commander"),
    commanders: z.array(identifier),
    command_zone_kind: z.enum(["single", "partner", "background", "doctor_companion"]),
    companion: identifier.optional(),
    cards: z.array(
      z
        .object({
          oracle_id: identifier,
          qty: z.number().int().positive(),
          illegal: z.boolean().optional(),
        })
        .strict(),
    ),
    computed_color_identity: z.array(z.enum(["W", "U", "B", "R", "G"])),
    version: z.number().int().positive(),
    data_snapshot: z.string(),
    role_overrides: z.record(identifier, z.array(z.enum(ROLES))).optional(),
  })
  .strict();
const snapshotSchema = z
  .object({ snapshot_id: identifier, version: z.number().int().positive(), deck: deckSchema })
  .strict();
const dumpSchema = z
  .object({
    decks: z.array(z.tuple([z.string(), deckSchema])),
    snapshots: z.array(z.tuple([z.string(), snapshotSchema])),
  })
  .strict();

export function parseDeckStoreDump(value: unknown): DeckStoreDump {
  const dump = dumpSchema.parse(value);
  const keys = new Set<string>();
  for (const [key, deck] of dump.decks) {
    const parts = key.split("\0");
    if (parts.length !== 2 || !parts[0] || parts[1] !== deck.deck_id)
      throw new Error(`invalid deck key '${key}'`);
    if (keys.has(key)) throw new Error(`duplicate deck key '${key}'`);
    keys.add(key);
  }
  keys.clear();
  for (const [key, snapshot] of dump.snapshots) {
    const parts = key.split("\0");
    if (
      parts.length !== 3 ||
      !parts[0] ||
      parts[1] !== snapshot.deck.deck_id ||
      parts[2] !== snapshot.snapshot_id ||
      snapshot.version !== snapshot.deck.version
    )
      throw new Error(`invalid snapshot key or version '${key}'`);
    if (keys.has(key)) throw new Error(`duplicate snapshot key '${key}'`);
    keys.add(key);
  }
  return dump;
}
