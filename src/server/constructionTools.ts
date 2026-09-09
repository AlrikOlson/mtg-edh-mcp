import { z } from "zod";
import { ConstructionRequestSchema } from "../types/construction.js";
import { normalizeConstruction } from "../deck/construction.js";
import type { CardIndex } from "../index/index.js";
import type { DeckStore } from "../deck/index.js";
import { StructuredError } from "../types/index.js";
import { READS_LOCAL, type ToolDefinition } from "./registry.js";

const schema = z
  .object({
    request: ConstructionRequestSchema.optional(),
    deck_id: z.string().min(1).optional(),
    expected_version: z.number().int().nonnegative().optional(),
  })
  .strict();

export function makeConstructionTools(
  index: CardIndex,
  store?: DeckStore,
  session = "local",
): ToolDefinition[] {
  return [
    {
      name: "construction_spec",
      config: {
        title: "Normalize construction goals",
        annotations: READS_LOCAL,
        description:
          "Normalize empty, commander, theme or partial-deck build goals.\n" +
          "USE: resolve constraints before search. NOT: saving cards (deck_add).\n" +
          "FLOW: deck_get_intent -> construction_spec -> card_discover.\n" +
          "ARGS: optional request; deck_id reads saved cards/intent; expected_version checks that source. Omitted choices remain unresolved.\n" +
          "RETURNS: status, specification, diagnostics, choices, unresolved_requirements, source version; hard constraints never relax silently. Read-only; no search or deck creation.",
        inputSchema: schema.shape,
      },
      handler: (args) => {
        const { request, deck_id, expected_version } = schema.parse(args);
        if (expected_version !== undefined && deck_id === undefined)
          throw new StructuredError("INVALID_QUERY", "expected_version requires deck_id.");
        const deck = deck_id ? store?.get(deck_id, session) : undefined;
        if (deck_id && !deck)
          throw new StructuredError("DECK_NOT_FOUND", "Unknown deck: " + deck_id);
        if (deck && expected_version !== undefined && deck.version !== expected_version) {
          return {
            content: [{ type: "text", text: "Source deck version conflict" }],
            structuredContent: {
              ok: false,
              conflict: true,
              deck_id,
              expected_version,
              current_version: deck.version,
            },
          };
        }
        const result = normalizeConstruction(
          ConstructionRequestSchema.parse(request ?? {}),
          index,
          deck,
        );
        return {
          content: [
            {
              type: "text",
              text: "Construction specification: " + result.status,
            },
          ],
          structuredContent: {
            ...result,
            ...(deck ? { deck_id: deck.deck_id, deck_version: deck.version } : {}),
          },
          ...(result.status === "conflict" ? { isError: true } : {}),
        };
      },
    },
  ];
}
