/**
 * Deck lifecycle tools (spec §5B): deck_create, deck_get, deck_list, deck_delete
 * — registered through the server's ToolDefinition framework against a DeckStore.
 *
 * deck_get projects the deck's card entries lean by default ({oracle_id, qty,
 * name?}); expand:true includes the full Card per entry (via the index). Card
 * add/remove + commander setting are later P3 chunks; decks start empty here.
 */
import { z } from "zod";
import { StructuredError } from "../types/index.js";
import type { Card, Deck, DeckCardEntry, Violation } from "../types/index.js";
import type { CardIndex } from "../index/index.js";
import { diffDecks, formatDecklist, parseDecklist, type DeckStore } from "../deck/index.js";
import {
  checkBanlist,
  checkColorIdentity,
  checkSingleton,
  commanderColorIdentity,
  validateCommander,
} from "../validate/index.js";
import type { CommandZoneKind } from "../types/index.js";
import type { SnapshotProvider } from "./snapshot.js";
import type { ToolDefinition } from "./registry.js";

/** Project a deck's card entries for output (lean names, or full cards on expand). */
function projectDeck(
  deck: Deck,
  index: CardIndex | undefined,
  expand: boolean,
): Record<string, unknown> {
  const cards = deck.cards.map((entry) => {
    const card = index?.getCard(entry.oracle_id) ?? null;
    const flag = entry.illegal ? { illegal: true } : {};
    if (expand) return { oracle_id: entry.oracle_id, qty: entry.qty, card, ...flag };
    return { oracle_id: entry.oracle_id, qty: entry.qty, name: card?.name, ...flag };
  });
  return { ...deck, cards };
}

function deckCreateTool(store: DeckStore, snapshot?: SnapshotProvider): ToolDefinition {
  return {
    name: "deck_create",
    config: {
      title: "Create deck",
      description: "Create a new versioned deck and return its deck_id.",
      inputSchema: {
        name: z.string(),
        format: z.literal("commander").optional(),
        commanders: z.array(z.string()).optional(),
        command_zone_kind: z
          .enum(["single", "partner", "background", "doctor_companion"])
          .optional(),
      },
    },
    handler: (args) => {
      const commanders = Array.isArray(args.commanders)
        ? args.commanders.filter((x): x is string => typeof x === "string")
        : undefined;
      const deck = store.create({
        name: String(args.name ?? ""),
        format: args.format === "commander" ? "commander" : undefined,
        commanders,
        command_zone_kind:
          typeof args.command_zone_kind === "string"
            ? (args.command_zone_kind as "single" | "partner" | "background" | "doctor_companion")
            : undefined,
        dataSnapshot: snapshot?.(),
      });
      return {
        content: [{ type: "text", text: `created deck ${deck.deck_id}` }],
        structuredContent: { deck_id: deck.deck_id, deck },
      };
    },
  };
}

function deckGetTool(store: DeckStore, index?: CardIndex): ToolDefinition {
  return {
    name: "deck_get",
    config: {
      title: "Get deck",
      description:
        "Fetch a deck by deck_id. Lean by default (cards as oracle_id+qty+name); " +
        "expand:true includes the full Card per entry.",
      inputSchema: { deck_id: z.string(), expand: z.boolean().optional() },
    },
    handler: (args) => {
      const deckId = String(args.deck_id ?? "");
      const deck = store.get(deckId);
      if (!deck) throw new StructuredError("DECK_NOT_FOUND", `unknown deck '${deckId}'`);
      return {
        content: [{ type: "text", text: `${deck.name} (v${deck.version})` }],
        structuredContent: { deck: projectDeck(deck, index, args.expand === true) },
      };
    },
  };
}

function deckListTool(store: DeckStore): ToolDefinition {
  return {
    name: "deck_list",
    config: {
      title: "List decks",
      description: "List all decks in the current session.",
      inputSchema: {},
    },
    handler: () => {
      const decks = store.list();
      return {
        content: [{ type: "text", text: `${decks.length} decks` }],
        structuredContent: { decks },
      };
    },
  };
}

function deckDeleteTool(store: DeckStore): ToolDefinition {
  return {
    name: "deck_delete",
    config: {
      title: "Delete deck",
      description: "Delete a deck by deck_id.",
      inputSchema: { deck_id: z.string() },
    },
    handler: (args) => {
      const deckId = String(args.deck_id ?? "");
      if (!store.delete(deckId)) {
        throw new StructuredError("DECK_NOT_FOUND", `unknown deck '${deckId}'`);
      }
      return {
        content: [{ type: "text", text: `deleted deck ${deckId}` }],
        structuredContent: { deck_id: deckId, deleted: true },
      };
    },
  };
}

