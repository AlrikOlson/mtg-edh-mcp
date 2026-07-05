/**
 * Deck lifecycle tools (spec §5B): deck_create, deck_get, deck_list, deck_delete
 * — registered through the server's ToolDefinition framework against a DeckStore.
 *
 * deck_get projects the deck's card entries lean by default ({oracle_id, qty,
 * name?}); expand:true includes the full Card per entry (via the index). Card
 * add/remove + commander setting are later P3 chunks; decks start empty here.
 *
 * Every store access is scoped to a `session` (the principal resolved by the HTTP
 * transport, or "local" for stdio), so two principals see isolated decks (§2/§11).
 * The mutators (deck_add/deck_remove/deck_set_commander) accept an optional
 * `expected_version` for optimistic concurrency: on a version mismatch they return
 * a conflict result without mutating, rather than blindly last-write-wins.
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
  validateCompanion,
  isCompanionCard,
} from "../validate/index.js";
import type { CommandZoneKind } from "../types/index.js";
import {
  CardInputsSchema,
  resolveCardId,
  resolveCardIdLenient,
  resolveCardInputs,
} from "./resolve.js";
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

/** A conflict result for an optimistic-concurrency mismatch (no mutation applied). */
function conflict(deckId: string, currentVersion: number, expected: number) {
  return {
    content: [
      {
        type: "text" as const,
        text: `version conflict on ${deckId}: expected v${expected}, current v${currentVersion}`,
      },
    ],
    structuredContent: {
      ok: false,
      conflict: true,
      deck_id: deckId,
      expected_version: expected,
      current_version: currentVersion,
    },
  };
}

function deckCreateTool(
  store: DeckStore,
  session: string,
  index?: CardIndex,
  snapshot?: SnapshotProvider,
): ToolDefinition {
  return {
    name: "deck_create",
    config: {
      title: "Create deck",
      description:
        "Create a new versioned deck and return its deck_id. Initial commanders may be " +
        "given by oracle_id or card name, as a single string or an array.",
      inputSchema: {
        name: z.string(),
        format: z.literal("commander").optional(),
        commanders: COMMANDERS_INPUT.optional(),
        command_zone_kind: z
          .enum(["single", "partner", "background", "doctor_companion"])
          .optional(),
      },
    },
    handler: (args) => {
      const rawCommanders = normalizeCommanders(args.commanders);
      // Accept name-or-id: resolve names to oracle_ids when unambiguous. Lenient
      // here — deck_create is a constructor, not the legality gate; unknown
      // commanders are stored as-is and caught later by deck_set_commander.
      const commanders =
        rawCommanders && index
          ? rawCommanders.map((c) => resolveCardIdLenient(index, c))
          : rawCommanders;
      const deck = store.create(
        {
          name: String(args.name ?? ""),
          format: args.format === "commander" ? "commander" : undefined,
          commanders,
          command_zone_kind:
            typeof args.command_zone_kind === "string"
              ? (args.command_zone_kind as "single" | "partner" | "background" | "doctor_companion")
              : undefined,
          dataSnapshot: snapshot?.(),
        },
        session,
      );
      return {
        content: [{ type: "text", text: `created deck ${deck.deck_id}` }],
        structuredContent: { deck_id: deck.deck_id, deck },
      };
    },
  };
}

function deckGetTool(store: DeckStore, session: string, index?: CardIndex): ToolDefinition {
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
      const deck = store.get(deckId, session);
      if (!deck) throw new StructuredError("DECK_NOT_FOUND", `unknown deck '${deckId}'`);
      return {
        content: [{ type: "text", text: `${deck.name} (v${deck.version})` }],
        structuredContent: { deck: projectDeck(deck, index, args.expand === true) },
      };
    },
  };
}

function deckListTool(store: DeckStore, session: string): ToolDefinition {
  return {
    name: "deck_list",
    config: {
      title: "List decks",
      description: "List all decks in the current session.",
      inputSchema: {},
    },
    handler: () => {
      const decks = store.list(session);
      return {
        content: [{ type: "text", text: `${decks.length} decks` }],
        structuredContent: { decks },
      };
    },
  };
}

function deckRenameTool(store: DeckStore, session: string): ToolDefinition {
  return {
    name: "deck_rename",
    config: {
      title: "Rename deck",
      description:
        "Rename a deck by deck_id. Pass expected_version for optimistic concurrency: " +
        "a mismatch returns a conflict without mutating.",
      inputSchema: {
        deck_id: z.string(),
        name: z.string().min(1),
        expected_version: z.number().int().nonnegative().optional(),
      },
    },
    handler: (args) => {
      const deckId = String(args.deck_id ?? "");
      const deck = store.get(deckId, session);
      if (!deck) throw new StructuredError("DECK_NOT_FOUND", `unknown deck '${deckId}'`);
      if (typeof args.expected_version === "number" && deck.version !== args.expected_version) {
        return conflict(deckId, deck.version, args.expected_version);
      }
      const updated = store.setName(deckId, String(args.name), session);
      return {
        content: [{ type: "text", text: `renamed deck ${deckId} to '${updated.name}'` }],
        structuredContent: {
          ok: true,
          deck_id: deckId,
          name: updated.name,
          version: updated.version,
        },
      };
    },
  };
}

