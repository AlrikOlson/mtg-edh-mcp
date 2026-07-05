/**
 * Validation tools (spec §5C): validate_deck (the authoritative gate),
 * validate_card (a read-only pre-check), validate_commander (command-zone
 * legality). All three wire the pure rules engines (src/validate) to MCP, with
 * lookup = CardIndex.getCard, and return fully structured Violations.
 */
import { z } from "zod";
import { StructuredError } from "../types/index.js";
import type { Card, Deck, DeckCardEntry, Violation, CommandZoneKind } from "../types/index.js";
import type { CardIndex } from "../index/index.js";
import type { DeckStore } from "../deck/index.js";
import {
  validateCore,
  validateCommander,
  validateCompanion,
  commanderColorIdentity,
  checkBanlist,
  checkColorIdentity,
  checkSingleton,
  anyNumberExemptions,
} from "../validate/index.js";
import { resolveCardId } from "./resolve.js";
import type { ToolDefinition } from "./registry.js";

/** Partition violations into hard errors and advisory warnings by severity. */
function split(violations: Violation[]): { errors: Violation[]; warnings: Violation[] } {
  return {
    errors: violations.filter((v) => v.severity === "error"),
    warnings: violations.filter((v) => v.severity === "warning"),
  };
}

function validateDeckTool(store: DeckStore, index: CardIndex, session: string): ToolDefinition {
  return {
    name: "validate_deck",
    config: {
      title: "Validate deck",
      description:
        "Authoritative legality gate: runs all core + commander rules (and a declared " +
        "companion's deckbuilding condition) over a deck and returns structured Violations " +
        "split into hard errors and advisory warnings. ok is true only when there are no errors.",
      inputSchema: { deck_id: z.string() },
    },
    handler: (args) => {
      const deckId = String(args.deck_id ?? "");
      const deck = store.get(deckId, session);
      if (!deck) throw new StructuredError("DECK_NOT_FOUND", `unknown deck '${deckId}'`);
      const lookup = (id: string): Card | null => index.getCard(id);
      const violations = [
        ...validateCore(deck, lookup),
        ...validateCommander(deck, lookup),
        ...validateCompanion(deck, lookup),
      ];
      const { errors, warnings } = split(violations);
      // Advisory (review #14): qty>1 cards legally exempt from singleton (basics,
      // allowlist, "any number" oracle text) — confirms the exception applied.
      const exemptions = anyNumberExemptions(deck, lookup);
      // Echo caps (pathological imports can produce hundreds of violations);
      // error_count/warning_count always carry the full totals.
      const CAP = 50;
      return {
        content: [
          { type: "text", text: `${errors.length} error(s), ${warnings.length} warning(s)` },
        ],
        structuredContent: {
          deck_id: deckId,
          ok: errors.length === 0,
          violations: violations.slice(0, CAP),
          errors: errors.slice(0, CAP),
          warnings: warnings.slice(0, CAP),
          error_count: errors.length,
          warning_count: warnings.length,
          exemptions,
        },
      };
    },
  };
}