function deckSnapshotTool(store: DeckStore): ToolDefinition {
  return {
    name: "deck_snapshot",
    config: {
      title: "Snapshot deck",
      description:
        "Capture an immutable copy of a deck's current state under a snapshot_id, " +
        "so it can later be diffed or restored.",
      inputSchema: { deck_id: z.string() },
    },
    handler: (args) => {
      const deckId = String(args.deck_id ?? "");
      const snap = store.snapshot(deckId);
      return {
        content: [
          { type: "text", text: `snapshot ${snap.snapshot_id} of ${deckId} (v${snap.version})` },
        ],
        structuredContent: { snapshot_id: snap.snapshot_id, version: snap.version },
      };
    },
  };
}

function deckDiffTool(store: DeckStore): ToolDefinition {
  return {
    name: "deck_diff",
    config: {
      title: "Diff deck",
      description:
        "Compare a snapshot against the deck's current state (or against a second " +
        "snapshot via to_snapshot_id). Reports added/removed/qty-changed cards and " +
        "metadata changes, going from the baseline snapshot to the target.",
      inputSchema: {
        deck_id: z.string(),
        snapshot_id: z.string(),
        to_snapshot_id: z.string().optional(),
      },
    },
    handler: (args) => {
      const deckId = String(args.deck_id ?? "");
      const fromId = String(args.snapshot_id ?? "");
      const from = store.getSnapshot(deckId, fromId);
      if (!from) throw new StructuredError("DECK_NOT_FOUND", `unknown snapshot '${fromId}'`);

      let to: Deck;
      if (typeof args.to_snapshot_id === "string") {
        const toSnap = store.getSnapshot(deckId, args.to_snapshot_id);
        if (!toSnap) {
          throw new StructuredError("DECK_NOT_FOUND", `unknown snapshot '${args.to_snapshot_id}'`);
        }
        to = toSnap.deck;
      } else {
        const deck = store.get(deckId);
        if (!deck) throw new StructuredError("DECK_NOT_FOUND", `unknown deck '${deckId}'`);
        to = deck;
      }

      const diff = diffDecks(from.deck, to);
      const { added, removed, changed } = diff.cards;
      return {
        content: [
          {
            type: "text",
            text: `+${added.length} -${removed.length} ~${changed.length} cards`,
          },
        ],
        structuredContent: { diff },
      };
    },
  };
}

function deckRestoreTool(store: DeckStore): ToolDefinition {
  return {
    name: "deck_restore",
    config: {
      title: "Restore deck",
      description:
        "Roll a deck back to a snapshot. The deck keeps its deck_id; version is " +
        "bumped (restore is itself a mutation) and subscribers are notified.",
      inputSchema: { deck_id: z.string(), snapshot_id: z.string() },
    },
    handler: (args) => {
      const deckId = String(args.deck_id ?? "");
      const snapshotId = String(args.snapshot_id ?? "");
      const deck = store.restore(deckId, snapshotId);
      return {
        content: [
          { type: "text", text: `restored ${deckId} from ${snapshotId} (now v${deck.version})` },
        ],
        structuredContent: { deck_id: deckId, restored_from: snapshotId, deck },
      };
    },
  };
}

/** Merge resolved entries into an existing card list, summing quantities by oracle_id. */
function mergeEntries(
  existing: readonly DeckCardEntry[],
  additions: readonly DeckCardEntry[],
): DeckCardEntry[] {
  const byId = new Map<string, number>();
  const illegal = new Set<string>();
  for (const e of [...existing, ...additions]) {
    byId.set(e.oracle_id, (byId.get(e.oracle_id) ?? 0) + e.qty);
    if (e.illegal) illegal.add(e.oracle_id);
  }
  return [...byId].map(([oracle_id, qty]) =>
    illegal.has(oracle_id) ? { oracle_id, qty, illegal: true } : { oracle_id, qty },
  );
}

