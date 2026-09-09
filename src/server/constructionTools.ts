import { z } from "zod";
import { ConstructionRequestSchema } from "../types/construction.js";
import { normalizeConstruction } from "../deck/construction.js";
import { constructDeck, ConstructionSearchSchema } from "../build/construction.js";
import type { CardIndex } from "../index/index.js";
import type { DeckStore } from "../deck/index.js";
import { StructuredError } from "../types/index.js";
import { READS_LOCAL, type ToolDefinition } from "./registry.js";
import { DeckPlanRequestSchema } from "../types/deckPlan.js";
import { previewDeckChange } from "./deckPlanTools.js";
import { staticSnapshotProvider, type SnapshotProvider } from "./snapshot.js";

const schema = z
  .object({
    request: ConstructionRequestSchema.optional(),
    deck_id: z.string().min(1).optional(),
    expected_version: z.number().int().nonnegative().optional(),
  })
  .strict();

const buildSchema = schema.extend({
  name: DeckPlanRequestSchema.shape.name,
  search: ConstructionSearchSchema.optional(),
});

export function makeConstructionTools(
  index: CardIndex,
  store?: DeckStore,
  session = "local",
  snapshot: SnapshotProvider = staticSnapshotProvider(),
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
    {
      name: "deck_construct",
      config: {
        title: "Construct a complete deck proposal",
        annotations: READS_LOCAL,
        description:
          "Construct a complete Commander deck proposal without saving.\n" +
          "USE: building from a commander, theme or partial deck. NOT: saving (deck_plan_apply).\n" +
          "FLOW: construction_spec -> deck_construct -> deck_plan_apply.\n" +
          "ARGS: request goals, optional name and bounded search limits; saved deck_id requires expected_version.\n" +
          "RETURNS: status found/proven_conflict/search_exhausted, normalization choices, search evidence, explanations; found adds desired, diff, validation and a reviewed plan. Review all constraints and pass plan unchanged to apply. Search exhaustion is not proof of impossibility; hard constraints never relax silently.",
        inputSchema: buildSchema.shape,
      },
      handler: (args) =>
        index.withRead(() => {
          const parsed = buildSchema.parse(args);
          const rejected = (code: string, message: string, details = {}) => ({
            content: [{ type: "text" as const, text: message }],
            structuredContent: { ok: false, code, message, ...details },
            isError: true,
          });
          if ((parsed.deck_id === undefined) !== (parsed.expected_version === undefined))
            return rejected(
              "PLAN_VERSION_REQUIRED",
              "Existing decks require expected_version; new decks must omit it.",
            );
          const deck = parsed.deck_id ? store?.get(parsed.deck_id, session) : undefined;
          if (parsed.deck_id && !deck)
            throw new StructuredError("DECK_NOT_FOUND", "Unknown deck: " + parsed.deck_id);
          if (deck && deck.version !== parsed.expected_version)
            return rejected("PLAN_VERSION_CONFLICT", "The source deck changed; construct again.", {
              deck_id: deck.deck_id,
              expected_version: parsed.expected_version,
              current_version: deck.version,
              conflict: true,
            });
          const dataSnapshot = snapshot();
          const result = constructDeck(
            ConstructionRequestSchema.parse(parsed.request ?? {}),
            index,
            {
              base: deck,
              dataSnapshot,
              name: parsed.name,
              search: parsed.search,
            },
          );
          const preview =
            result.status === "found" && result.proposal
              ? previewDeckChange(result.proposal, index, deck, dataSnapshot, session)
              : undefined;
          // A generated inventory must pass the very same final validator as an
          // exact preview before it can be represented as a reviewable apply plan.
          if (preview && !preview.ok)
            return rejected(
              "CONSTRUCTION_VALIDATION_FAILED",
              "The generated proposal failed final validation.",
              {
                status: "search_exhausted",
                normalization: result.normalization,
                search: result.search,
                validation: preview.validation,
              },
            );
          return {
            content: [{ type: "text", text: "Deck construction: " + result.status }],
            structuredContent: {
              ...result,
              ok: result.status === "found",
              ...(preview ?? {}),
              ...(deck ? { deck_id: deck.deck_id, deck_version: deck.version } : {}),
            },
          };
        }),
    },
  ];
}
