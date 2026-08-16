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
import { deckVitals, formatVitals } from "./vitals.js";
import type { SnapshotProvider } from "./snapshot.js";
import { READS_LOCAL, mutates } from "./registry.js";
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
      annotations: mutates({ destructive: false, idempotent: false }),
      title: "Create deck",
      description:
        "Create a versioned deck and return its deck_id.\n" +
        "USE: starting a new build. NOT: loading an existing list (deck_import).\n" +
        "FLOW: (idea) -> deck_create -> deck_set_commander.\n" +
        "ARGS: name; commanders (name-or-id, single string or array; applied immediately — color identity is computed at create; legality is still checked by deck_set_commander/validate_deck); command_zone_kind single|partner|background|doctor_companion (inferred when omitted); format.\n" +
        "RETURNS: deck_id, deck, vitals (card_count/100 incl. command zone, land_count, color_identity, legal, version).",
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
      // Commanders given at create time take effect NOW: compute the color
      // identity (and infer the zone kind) exactly like deck_set_commander does.
      // Historically the identity stayed [] (colorless) until an explicit
      // deck_set_commander call, and the very next import rejected every colored
      // card — dozens of spurious COLOR_IDENTITY violations from one missing
      // call. Still lenient: unresolved commanders contribute nothing to the
      // identity, and legality stays deck_set_commander/validate_deck's job.
      const hasCommanders = Boolean(commanders && commanders.length > 0 && index);
      const identity =
        hasCommanders && index
          ? commanderColorIdentity({ commanders: commanders! }, (id: string) => index.getCard(id))
          : undefined;
      const kind =
        typeof args.command_zone_kind === "string"
          ? (args.command_zone_kind as "single" | "partner" | "background" | "doctor_companion")
          : hasCommanders
            ? inferZoneKind(commanders!, index)
            : undefined;
      const deck = store.create(
        {
          name: String(args.name ?? ""),
          format: args.format === "commander" ? "commander" : undefined,
          commanders,
          command_zone_kind: kind,
          computedColorIdentity: identity,
          dataSnapshot: snapshot?.(),
        },
        session,
      );
      const vitals = deckVitals(deck, index);
      return {
        content: [{ type: "text", text: `created deck ${deck.deck_id} — ${formatVitals(vitals)}` }],
        structuredContent: { deck_id: deck.deck_id, deck, vitals },
      };
    },
  };
}