function deckImportTool(
  store: DeckStore,
  index?: CardIndex,
  snapshot?: SnapshotProvider,
): ToolDefinition {
  return {
    name: "deck_import",
    config: {
      title: "Import decklist",
      description:
        "Parse a decklist (Moxfield/Archidekt/MTGO/Arena/plaintext) and resolve each " +
        "line to a card. Adds to deck_id when given, otherwise creates a new deck. " +
        "Unresolved lines are reported (never silently dropped).",
      inputSchema: {
        text: z.string(),
        deck_id: z.string().optional(),
        name: z.string().optional(),
      },
    },
    handler: (args) => {
      const text = String(args.text ?? "");
      const parsed = parseDecklist(text);

      const resolved: DeckCardEntry[] = [];
      const unresolved: Record<string, unknown>[] = [];
      for (const entry of parsed) {
        const matches = index?.resolveName(entry.name) ?? [];
        if (matches.length === 1) {
          resolved.push({ oracle_id: matches[0]!.oracle_id, qty: entry.qty });
        } else if (matches.length > 1) {
          unresolved.push({
            line: entry.raw,
            name: entry.name,
            reason: "AMBIGUOUS_NAME",
            candidates: matches,
          });
        } else {
          unresolved.push({ line: entry.raw, name: entry.name, reason: "UNKNOWN_CARD" });
        }
      }

      const additions = mergeEntries([], resolved);
      let deckId: string;
      if (typeof args.deck_id === "string") {
        deckId = args.deck_id;
        store.update(deckId, (deck) => ({ ...deck, cards: mergeEntries(deck.cards, additions) }));
      } else {
        const deck = store.create({
          name: typeof args.name === "string" ? args.name : "Imported deck",
          dataSnapshot: snapshot?.(),
        });
        deckId = deck.deck_id;
        store.update(deckId, (d) => ({ ...d, cards: additions }));
      }

      return {
        content: [
          {
            type: "text",
            text: `imported ${additions.length} cards into ${deckId}; ${unresolved.length} unresolved`,
          },
        ],
        structuredContent: { deck_id: deckId, resolved_count: additions.length, unresolved },
      };
    },
  };
}

function deckExportTool(store: DeckStore, index?: CardIndex): ToolDefinition {
  return {
    name: "deck_export",
    config: {
      title: "Export decklist",
      description:
        "Emit a deck as plaintext '<qty> <name>' decklist lines. Set/collector data " +
        "is not stored per entry, so export carries quantity + card identity only.",
      inputSchema: { deck_id: z.string(), format: z.enum(["text"]).optional() },
    },
    handler: (args) => {
      const deckId = String(args.deck_id ?? "");
      const deck = store.get(deckId);
      if (!deck) throw new StructuredError("DECK_NOT_FOUND", `unknown deck '${deckId}'`);
      const text = formatDecklist(deck.cards, (id) => index?.getCard(id)?.name);
      return {
        content: [{ type: "text", text: text || "(empty deck)" }],
        structuredContent: { deck_id: deckId, format: "text", text },
      };
    },
  };
}

/** zod raw shape for a batch of {oracle_id, qty} card entries. */
const CARD_ENTRIES = z.array(z.object({ oracle_id: z.string(), qty: z.number().int().positive() }));

/** Card-scoped violations from adding `oracleId` to a prospective deck (count is deck-level, excluded). */
function addVerdict(prospective: Deck, oracleId: string, index?: CardIndex): Violation[] {
  if (!index) return [];
  const lookup = (id: string): Card | null => index.getCard(id);
  return [
    ...checkColorIdentity(prospective, lookup),
    ...checkBanlist(prospective, lookup),
    ...checkSingleton(prospective, lookup),
  ].filter((v) => v.card?.oracle_id === oracleId);
}

function deckAddTool(store: DeckStore, index?: CardIndex): ToolDefinition {
  return {
    name: "deck_add",
    config: {
      title: "Add cards",
      description:
        "Add cards by oracle_id (batch, idempotent on (deck_id, oracle_id)). Returns a " +
        "per-card pre-check verdict: ok, or rejected with Violations (identity/legality/" +
        "singleton). Rejected cards are not applied unless force:true, which adds them " +
        "flagged illegal in state.",
      inputSchema: { deck_id: z.string(), cards: CARD_ENTRIES, force: z.boolean().optional() },
    },
    handler: (args) => {
      const deckId = String(args.deck_id ?? "");
      const force = args.force === true;
      const additions = CARD_ENTRIES.parse(args.cards);
      const deck = store.get(deckId);
      if (!deck) throw new StructuredError("DECK_NOT_FOUND", `unknown deck '${deckId}'`);

      let working: DeckCardEntry[] = deck.cards.map((e) => ({ ...e }));
      const verdicts: Record<string, unknown>[] = [];
      for (const add of additions) {
        const merged = mergeEntries(working, [{ oracle_id: add.oracle_id, qty: add.qty }]);
        const violations = addVerdict({ ...deck, cards: merged }, add.oracle_id, index);
        if (violations.length === 0) {
          working = merged;
          verdicts.push({ oracle_id: add.oracle_id, status: "ok" });
        } else if (force) {
          working = merged.map((e) =>
            e.oracle_id === add.oracle_id ? { ...e, illegal: true } : e,
          );
          verdicts.push({ oracle_id: add.oracle_id, status: "added_illegal", violations });
        } else {
          verdicts.push({ oracle_id: add.oracle_id, status: "rejected", violations });
        }
      }

      const updated = store.update(deckId, (d) => ({ ...d, cards: working }));
      return {
        content: [{ type: "text", text: `${verdicts.length} add verdict(s) for ${deckId}` }],
        structuredContent: { deck_id: deckId, version: updated.version, verdicts },
      };
    },
  };
}