function deckDeleteTool(store: DeckStore, session: string): ToolDefinition {
  return {
    name: "deck_delete",
    config: {
      title: "Delete deck",
      description: "Delete a deck by deck_id.",
      inputSchema: { deck_id: z.string() },
    },
    handler: (args) => {
      const deckId = String(args.deck_id ?? "");
      if (!store.delete(deckId, session)) {
        throw new StructuredError("DECK_NOT_FOUND", `unknown deck '${deckId}'`);
      }
      return {
        content: [{ type: "text", text: `deleted deck ${deckId}` }],
        structuredContent: { deck_id: deckId, deleted: true },
      };
    },
  };
}

function deckSnapshotTool(store: DeckStore, session: string): ToolDefinition {
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
      const snap = store.snapshot(deckId, session);
      return {
        content: [
          { type: "text", text: `snapshot ${snap.snapshot_id} of ${deckId} (v${snap.version})` },
        ],
        structuredContent: { snapshot_id: snap.snapshot_id, version: snap.version },
      };
    },
  };
}

function deckDiffTool(store: DeckStore, session: string): ToolDefinition {
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
      const from = store.getSnapshot(deckId, fromId, session);
      if (!from) throw new StructuredError("DECK_NOT_FOUND", `unknown snapshot '${fromId}'`);

      let to: Deck;
      if (typeof args.to_snapshot_id === "string") {
        const toSnap = store.getSnapshot(deckId, args.to_snapshot_id, session);
        if (!toSnap) {
          throw new StructuredError("DECK_NOT_FOUND", `unknown snapshot '${args.to_snapshot_id}'`);
        }
        to = toSnap.deck;
      } else {
        const deck = store.get(deckId, session);
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

function deckRestoreTool(store: DeckStore, session: string): ToolDefinition {
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
      const deck = store.restore(deckId, snapshotId, session);
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
  session: string,
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
          unresolved.push({
            line: entry.raw,
            name: entry.name,
            reason: "UNKNOWN_CARD",
            suggestions: index?.suggestNames(entry.name) ?? [],
          });
        }
      }

      const additions = mergeEntries([], resolved);
      let deckId: string;
      if (typeof args.deck_id === "string") {
        deckId = args.deck_id;
        store.update(
          deckId,
          (deck) => ({ ...deck, cards: mergeEntries(deck.cards, additions) }),
          session,
        );
      } else {
        const deck = store.create(
          {
            name: typeof args.name === "string" ? args.name : "Imported deck",
            dataSnapshot: snapshot?.(),
          },
          session,
        );
        deckId = deck.deck_id;
        store.update(deckId, (d) => ({ ...d, cards: additions }), session);
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

function deckExportTool(store: DeckStore, session: string, index?: CardIndex): ToolDefinition {
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
      const deck = store.get(deckId, session);
      if (!deck) throw new StructuredError("DECK_NOT_FOUND", `unknown deck '${deckId}'`);
      const text = formatDecklist(deck.cards, (id) => index?.getCard(id)?.name);
      return {
        content: [{ type: "text", text: text || "(empty deck)" }],
        structuredContent: { deck_id: deckId, format: "text", text },
      };
    },
  };
}

/** Singular-or-array commanders input (agents naturally pass one name). */
const COMMANDERS_INPUT = z.union([z.string(), z.array(z.string())]);

/** Normalize a commanders input to a string[] (undefined stays undefined). */
function normalizeCommanders(raw: unknown): string[] | undefined {
  if (typeof raw === "string") return [raw];
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === "string");
  return undefined;
}

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

