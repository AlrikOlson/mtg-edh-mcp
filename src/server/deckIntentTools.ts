import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  DeckIntentSchema,
  effectiveRoleTargets,
  intentDiagnostics,
  patchDeckIntent,
  type DeckIntent,
  type IntentDiagnostic,
} from "../deck/intent.js";
import { DEFAULT_BANDS } from "../analyze/mana.js";
import type { DeckStore } from "../deck/deckStore.js";
import type { CardIndex } from "../index/cardIndex.js";
import { StructuredError, type Deck } from "../types/index.js";
import { READS_LOCAL, mutates, type ToolDefinition } from "./registry.js";

function view(deck: Deck) {
  return {
    ok: true,
    deck_id: deck.deck_id,
    version: deck.version,
    intent: deck.intent ?? null,
    defaults: { role_targets: structuredClone(DEFAULT_BANDS) },
    effective: {
      role_targets: effectiveRoleTargets(deck),
      spend_target_usd: deck.intent?.soft?.spend_target_usd ?? null,
    },
    evaluation: {
      hard_constraints: "not_evaluated",
      soft_preferences: "advisory",
      unsupported_requirements: "not_evaluated",
    },
  };
}

function reply(structuredContent: Record<string, unknown>, isError = false) {
  return {
    content: [
      {
        type: "text" as const,
        text:
          structuredContent.ok === true
            ? `Deck intent v${structuredContent.version}`
            : String(structuredContent.code ?? "Version conflict"),
      },
    ],
    structuredContent,
    ...(isError ? { isError: true } : {}),
  };
}

function versionConflict(deck: Deck, expected: number) {
  return reply({
    ok: false,
    conflict: true,
    deck_id: deck.deck_id,
    expected_version: expected,
    current_version: deck.version,
  });
}

/** Every reference is an exact name or canonical ID; retained IDs survive a missing index. */
function canonicalIntent(intent: DeckIntent, index?: CardIndex, previous?: DeckIntent): DeckIntent {
  const trusted = new Set<string>([
    ...(previous?.hard?.locked_cards?.map((entry) => entry.oracle_id) ?? []),
    ...(previous?.hard?.excluded_cards ?? []),
    ...(previous?.hard?.commanders?.allowed ?? []),
    ...(previous?.hard?.commanders?.required ?? []),
    ...(previous?.soft?.favorites?.map((entry) => entry.oracle_id) ?? []),
  ]);
  const resolve = (input: string): string => {
    const direct = index?.getCard(input);
    if (direct) return direct.oracle_id;
    if (trusted.has(input)) return input;
    const matches = index?.resolveName(input, { exact: true }) ?? [];
    if (matches.length > 1)
      throw new StructuredError("AMBIGUOUS_NAME", `ambiguous intent card '${input}'`, {
        candidates: matches,
      });
    const match = matches[0];
    if (match) return match.oracle_id;
    throw new StructuredError(
      "UNKNOWN_CARD",
      `intent requires an installed canonical ID or exact card name: '${input}'`,
      { input },
    );
  };
  const result = structuredClone(intent);
  const hard = result.hard;
  if (hard?.locked_cards)
    hard.locked_cards = hard.locked_cards.map((entry) => ({
      ...entry,
      oracle_id: resolve(entry.oracle_id),
    }));
  if (hard?.excluded_cards) hard.excluded_cards = hard.excluded_cards.map(resolve);
  if (hard?.commanders?.allowed) hard.commanders.allowed = hard.commanders.allowed.map(resolve);
  if (hard?.commanders?.required) hard.commanders.required = hard.commanders.required.map(resolve);
  if (result.soft?.favorites)
    result.soft.favorites = result.soft.favorites.map((entry) => ({
      ...entry,
      oracle_id: resolve(entry.oracle_id),
    }));
  return result;
}

function cardDiagnostics(intent: DeckIntent, index?: CardIndex): IntentDiagnostic[] {
  const commanders = intent.hard?.commanders;
  const colors = commanders?.color_identity;
  if (!colors || !index) return [];
  const permitted = new Set<string>(colors);
  const exceedsColors = (id: string): boolean => {
    // Source absence is not evidence of colorlessness or a contradiction.
    const identity = index.getCard(id)?.gameplay?.color_identity;
    return (
      identity !== null && identity !== undefined && identity.some((color) => !permitted.has(color))
    );
  };
  const ids = new Set([
    ...(commanders.required ?? []),
    ...(intent.hard?.locked_cards?.map((entry) => entry.oracle_id) ?? []),
  ]);
  const diagnostics: IntentDiagnostic[] = [...ids].filter(exceedsColors).map((id) => ({
    code: "COLOR_CONSTRAINT_CONFLICT",
    path: "/hard/commanders/color_identity",
    message: `Required card '${id}' exceeds the permitted commander color identity.`,
  }));
  const allowed = commanders.allowed;
  const excluded = new Set(intent.hard?.excluded_cards ?? []);
  if (allowed?.length && allowed.every((id) => excluded.has(id) || exceedsColors(id))) {
    diagnostics.push({
      code: "NO_ALLOWED_COMMANDER",
      path: "/hard/commanders/allowed",
      message: "No allowed commander remains within the permitted colors and exclusions.",
    });
  }
  return diagnostics;
}