function deckRemoveTool(store: DeckStore): ToolDefinition {
  return {
    name: "deck_remove",
    config: {
      title: "Remove cards",
      description:
        "Remove cards by oracle_id (batch). Decrements quantity; an entry is dropped " +
        "when its quantity reaches zero. Idempotent — removing more than present clears it.",
      inputSchema: { deck_id: z.string(), cards: CARD_ENTRIES },
    },
    handler: (args) => {
      const deckId = String(args.deck_id ?? "");
      const removals = CARD_ENTRIES.parse(args.cards);
      const deck = store.get(deckId);
      if (!deck) throw new StructuredError("DECK_NOT_FOUND", `unknown deck '${deckId}'`);

      const remove = new Map<string, number>();
      for (const r of removals) remove.set(r.oracle_id, (remove.get(r.oracle_id) ?? 0) + r.qty);
      const cards = deck.cards
        .map((e) => ({ ...e, qty: e.qty - (remove.get(e.oracle_id) ?? 0) }))
        .filter((e) => e.qty > 0);

      const updated = store.update(deckId, (d) => ({ ...d, cards }));
      return {
        content: [{ type: "text", text: `removed from ${deckId} (${cards.length} entries left)` }],
        structuredContent: { deck_id: deckId, version: updated.version },
      };
    },
  };
}

const COMMAND_ZONE_KINDS = ["single", "partner", "background", "doctor_companion"] as const;

/** Infer the command-zone kind from the commander cards when not given explicitly. */
function inferZoneKind(commanders: readonly string[], index?: CardIndex): CommandZoneKind {
  if (commanders.length <= 1) return "single";
  const cards = commanders.map((id) => index?.getCard(id) ?? null);
  if (cards.some((c) => c && /\bBackground\b/.test(c.type_line))) return "background";
  if (
    cards.some(
      (c) => c && (/Time Lord/i.test(c.type_line) || /doctor.?s companion/i.test(c.oracle_text)),
    )
  )
    return "doctor_companion";
  return "partner";
}

function deckSetCommanderTool(store: DeckStore, index?: CardIndex): ToolDefinition {
  return {
    name: "deck_set_commander",
    config: {
      title: "Set commander(s)",
      description:
        "Set or replace a deck's commander(s). Validates eligibility + partner/background/" +
        "Doctor pairings and recomputes the deck's combined color identity. Rejects an " +
        "illegal command zone with Violations rather than applying it.",
      inputSchema: {
        deck_id: z.string(),
        commanders: z.array(z.string()),
        command_zone_kind: z.enum(COMMAND_ZONE_KINDS).optional(),
      },
    },
    handler: (args) => {
      const deckId = String(args.deck_id ?? "");
      const commanders = Array.isArray(args.commanders)
        ? args.commanders.filter((x): x is string => typeof x === "string")
        : [];
      const deck = store.get(deckId);
      if (!deck) throw new StructuredError("DECK_NOT_FOUND", `unknown deck '${deckId}'`);

      const kind: CommandZoneKind =
        typeof args.command_zone_kind === "string"
          ? (args.command_zone_kind as CommandZoneKind)
          : inferZoneKind(commanders, index);

      const lookup = (id: string) => index?.getCard(id) ?? null;
      const identity = index ? commanderColorIdentity({ ...deck, commanders }, lookup) : [];
      const prospective: Deck = {
        ...deck,
        commanders,
        command_zone_kind: kind,
        computed_color_identity: identity,
      };

      const violations = index ? validateCommander(prospective, lookup) : [];
      if (violations.length > 0) {
        return {
          content: [{ type: "text", text: `rejected: ${violations.length} violation(s)` }],
          structuredContent: { ok: false, deck_id: deckId, violations },
        };
      }

      const updated = store.update(deckId, (d) => ({
        ...d,
        commanders,
        command_zone_kind: kind,
        computed_color_identity: identity,
      }));
      return {
        content: [{ type: "text", text: `set ${commanders.length} commander(s) on ${deckId}` }],
        structuredContent: {
          ok: true,
          deck_id: deckId,
          commanders,
          command_zone_kind: kind,
          computed_color_identity: identity,
          version: updated.version,
        },
      };
    },
  };
}

/** Build the deck lifecycle tools bound to a DeckStore (+ optional index/snapshot). */
export function makeDeckTools(
  store: DeckStore,
  index?: CardIndex,
  snapshot?: SnapshotProvider,
): ToolDefinition[] {
  return [
    deckCreateTool(store, snapshot),
    deckGetTool(store, index),
    deckListTool(store),
    deckDeleteTool(store),
    deckSnapshotTool(store),
    deckDiffTool(store),
    deckRestoreTool(store),
    deckImportTool(store, index, snapshot),
    deckExportTool(store, index),
    deckAddTool(store, index),
    deckRemoveTool(store),
    deckSetCommanderTool(store, index),
  ];
}