function deckAddTool(store: DeckStore, session: string, index?: CardIndex): ToolDefinition {
  return {
    name: "deck_add",
    config: {
      title: "Add cards",
      description:
        "Add cards by name or oracle_id — a bare string, {card, qty} objects, or an array " +
        "of either (batch, idempotent on (deck_id, oracle_id)). Names are resolved " +
        "server-side; unresolvable/ambiguous entries come back in failed[] (with " +
        "did-you-mean suggestions / candidates) without aborting the rest. Returns a " +
        "per-card pre-check verdict: ok, or rejected with Violations (identity/legality/" +
        "singleton). Rejected cards are not applied unless force:true, which adds them " +
        "flagged illegal in state. Pass expected_version for optimistic concurrency: a " +
        "mismatch returns a conflict without mutating.",
      inputSchema: {
        deck_id: z.string(),
        cards: CardInputsSchema,
        force: z.boolean().optional(),
        expected_version: z.number().int().nonnegative().optional(),
      },
    },
    handler: (args) => {
      const deckId = String(args.deck_id ?? "");
      const force = args.force === true;
      const { resolved, failed } = resolveCardInputs(index, args.cards);
      const deck = store.get(deckId, session);
      if (!deck) throw new StructuredError("DECK_NOT_FOUND", `unknown deck '${deckId}'`);
      if (typeof args.expected_version === "number" && deck.version !== args.expected_version) {
        return conflict(deckId, deck.version, args.expected_version);
      }

      let working: DeckCardEntry[] = deck.cards.map((e) => ({ ...e }));
      const verdicts: Record<string, unknown>[] = [];
      for (const add of resolved) {
        const merged = mergeEntries(working, [{ oracle_id: add.oracle_id, qty: add.qty }]);
        const violations = addVerdict({ ...deck, cards: merged }, add.oracle_id, index);
        if (violations.length === 0) {
          working = merged;
          verdicts.push({ oracle_id: add.oracle_id, name: add.name, status: "ok" });
        } else if (force) {
          working = merged.map((e) =>
            e.oracle_id === add.oracle_id ? { ...e, illegal: true } : e,
          );
          verdicts.push({
            oracle_id: add.oracle_id,
            name: add.name,
            status: "added_illegal",
            violations,
          });
        } else {
          verdicts.push({
            oracle_id: add.oracle_id,
            name: add.name,
            status: "rejected",
            violations,
          });
        }
      }

      const updated = store.update(deckId, (d) => ({ ...d, cards: working }), session);
      const failedNote = failed.length ? `, ${failed.length} unresolved` : "";
      return {
        content: [
          { type: "text", text: `${verdicts.length} add verdict(s) for ${deckId}${failedNote}` },
        ],
        structuredContent: { deck_id: deckId, version: updated.version, verdicts, failed },
      };
    },
  };
}

