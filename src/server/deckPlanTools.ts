/** Reviewable full-deck changes with explicit, atomic and retry-safe application. */
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { prepareDeckChange } from "../deck/deckPlan.js";
import { diffDecks } from "../deck/diff.js";
import type { DeckStore } from "../deck/deckStore.js";
import type { CardIndex } from "../index/cardIndex.js";
import { DeckPlanRequestSchema } from "../types/deckPlan.js";
import { StructuredError, type Deck } from "../types/index.js";
import { READS_LOCAL, mutates, type ToolDefinition } from "./registry.js";
import { staticSnapshotProvider, type SnapshotProvider } from "./snapshot.js";

const reference = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !value.includes("\0"));
const version = z.number().int().positive();
const digest = z.string().regex(/^[a-f0-9]{64}$/);

/** The supplied digest detects changed payloads; it is not an authorization credential. */
export const DeckChangePlanSchema = z
  .object({
    schema_version: z.literal(1),
    plan_id: z.string().uuid(),
    request_hash: digest,
    input: DeckPlanRequestSchema,
    deck_id: reference.optional(),
    expected_version: version.optional(),
    data_snapshot: z.string(),
    data_revision: digest,
    inventory_revision: reference.nullable(),
    session_binding: digest,
    review: z.object({ desired: z.json(), diff: z.json(), validation: z.json() }).strict(),
  })
  .strict();

export type DeckChangePlan = z.infer<typeof DeckChangePlanSchema>;

const previewSchema = z
  .object({
    input: DeckPlanRequestSchema,
    deck_id: reference.optional(),
    expected_version: version.optional(),
    inventory_revision: reference.optional(),
  })
  .strict();