function deckGetTool(store: DeckStore, session: string, index?: CardIndex): ToolDefinition {
  return {
    name: "deck_get",
    config: {
      annotations: READS_LOCAL,
      title: "Get deck",
      description:
        "Fetch a deck's full contents.\n" +
        "USE: reading the card list. NOT: a health overview (deck_status); finding decks (deck_list).\n" +
        "FLOW: deck_list -> deck_get -> deck_add/deck_remove.\n" +
        "ARGS: deck_id; expand:true for the full Card per entry (default lean oracle_id+qty+name).\n" +
        "RETURNS: deck (cards[], commanders, computed_color_identity, version).",
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

const DECK_LIST_LIMIT = 50;

function deckListTool(store: DeckStore, session: string, index?: CardIndex): ToolDefinition {
  return {
    name: "deck_list",
    config: {
      annotations: READS_LOCAL,
      title: "List decks",
      description:
        "List decks as lean entries.\n" +
        "USE: finding a deck_id or surveying builds. NOT: full contents (deck_get).\n" +
        "FLOW: (session start) -> deck_list -> deck_get.\n" +
        "ARGS: limit (default 50).\n" +
        "RETURNS: decks[] {deck_id, name, version, commanders (names), card_count}, total.",
      inputSchema: { limit: z.number().int().positive().max(500).optional() },
    },
    handler: (args) => {
      const limit = typeof args.limit === "number" ? args.limit : DECK_LIST_LIMIT;
      const all = store.list(session);
      const decks = all.slice(0, limit).map((deck) => ({
        deck_id: deck.deck_id,
        name: deck.name,
        version: deck.version,
        commanders: deck.commanders.map((id) => index?.getCard(id)?.name ?? id),
        card_count: deck.cards.reduce((sum, e) => sum + e.qty, 0) + deck.commanders.length,
      }));
      return {
        content: [{ type: "text", text: `${decks.length} of ${all.length} decks` }],
        structuredContent: { decks, total: all.length },
      };
    },
  };
}

function deckRenameTool(store: DeckStore, session: string, index?: CardIndex): ToolDefinition {
  return {
    name: "deck_rename",
    config: {
      annotations: mutates({ destructive: false, idempotent: true }),
      title: "Rename deck",
      description:
        "Rename a deck.\n" +
        "USE: retitling. NOT: content changes (deck_add/deck_remove).\n" +
        "FLOW: deck_list -> deck_rename -> deck_status.\n" +
        "ARGS: deck_id; name; expected_version for optimistic concurrency (mismatch returns conflict, no mutation).\n" +
        "RETURNS: ok, name, version, vitals.",
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
      const vitals = deckVitals(updated, index);
      return {
        content: [{ type: "text", text: `renamed deck ${deckId} to '${updated.name}'` }],
        structuredContent: {
          ok: true,
          deck_id: deckId,
          name: updated.name,
          version: updated.version,
          vitals,
        },
      };
    },
  };
}

function deckDeleteTool(store: DeckStore, session: string): ToolDefinition {
  return {
    name: "deck_delete",
    config: {
      annotations: mutates({ destructive: true, idempotent: true }),
      title: "Delete deck",
      description:
        "Delete a deck permanently.\n" +
        "USE: discarding a build. NOT: undoable experiments (deck_snapshot then deck_restore).\n" +
        "FLOW: deck_list -> deck_delete -> deck_list.\n" +
        "ARGS: deck_id.\n" +
        "RETURNS: deleted:true.",
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
      annotations: mutates({ destructive: false, idempotent: false }),
      title: "Snapshot deck",
      description:
        "Capture an immutable snapshot of a deck's current state.\n" +
        "USE: checkpointing before risky edits. NOT: copying to a new deck (deck_export then deck_import).\n" +
        "FLOW: deck_status -> deck_snapshot -> (edit) -> deck_diff.\n" +
        "ARGS: deck_id.\n" +
        "RETURNS: snapshot_id, version.",
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
      annotations: READS_LOCAL,
      title: "Diff deck",
      description:
        "Compare a snapshot against the current deck (or a second snapshot).\n" +
        "USE: reviewing what changed since a checkpoint. NOT: legality (validate_deck).\n" +
        "FLOW: deck_snapshot -> (edits) -> deck_diff -> deck_restore.\n" +
        "ARGS: deck_id; snapshot_id (baseline); to_snapshot_id (optional target, default current).\n" +
        "RETURNS: diff {cards {added, removed, changed}, metadata changes}.",
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

function deckRestoreTool(store: DeckStore, session: string, index?: CardIndex): ToolDefinition {
  return {
    name: "deck_restore",
    config: {
      annotations: mutates({ destructive: true, idempotent: true }),
      title: "Restore deck",
      description:
        "Roll a deck back to a snapshot.\n" +
        "USE: undoing edits since a checkpoint. NOT: deleting the deck (deck_delete).\n" +
        "FLOW: deck_diff -> deck_restore -> deck_status.\n" +
        "ARGS: deck_id; snapshot_id.\n" +
        "RETURNS: deck, vitals. Keeps deck_id; version bumps (restore is itself a mutation).",
      inputSchema: { deck_id: z.string(), snapshot_id: z.string() },
    },
    handler: (args) => {
      const deckId = String(args.deck_id ?? "");
      const snapshotId = String(args.snapshot_id ?? "");
      const deck = store.restore(deckId, snapshotId, session);
      const vitals = deckVitals(deck, index);
      return {
        content: [
          {
            type: "text",
            text: `restored ${deckId} from ${snapshotId} — ${formatVitals(vitals)}`,
          },
        ],
        structuredContent: { deck_id: deckId, restored_from: snapshotId, deck, vitals },
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
      annotations: mutates({ destructive: false, idempotent: false }),
      title: "Import decklist",
      description:
        "Parse decklist text (Moxfield/Archidekt/MTGO/Arena/plaintext) into a deck.\n" +
        "USE: bulk-loading an existing list. NOT: adding a few cards (deck_add).\n" +
        "FLOW: (list text) -> deck_import -> deck_status.\n" +
        "ARGS: text; deck_id (add to existing) or name (create new).\n" +
        "RETURNS: deck_id, resolved_count, unresolved[] (per line, with candidates/suggestions — never silently dropped), vitals.",
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
      let updated: Deck;
      if (typeof args.deck_id === "string") {
        deckId = args.deck_id;
        updated = store.update(
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
        updated = store.update(deckId, (d) => ({ ...d, cards: additions }), session);
      }

      const vitals = deckVitals(updated, index);
      return {
        content: [
          {
            type: "text",
            text: `imported ${additions.length} cards into ${deckId}; ${unresolved.length} unresolved — ${formatVitals(vitals)}`,
          },
        ],
        structuredContent: {
          deck_id: deckId,
          resolved_count: additions.length,
          unresolved,
          vitals,
        },
      };
    },
  };
}

function deckExportTool(store: DeckStore, session: string, index?: CardIndex): ToolDefinition {
  return {
    name: "deck_export",
    config: {
      annotations: READS_LOCAL,
      title: "Export decklist",
      description:
        "Export a deck as plaintext '<qty> <name>' decklist lines.\n" +
        "USE: sharing or moving a list out. NOT: reading structured contents (deck_get).\n" +
        "FLOW: validate_deck -> deck_export -> (share).\n" +
        "ARGS: deck_id; format text.\n" +
        "RETURNS: text (quantity + card identity only; per-entry set/collector data is not stored).",
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
      annotations: mutates({ destructive: false, idempotent: false }),
      title: "Add cards",
      description:
        "Add cards to a deck; accepts names or oracle_ids, singular or array.\n" +
        "USE: putting specific cards into a deck. NOT: bulk decklist text (deck_import); browsing candidates (card_search).\n" +
        "FLOW: card_search/meta_recommend -> deck_add -> deck_status.\n" +
        'ARGS: deck_id; cards: "Sol Ring" | ["Sol Ring", {card:"Island", qty:8}]; force:true applies rule-breaking cards flagged illegal; expected_version for optimistic concurrency.\n' +
        "RETURNS: verdicts[] (ok | rejected+violations | added_illegal), failed[] (unresolved inputs with suggestions/candidates — one typo never aborts the batch), vitals — no follow-up deck_get needed.",
      inputSchema: {
        deck_id: z.string(),
        cards: CardInputsSchema,
        force: z.boolean().optional(),
        expected_version: z.number().int().nonnegative().optional(),
      },
      // All-optional: the conflict variant carries none of the success keys.
      // No outputSchema — strict clients reject the SDK's draft-07 rendering
      // of it ("invalid outputSchema"); see the note on card_search.
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
      const vitals = deckVitals(updated, index);
      const failedNote = failed.length ? `, ${failed.length} unresolved` : "";
      return {
        content: [
          {
            type: "text",
            text: `${verdicts.length} add verdict(s) for ${deckId}${failedNote} — ${formatVitals(vitals)}`,
          },
        ],
        structuredContent: { deck_id: deckId, version: updated.version, verdicts, failed, vitals },
      };
    },
  };
}

function deckRemoveTool(store: DeckStore, session: string, index?: CardIndex): ToolDefinition {
  return {
    name: "deck_remove",
    config: {
      annotations: mutates({ destructive: false, idempotent: false }),
      title: "Remove cards",
      description:
        "Remove cards from a deck; accepts names or oracle_ids, singular or array (qty defaults to 1).\n" +
        "USE: cutting cards. NOT: rolling back many edits (deck_restore).\n" +
        "FLOW: deck_status/analyze_curve -> deck_remove -> deck_status.\n" +
        'ARGS: deck_id; cards: "Island" | [{card, qty}]; expected_version for optimistic concurrency.\n' +
        "RETURNS: version, failed[] (unresolved inputs), vitals. Decrements quantity; entries drop at zero; over-removal clears (idempotent).",
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
      const vitals = deckVitals(updated, index);
      const failedNote = failed.length ? `; ${failed.length} unresolved` : "";
      return {
        content: [
          {
            type: "text",
            text: `removed from ${deckId}${failedNote} — ${formatVitals(vitals)}`,
          },
        ],
        structuredContent: { deck_id: deckId, version: updated.version, failed, vitals },
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
      annotations: mutates({ destructive: false, idempotent: true }),
      title: "Set commander(s)",
      description:
        "Set or replace the deck's commander(s) by name or oracle_id, single string or array.\n" +
        "USE: choosing the command zone; changing color identity. NOT: the other 99 (deck_add); a what-if check (validate_commander).\n" +
        "FLOW: card_search (is:commander) -> deck_set_commander -> meta_recommend.\n" +
        "ARGS: deck_id; commanders; command_zone_kind single|partner|background|doctor_companion (inferred when omitted); expected_version.\n" +
        "RETURNS: ok, computed_color_identity, version, vitals — or ok:false + violations (nothing applied; current-state vitals).",
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
        // Current-state vitals so the agent still learns where the deck stands.
        return {
          content: [{ type: "text", text: `rejected: ${violations.length} violation(s)` }],
          structuredContent: {
            ok: false,
            deck_id: deckId,
            violations,
            vitals: deckVitals(deck, index),
          },
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
      const vitals = deckVitals(updated, index);
      return {
        content: [
          {
            type: "text",
            text: `set ${commanders.length} commander(s) on ${deckId} — ${formatVitals(vitals)}`,
          },
        ],
        structuredContent: {
          ok: true,
          deck_id: deckId,
          commanders,
          command_zone_kind: kind,
          computed_color_identity: identity,
          version: updated.version,
          vitals,
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
      annotations: mutates({ destructive: false, idempotent: true }),
      title: "Set companion",
      description:
        "Declare or clear the deck's companion by name or oracle_id.\n" +
        "USE: setting a companion (empty/omitted clears it). NOT: commanders (deck_set_commander).\n" +
        "FLOW: deck_set_commander -> deck_set_companion -> validate_deck.\n" +
        "ARGS: deck_id; companion; expected_version.\n" +
        "RETURNS: ok, companion, condition_met (advisory — validate_deck runs the full deckbuilding-condition check), violations, vitals.",
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
            vitals: deckVitals(updated, index),
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
            vitals: deckVitals(deck, index),
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
          vitals: deckVitals(updated, index),
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
    deckListTool(store, session, index),
    deckRenameTool(store, session, index),
    deckDeleteTool(store, session),
    deckSnapshotTool(store, session),
    deckDiffTool(store, session),
    deckRestoreTool(store, session, index),
    deckImportTool(store, session, index, snapshot),
    deckExportTool(store, session, index),
    deckAddTool(store, session, index),
    deckRemoveTool(store, session, index),
    deckSetCommanderTool(store, session, index),
    deckSetCompanionTool(store, session, index),
  ];
}
