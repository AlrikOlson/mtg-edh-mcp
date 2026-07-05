/**
 * Name-or-id resolution for tool inputs (review #1, ergonomics overhaul C1).
 *
 * Many tools accept a card by oracle_id, but agents naturally pass a *name*.
 * Feeding a name straight to CardIndex.getCard returns null — which, for the
 * commander tools, silently produced an empty color identity that then rejected
 * every colored card. resolveCardId accepts either: an oracle_id is returned
 * as-is (getCard is the validity test — no UUID regex needed); otherwise the
 * string is resolved by name through the same anti-hallucination gateway used
 * elsewhere (exact-first, fuzzy fallback), mapping 0 -> UNKNOWN_CARD (with
 * did-you-mean suggestions) and >1 -> AMBIGUOUS_NAME (with candidates) so the
 * caller fails loud, never silent.
 *
 * Batch inputs go through CardInputsSchema + resolveCardInputs instead:
 * singular-or-array, bare-string-or-object, per-item soft failures — one typo
 * never aborts a 30-card add.
 */
import { z } from "zod";
import { StructuredError } from "../types/index.js";
import type { CardRef } from "../types/index.js";
import type { CardIndex } from "../index/index.js";

/**
 * One card reference in a tool input: a bare string (card name or oracle_id),
 * or an object with an optional quantity. `card` is the canonical key;
 * `oracle_id` and `name` are accepted as aliases.
 */
export const CardInputSchema = z.union([
  z.string(),
  z
    .object({
      card: z.string().optional(),
      oracle_id: z.string().optional(),
      name: z.string().optional(),
      qty: z.number().int().positive().optional(),
    })
    .refine((o) => typeof (o.card ?? o.oracle_id ?? o.name) === "string", {
      message: "one of card/oracle_id/name is required",
    }),
]);

/** Singular-or-array of card references. */
export const CardInputsSchema = z.union([CardInputSchema, z.array(CardInputSchema)]);

/** Strings, singular-or-array (collection tools, card_get). */
export const StringOrStringsSchema = z.union([z.string(), z.array(z.string())]);

/** Normalize a singular-or-array of strings to a string[]. */
export function normalizeStrings(raw: unknown): string[] {
  const parsed = StringOrStringsSchema.parse(raw ?? []);
  return typeof parsed === "string" ? [parsed] : parsed;
}

/** A successfully resolved batch entry. */
export interface ResolvedEntry {
  oracle_id: string;
  name: string;
  qty: number;
  /** The original input string this entry came from (first occurrence on merge). */
  input: string;
}

/** A batch entry that failed to resolve — reported in-band, never thrown. */
export interface FailedEntry {
  input: string;
  reason: "UNKNOWN_CARD" | "AMBIGUOUS_NAME";
  /** AMBIGUOUS_NAME: the matching cards to pick from. */
  candidates?: CardRef[];
  /** UNKNOWN_CARD: did-you-mean suggestions. */
  suggestions?: CardRef[];
}

/**
 * Resolve a batch card input (CardInputsSchema-shaped) to oracle_ids with
 * per-item soft failures. Duplicate oracle_ids merge by summing qty. Without an
 * index the refs pass through verbatim as oracle_ids (test/degraded servers).
 */
export function resolveCardInputs(
  index: CardIndex | undefined,
  raw: unknown,
): { resolved: ResolvedEntry[]; failed: FailedEntry[] } {
  const parsed = CardInputsSchema.parse(raw);
  const items = Array.isArray(parsed) ? parsed : [parsed];

  const byId = new Map<string, ResolvedEntry>();
  const failed: FailedEntry[] = [];
  for (const item of items) {
    const ref = typeof item === "string" ? item : (item.card ?? item.oracle_id ?? item.name ?? "");
    const qty = typeof item === "string" ? 1 : (item.qty ?? 1);

    let oracleId: string;
    let name: string;
    if (!index) {
      oracleId = ref;
      name = ref;
    } else {
      const direct = index.getCard(ref);
      if (direct) {
        oracleId = ref;
        name = direct.name;
      } else {
        const matches = index.resolveName(ref);
        if (matches.length === 1) {
          oracleId = matches[0]!.oracle_id;
          name = matches[0]!.name;
        } else if (matches.length > 1) {
          failed.push({ input: ref, reason: "AMBIGUOUS_NAME", candidates: matches });
          continue;
        } else {
          failed.push({
            input: ref,
            reason: "UNKNOWN_CARD",
            suggestions: index.suggestNames(ref),
          });
          continue;
        }
      }
    }

    const existing = byId.get(oracleId);
    if (existing) existing.qty += qty;
    else byId.set(oracleId, { oracle_id: oracleId, name, qty, input: ref });
  }
  return { resolved: [...byId.values()], failed };
}

/**
 * Resolve a card reference (oracle_id OR card name) to a canonical oracle_id.
 * Throws UNKNOWN_CARD (with did-you-mean suggestions) when nothing matches and
 * AMBIGUOUS_NAME (with candidate CardRefs) when a name matches more than one card.
 */
export function resolveCardId(index: CardIndex, raw: string): string {
  // A valid oracle_id resolves to a Card directly — accept it verbatim.
  if (index.getCard(raw)) return raw;
  const matches = index.resolveName(raw);
  if (matches.length === 1) return matches[0]!.oracle_id;
  if (matches.length === 0) {
    throw new StructuredError("UNKNOWN_CARD", `no card named '${raw}'`, {
      input: raw,
      suggestions: index.suggestNames(raw),
    });
  }
  throw new StructuredError("AMBIGUOUS_NAME", `'${raw}' matched ${matches.length} cards`, {
    candidates: matches,
  });
}

/**
 * Lenient variant for constructors (deck_create): resolve to an oracle_id when
 * the input resolves unambiguously, otherwise return it unchanged. deck_create
 * is not the legality gate — deck_set_commander / validate_deck are — so it must
 * not reject an as-yet-unknown commander (e.g. a scratch deck). Names that match
 * exactly one card are still upgraded to their oracle_id.
 */
export function resolveCardIdLenient(index: CardIndex, raw: string): string {
  try {
    return resolveCardId(index, raw);
  } catch {
    return raw;
  }
}