/** Stable JSON object ordering makes the digest independent of client key order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  const result = JSON.stringify(value);
  if (result === undefined) throw new Error("Plan must contain JSON data");
  return result;
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function reply(payload: Record<string, unknown>, isError = false) {
  return {
    content: [
      {
        type: "text" as const,
        text: String(
          payload.code ?? (payload.replayed ? "Original deck change receipt" : "Deck change plan"),
        ),
      },
    ],
    structuredContent: payload,
    ...(isError ? { isError: true } : {}),
  };
}

function rejected(code: string, message: string, details: Record<string, unknown> = {}) {
  return reply({ ok: false, code, message, ...details }, true);
}

function emptySource(desired: Deck): Deck {
  return {
    deck_id: desired.deck_id,
    name: "",
    format: desired.format,
    cards: [],
    commanders: [],
    command_zone_kind: "single",
    computed_color_identity: [],
    version: 0,
    data_snapshot: "",
  };
}

export function makeDeckPlanTools(
  store: DeckStore,
  session: string,
  index?: CardIndex,
  snapshot: SnapshotProvider = staticSnapshotProvider(),
): ToolDefinition[] {
  const sessionBinding = hash({ scope: "deck-change-plan", session });
  // Freeze the SQLite card image across all lookups and its revision digest.
  // Offline retries may still return a durable receipt without card data.
  const withCardRead = <T>(operation: () => T): T =>
    index ? index.withRead(operation) : operation();
  const requireIndex = (): CardIndex => {
    if (!index)
      throw new StructuredError(
        "UPSTREAM_UNAVAILABLE",
        "Install card data with data_ingest before preparing or applying a new deck change.",
      );
    return index;
  };
  const source = (deckId: string | undefined): Deck | undefined => {
    const deck = deckId === undefined ? undefined : store.get(deckId, session);
    if (deckId !== undefined && !deck)
      throw new StructuredError("DECK_NOT_FOUND", `unknown deck '${deckId}'`);
    return deck;
  };
  const checkVersion = (
    deckId: string | undefined,
    expected: number | undefined,
    deck: Deck | undefined,
  ) => {
    if ((deckId === undefined) !== (expected === undefined))
      return rejected(
        "PLAN_VERSION_REQUIRED",
        "Existing decks require expected_version; new decks must omit it.",
      );
    if (deck && deck.version !== expected)
      return rejected(
        "PLAN_VERSION_CONFLICT",
        "The source deck changed; preview the current deck again.",
        {
          deck_id: deck.deck_id,
          expected_version: expected,
          current_version: deck.version,
          conflict: true,
        },
      );
    return undefined;
  };
  return [
    {
      name: "deck_plan_preview",
      config: {
        title: "Preview a deck change",
        annotations: READS_LOCAL,
        description:
          "Preview an exact full-deck build or revision without saving it.\n" +
          "USE: reviewing a complete proposal. NOT: incremental editing (deck_add).\n" +
          "FLOW: construction_spec/card_discover -> deck_plan_preview -> deck_plan_apply.\n" +
          "ARGS: input {name?,request}; request.cards is the complete library with exact names or IDs. Existing decks require deck_id and expected_version; omit both for a new build. Inventory revisions are unsupported.\n" +
          "RETURNS: plan, desired, diff, validation. Only valid plans apply; apply rechecks every constraint. Review the full result, then pass plan unchanged. No cards, snapshots or receipts are saved.",
        inputSchema: previewSchema.shape,
      },
      handler: (args) =>
        withCardRead(() => {
          const parsed = previewSchema.parse(args);
          const deck = source(parsed.deck_id);
          const conflict = checkVersion(parsed.deck_id, parsed.expected_version, deck);
          if (conflict) return conflict;
          if (parsed.inventory_revision !== undefined)
            return rejected(
              "PLAN_INVENTORY_UNSUPPORTED",
              "Inventory revision binding is not supported; no inventory guarantee can be made.",
            );
          const dataSnapshot = snapshot();
          const currentIndex = requireIndex();
          const prepared = prepareDeckChange(parsed.input, currentIndex, deck, dataSnapshot);
          const diff = diffDecks(deck ?? emptySource(prepared.desired), prepared.desired);
          const bound = {
            schema_version: 1 as const,
            plan_id: randomUUID(),
            input: parsed.input,
            ...(parsed.deck_id === undefined
              ? {}
              : { deck_id: parsed.deck_id, expected_version: parsed.expected_version }),
            data_snapshot: dataSnapshot,
            data_revision: currentIndex.revision(),
            inventory_revision: null,
            session_binding: sessionBinding,
            review: { desired: prepared.desired, diff, validation: prepared.validation },
          };
          const plan = DeckChangePlanSchema.parse({ ...bound, request_hash: hash(bound) });
          return reply(
            {
              ok: prepared.validation.valid,
              ...(prepared.validation.valid ? {} : { code: "PLAN_INVALID" }),
              plan,
              desired: prepared.desired,
              diff,
              validation: prepared.validation,
            },
            !prepared.validation.valid,
          );
        }),
    },
    {
      name: "deck_plan_apply",
      config: {
        title: "Apply a reviewed deck change",
        annotations: mutates({ destructive: true, idempotent: true }),
        description:
          "Apply a reviewed full-deck plan atomically and return its durable receipt.\n" +
          "USE: saving a reviewed preview. NOT: changing its payload (deck_plan_preview again).\n" +
          "FLOW: deck_plan_preview -> deck_plan_apply -> deck_status/deck_restore.\n" +
          "ARGS: plan exactly as previewed; digest checks consistency, not authorization. Revalidates version, served data and final constraints.\n" +
          "RETURNS: deck_id, deck, version, snapshot_id for revisions, receipt, replayed. Exact retries return the original receipt even after later edits or deletion; they never reapply. A fresh preview permits another new build.",
        inputSchema: { plan: DeckChangePlanSchema },
      },
      handler: (args) =>
        store.transaction(() => {
          const plan = DeckChangePlanSchema.parse(args.plan);
          const { request_hash: requestHash, ...bound } = plan;
          if (hash(bound) !== requestHash)
            return rejected(
              "PLAN_HASH_MISMATCH",
              "The reviewed plan payload changed; preview it again.",
            );
          if (plan.session_binding !== sessionBinding)
            return rejected("PLAN_SESSION_MISMATCH", "This plan belongs to a different session.");
          const previous = store.getPlanReceipt(plan.plan_id, session);
          if (previous && previous.request_hash !== requestHash)
            return rejected(
              "PLAN_HASH_MISMATCH",
              "This plan ID already has a receipt for a different request.",
            );
          if (previous)
            return reply({
              ok: true,
              replayed: true,
              receipt: previous,
              deck_id: previous.deck.deck_id,
              deck: previous.deck,
              version: previous.deck.version,
              ...(previous.snapshot_id ? { snapshot_id: previous.snapshot_id } : {}),
            });
          if (plan.data_snapshot !== snapshot())
            return rejected(
              "PLAN_DATA_CONFLICT",
              "Served card data changed; preview against the current data.",
              {
                expected_data_snapshot: plan.data_snapshot,
                current_data_snapshot: snapshot(),
                conflict: true,
              },
            );
          if (plan.inventory_revision !== null)
            return rejected(
              "PLAN_INVENTORY_UNSUPPORTED",
              "Inventory revision binding is not supported; preview without an inventory guarantee.",
            );
          const currentIndex = requireIndex();
          return currentIndex.withRead(() => {
            if (plan.data_revision !== currentIndex.revision())
              return rejected(
                "PLAN_DATA_CONFLICT",
                "Served card data changed within this snapshot date; preview against the current data.",
                {
                  expected_data_revision: plan.data_revision,
                  current_data_revision: currentIndex.revision(),
                  conflict: true,
                },
              );
            const deck = source(plan.deck_id);
            const conflict = checkVersion(plan.deck_id, plan.expected_version, deck);
            if (conflict) return conflict;
            const prepared = prepareDeckChange(plan.input, currentIndex, deck, plan.data_snapshot);
            if (!prepared.validation.valid)
              return rejected(
                "PLAN_INVALID",
                "The complete desired deck does not satisfy the reviewed constraints.",
                { validation: prepared.validation },
              );
            const diff = diffDecks(deck ?? emptySource(prepared.desired), prepared.desired);
            if (
              canonicalJson(plan.review.desired) !== canonicalJson(prepared.desired) ||
              canonicalJson(plan.review.diff) !== canonicalJson(diff)
            )
              return rejected(
                "PLAN_CONTENT_MISMATCH",
                "The reviewed desired deck or diff differs from this plan's validated change; preview it again.",
              );
            const { receipt, replayed } = store.commitPlan(
              {
                plan_id: plan.plan_id,
                request_hash: requestHash,
                desired: prepared.desired,
                ...(plan.deck_id === undefined
                  ? {}
                  : { deck_id: plan.deck_id, expected_version: plan.expected_version }),
              },
              session,
            );
            return reply({
              ok: true,
              replayed,
              receipt,
              deck_id: receipt.deck.deck_id,
              deck: receipt.deck,
              version: receipt.deck.version,
              ...(receipt.snapshot_id ? { snapshot_id: receipt.snapshot_id } : {}),
            });
          });
        }),
    },
  ];
}
