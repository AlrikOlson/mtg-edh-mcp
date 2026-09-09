import { z } from "zod";
import { discover, DiscoveryRequestSchema, DISCOVERY_THEMES } from "../analyze/discovery.js";
import type { CardIndex } from "../index/index.js";
import type { DeckStore } from "../deck/index.js";
import { StructuredError } from "../types/index.js";
import { READS_LOCAL, type ToolDefinition } from "./registry.js";
import { resolveCardId } from "./resolve.js";

const schema = DiscoveryRequestSchema.extend({
  deck_id: z.string().min(1).optional(),
});

export function makeDiscoveryTools(
  index: CardIndex,
  store?: DeckStore,
  session = "local",
): ToolDefinition[] {
  return [
    {
      name: "card_discover",
      config: {
        title: "Full-pool discovery",
        annotations: READS_LOCAL,
        description:
          "Discover cards or legal command zones from local mechanics and text.\n" +
          "USE: provider-free theme/goal candidates. NOT: deck contribution rankings (meta_recommend).\n" +
          "FLOW: card_mechanics -> card_discover -> card_get/deck_add.\n" +
          "ARGS: theme or mechanics; oracle_query adds a filter/fallback; mode cards|commanders; deck_id or commanders; color_identity, excluded_cards, max_mana_value; include_pairs; limit<=50; scan_limit, pair_limit<=100000.\n" +
          "RETURNS: results with matches, supported_themes, interpretation, exclusions, limits, truncation, versions; paired choices are validated, thematic fit remains uncertain.",
        inputSchema: schema.shape,
      },
      handler: (args) => {
        const { deck_id, ...request } = schema.parse(args);
        if (deck_id && !store)
          throw new StructuredError("DECK_NOT_FOUND", "Deck storage is unavailable.");
        const deck = deck_id ? store?.get(deck_id, session) : undefined;
        if (deck_id && !deck)
          throw new StructuredError("DECK_NOT_FOUND", "Unknown deck: " + deck_id);
        const resolved = {
          ...request,
          commanders: request.commanders?.map((name) => resolveCardId(index, name)),
          excluded_cards: request.excluded_cards.map((name) => resolveCardId(index, name)),
        };
        const result = discover(index, resolved, deck);
        return {
          content: [{ type: "text", text: result.returned + " discovery results" }],
          structuredContent: { ...result, supported_themes: DISCOVERY_THEMES },
        };
      },
    },
  ];
}