const identity = {
  deck_id: z.string().min(1),
  expected_version: z.number().int().nonnegative(),
};

export function makeDeckIntentTools(
  store: DeckStore,
  session: string,
  index?: CardIndex,
): ToolDefinition[] {
  return [
    {
      name: "deck_get_intent",
      config: {
        annotations: READS_LOCAL,
        title: "Get deck intent",
        description:
          "Read authored build intent and effective advisory defaults.\n" +
          "USE: planning any empty or existing deck. NOT: checking legality (validate_deck).\n" +
          "FLOW: deck_create -> deck_get_intent -> deck_set_intent.\n" +
          "ARGS: deck_id; expected_version optionally checks the read.\n" +
          "RETURNS: intent (null means no preferences), version, defaults, effective, evaluation. Hard constraints are stored for planning; legality is independent.",
        inputSchema: {
          ...identity,
          expected_version: identity.expected_version.optional(),
        },
      },
      handler: (args) => {
        const deck = store.get(String(args.deck_id), session);
        if (!deck) throw new StructuredError("DECK_NOT_FOUND", `unknown deck '${args.deck_id}'`);
        if (typeof args.expected_version === "number" && deck.version !== args.expected_version)
          return versionConflict(deck, args.expected_version);
        return reply(view(deck));
      },
    },
    {
      name: "deck_set_intent",
      config: {
        annotations: mutates({ destructive: true, idempotent: true }),
        title: "Set deck intent",
        description:
          "Set, patch or clear build intent without changing cards.\n" +
          "USE: goals, locked quantities, exclusions, commander constraints and preferences. NOT: card edits (deck_add).\n" +
          "FLOW: deck_get_intent -> deck_set_intent -> analyze_role_coverage.\n" +
          "ARGS: deck_id; expected_version required; action set|patch|clear; intent for set, patch for patch. Patch omits to retain, null removes, arrays replace. Card refs require exact names or IDs.\n" +
          "RETURNS: intent, version, changed, defaults, effective, evaluation; conflicts include diagnostics. Hard constraints are not legality rules; soft and unsupported requirements are not guarantees.",
        inputSchema: {
          ...identity,
          action: z.enum(["set", "patch", "clear"]),
          intent: DeckIntentSchema.optional(),
          patch: z.record(z.string(), z.unknown()).optional(),
        },
      },
      handler: (args) => {
        const deck = store.get(String(args.deck_id), session);
        if (!deck) throw new StructuredError("DECK_NOT_FOUND", `unknown deck '${args.deck_id}'`);
        const expected = identity.expected_version.parse(args.expected_version);
        if (deck.version !== expected) return versionConflict(deck, expected);
        const action = z.enum(["set", "patch", "clear"]).parse(args.action);
        const invalid = (diagnostics: IntentDiagnostic[]) =>
          reply(
            {
              ok: false,
              code: "INVALID_INTENT",
              deck_id: deck.deck_id,
              version: deck.version,
              diagnostics,
            },
            true,
          );
        if (
          (action === "set" && (args.intent === undefined || args.patch !== undefined)) ||
          (action === "patch" && (args.patch === undefined || args.intent !== undefined)) ||
          (action === "clear" && (args.intent !== undefined || args.patch !== undefined))
        ) {
          return invalid([
            {
              code: "INVALID_ACTION_PAYLOAD",
              path: "/action",
              message:
                "Set requires only intent; patch requires only patch; clear accepts neither.",
            },
          ]);
        }
        let intent: DeckIntent | undefined;
        try {
          if (action !== "clear") {
            const candidate =
              action === "set"
                ? DeckIntentSchema.parse(args.intent)
                : patchDeckIntent(deck.intent, args.patch);
            intent = canonicalIntent(
              candidate,
              index,
              action === "patch" ? deck.intent : undefined,
            );
          }
        } catch (error) {
          if (error instanceof z.ZodError)
            return invalid(
              error.issues.map((issue) => ({
                code: issue.code,
                path: issue.path.length
                  ? "/" +
                    issue.path
                      .map((part) => String(part).replaceAll("~", "~0").replaceAll("/", "~1"))
                      .join("/")
                  : "",
                message: issue.message,
              })),
            );
          throw error;
        }
        const diagnostics = intent
          ? [...intentDiagnostics(intent), ...cardDiagnostics(intent, index)]
          : [];
        if (diagnostics.length)
          return reply(
            {
              ok: false,
              code: "INTENT_CONFLICT",
              deck_id: deck.deck_id,
              version: deck.version,
              diagnostics,
            },
            true,
          );
        const changed = !isDeepStrictEqual(deck.intent, intent);
        const updated = store.update(
          deck.deck_id,
          (current) => {
            const next = { ...current };
            if (intent === undefined) delete next.intent;
            else next.intent = intent;
            return next;
          },
          session,
        );
        return reply({ ...view(updated), changed });
      },
    },
  ];
}