function validateCardTool(store: DeckStore, index: CardIndex, session: string): ToolDefinition {
  return {
    name: "validate_card",
    config: {
      title: "Validate card (precheck)",
      description:
        "Read-only pre-check: would adding this card to the deck be legal? Accepts a card " +
        "name or oracle_id (`card`; oracle_id is a legacy alias). Returns the " +
        "card-scoped Violations (identity/legality/singleton) without mutating the deck.",
      inputSchema: {
        deck_id: z.string(),
        card: z.string().optional(),
        oracle_id: z.string().optional(),
        qty: z.number().int().positive().optional(),
      },
    },
    handler: (args) => {
      const deckId = String(args.deck_id ?? "");
      const oracleId = resolveCardId(index, String(args.card ?? args.oracle_id ?? ""));
      const qty = typeof args.qty === "number" ? args.qty : 1;
      const deck = store.get(deckId, session);
      if (!deck) throw new StructuredError("DECK_NOT_FOUND", `unknown deck '${deckId}'`);

      // Prospective deck = current cards with this card merged in (no persistence).
      const existing = deck.cards.find((e) => e.oracle_id === oracleId);
      const cards: DeckCardEntry[] = existing
        ? deck.cards.map((e) => (e.oracle_id === oracleId ? { ...e, qty: e.qty + qty } : e))
        : [...deck.cards, { oracle_id: oracleId, qty }];
      const prospective: Deck = { ...deck, cards };

      const lookup = (id: string): Card | null => index.getCard(id);
      const violations = [
        ...checkColorIdentity(prospective, lookup),
        ...checkBanlist(prospective, lookup),
        ...checkSingleton(prospective, lookup),
      ].filter((v) => v.card?.oracle_id === oracleId);
      return {
        content: [
          {
            type: "text",
            text: violations.length === 0 ? "ok" : `${violations.length} violation(s)`,
          },
        ],
        structuredContent: {
          deck_id: deckId,
          oracle_id: oracleId,
          ok: violations.length === 0,
          violations,
        },
      };
    },
  };
}

function validateCommanderTool(
  store: DeckStore,
  index: CardIndex,
  session: string,
): ToolDefinition {
  return {
    name: "validate_commander",
    config: {
      title: "Validate commander(s)",
      description:
        "Check command-zone legality: pass a deck_id to validate its commanders, or pass " +
        "commanders (by oracle_id or card name, a single string or an array) + " +
        "command_zone_kind directly. Returns " +
        "legality, Violations, and the combined color identity.",
      inputSchema: {
        deck_id: z.string().optional(),
        commanders: z.union([z.string(), z.array(z.string())]).optional(),
        command_zone_kind: z
          .enum(["single", "partner", "background", "doctor_companion"])
          .optional(),
      },
    },
    handler: (args) => {
      const lookup = (id: string): Card | null => index.getCard(id);
      let deck: Deck;
      if (typeof args.deck_id === "string") {
        const found = store.get(args.deck_id, session);
        if (!found) throw new StructuredError("DECK_NOT_FOUND", `unknown deck '${args.deck_id}'`);
        deck = found;
      } else {
        // Accept name-or-id, singular-or-array: resolve each commander to an oracle_id.
        const rawCommanders =
          typeof args.commanders === "string"
            ? [args.commanders]
            : Array.isArray(args.commanders)
              ? args.commanders.filter((x): x is string => typeof x === "string")
              : [];
        const commanders = rawCommanders.map((c) => resolveCardId(index, c));
        const kind: CommandZoneKind =
          typeof args.command_zone_kind === "string"
            ? (args.command_zone_kind as CommandZoneKind)
            : commanders.length > 1
              ? "partner"
              : "single";
        deck = {
          deck_id: "(transient)",
          name: "(transient)",
          format: "commander",
          commanders,
          command_zone_kind: kind,
          cards: [],
          computed_color_identity: [],
          version: 0,
          data_snapshot: "",
        };
      }
      const violations = validateCommander(deck, lookup);
      const identity = commanderColorIdentity(deck, lookup);
      return {
        content: [
          {
            type: "text",
            text:
              violations.length === 0 ? "legal command zone" : `${violations.length} violation(s)`,
          },
        ],
        structuredContent: {
          ok: violations.length === 0,
          commanders: deck.commanders,
          command_zone_kind: deck.command_zone_kind,
          computed_color_identity: identity,
          violations,
        },
      };
    },
  };
}

/** Build the validation tools bound to a DeckStore + CardIndex (both required), scoped to a session. */
export function makeValidateTools(
  store: DeckStore,
  index: CardIndex,
  session = "local",
): ToolDefinition[] {
  return [
    validateDeckTool(store, index, session),
    validateCardTool(store, index, session),
    validateCommanderTool(store, index, session),
  ];
}