function deckRemoveTool(store: DeckStore, session: string, index?: CardIndex): ToolDefinition {
  return {
    name: "deck_remove",
    config: {
      title: "Remove cards",
      description:
        "Remove cards by name or oracle_id — a bare string, {card, qty} objects, or an " +
        "array of either (batch; qty defaults to 1). Decrements quantity; an entry is " +
        "dropped when its quantity reaches zero. Idempotent — removing more than present " +
        "clears it. Unresolvable entries come back in failed[] without aborting the rest. " +
        "Pass expected_version for optimistic concurrency: a mismatch returns a conflict " +
        "without mutating.",
      inputSchema: {
        deck_id: z.string(),
        cards: CardInputsSchema,
        expected_version: z.number().int().nonnegative().optional(),
      },
    },
    handler: (args) => {
      const deckId = String(args.deck_id ?? "");
      const { resolved: removals, failed } = resolveCardInputs(index, args.cards);
      const deck = store.get(deckId, session);
      if (!deck) throw new StructuredError("DECK_NOT_FOUND", `unknown deck '${deckId}'`);
      if (typeof args.expected_version === "number" && deck.version !== args.expected_version) {
        return conflict(deckId, deck.version, args.expected_version);
      }

      const remove = new Map<string, number>();
      for (const r of removals) remove.set(r.oracle_id, (remove.get(r.oracle_id) ?? 0) + r.qty);
      const cards = deck.cards
        .map((e) => ({ ...e, qty: e.qty - (remove.get(e.oracle_id) ?? 0) }))
        .filter((e) => e.qty > 0);

      const updated = store.update(deckId, (d) => ({ ...d, cards }), session);
      const failedNote = failed.length ? `; ${failed.length} unresolved` : "";
      return {
        content: [
          {
            type: "text",
            text: `removed from ${deckId} (${cards.length} entries left)${failedNote}`,
          },
        ],
        structuredContent: { deck_id: deckId, version: updated.version, failed },
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

function deckSetCommanderTool(
  store: DeckStore,
  session: string,
  index?: CardIndex,
): ToolDefinition {
  return {
    name: "deck_set_commander",
    config: {
      title: "Set commander(s)",
      description:
        "Set or replace a deck's commander(s), given by oracle_id or card name — a single " +
        "string or an array. Validates " +
        "eligibility + partner/background/Doctor pairings and recomputes the deck's combined " +
        "color identity. Rejects an illegal command zone with Violations rather than applying " +
        "it. Pass expected_version for optimistic concurrency: a mismatch returns a conflict " +
        "without mutating.",
      inputSchema: {
        deck_id: z.string(),
        commanders: COMMANDERS_INPUT,
        command_zone_kind: z.enum(COMMAND_ZONE_KINDS).optional(),
        expected_version: z.number().int().nonnegative().optional(),
      },
    },
    handler: (args) => {
      const deckId = String(args.deck_id ?? "");
      const rawCommanders = normalizeCommanders(args.commanders) ?? [];
      // Accept name-or-id: resolve names to oracle_ids so identity computes correctly.
      const commanders = index ? rawCommanders.map((c) => resolveCardId(index, c)) : rawCommanders;
      const deck = store.get(deckId, session);
      if (!deck) throw new StructuredError("DECK_NOT_FOUND", `unknown deck '${deckId}'`);
      if (typeof args.expected_version === "number" && deck.version !== args.expected_version) {
        return conflict(deckId, deck.version, args.expected_version);
      }

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

      const updated = store.update(
        deckId,
        (d) => ({
          ...d,
          commanders,
          command_zone_kind: kind,
          computed_color_identity: identity,
        }),
        session,
      );
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

function deckSetCompanionTool(
  store: DeckStore,
  session: string,
  index?: CardIndex,
): ToolDefinition {
  return {
    name: "deck_set_companion",
    config: {
      title: "Set companion",
      description:
        "Declare (or clear) the deck's companion, given by oracle_id or card name. Validates " +
        "the card is actually a companion and reports — advisory — whether the deck currently " +
        "meets its deckbuilding condition (the full check is run by validate_deck). Pass an " +
        "empty/omitted companion to clear it. Pass expected_version for optimistic concurrency: " +
        "a mismatch returns a conflict without mutating.",
      inputSchema: {
        deck_id: z.string(),
        companion: z.string().optional(),
        expected_version: z.number().int().nonnegative().optional(),
      },
    },
    handler: (args) => {
      const deckId = String(args.deck_id ?? "");
      const deck = store.get(deckId, session);
      if (!deck) throw new StructuredError("DECK_NOT_FOUND", `unknown deck '${deckId}'`);
      if (typeof args.expected_version === "number" && deck.version !== args.expected_version) {
        return conflict(deckId, deck.version, args.expected_version);
      }

      const raw = typeof args.companion === "string" ? args.companion.trim() : "";
      if (raw === "") {
        const updated = store.update(deckId, (d) => ({ ...d, companion: undefined }), session);
        return {
          content: [{ type: "text", text: `cleared companion on ${deckId}` }],
          structuredContent: {
            ok: true,
            deck_id: deckId,
            companion: null,
            version: updated.version,
          },
        };
      }

      const oracleId = index ? resolveCardId(index, raw) : raw;
      const card = index?.getCard(oracleId) ?? null;
      if (!card || !isCompanionCard(card)) {
        return {
          content: [{ type: "text", text: `rejected: ${card?.name ?? raw} is not a companion` }],
          structuredContent: {
            ok: false,
            deck_id: deckId,
            detail: `${card?.name ?? raw} is not a companion card`,
          },
        };
      }

      const lookup = (id: string): Card | null => index?.getCard(id) ?? null;
      const violations = validateCompanion({ ...deck, companion: oracleId }, lookup);
      const updated = store.update(deckId, (d) => ({ ...d, companion: oracleId }), session);
      return {
        content: [
          {
            type: "text",
            text:
              `set companion ${card.name} on ${deckId}` +
              (violations.length ? ` (${violations.length} condition issue(s))` : ""),
          },
        ],
        structuredContent: {
          ok: true,
          deck_id: deckId,
          companion: { oracle_id: oracleId, name: card.name },
          condition_met: violations.length === 0,
          violations,
          version: updated.version,
        },
      };
    },
  };
}

/** Build the deck lifecycle tools bound to a DeckStore (+ optional index/snapshot), scoped to a session. */
export function makeDeckTools(
  store: DeckStore,
  index?: CardIndex,
  snapshot?: SnapshotProvider,
  session = "local",
): ToolDefinition[] {
  return [
    deckCreateTool(store, session, index, snapshot),
    deckGetTool(store, session, index),
    deckListTool(store, session),
    deckRenameTool(store, session),
    deckDeleteTool(store, session),
    deckSnapshotTool(store, session),
    deckDiffTool(store, session),
    deckRestoreTool(store, session),
    deckImportTool(store, session, index, snapshot),
    deckExportTool(store, session, index),
    deckAddTool(store, session, index),
    deckRemoveTool(store, session, index),
    deckSetCommanderTool(store, session, index),
    deckSetCompanionTool(store, session, index),
  ];
}
