/**
 * Name-or-id resolution for tool inputs (review #1).
 *
 * Many tools accept a card by oracle_id, but agents naturally pass a *name*.
 * Feeding a name straight to CardIndex.getCard returns null — which, for the
 * commander tools, silently produced an empty color identity that then rejected
 * every colored card. resolveCardId accepts either: an oracle_id is returned
 * as-is (getCard is the validity test — no UUID regex needed); otherwise the
 * string is resolved by name through the same anti-hallucination gateway used
 * elsewhere (exact-first, fuzzy fallback), mapping 0 -> UNKNOWN_CARD and
 * >1 -> AMBIGUOUS_NAME (with candidates) so the caller fails loud, never silent.
 */
import { StructuredError } from "../types/index.js";
import type { CardIndex } from "../index/index.js";

/**
 * Resolve a card reference (oracle_id OR card name) to a canonical oracle_id.
 * Throws UNKNOWN_CARD when nothing matches and AMBIGUOUS_NAME (with candidate
 * CardRefs) when a name matches more than one card.
 */
export function resolveCardId(index: CardIndex, raw: string): string {
  // A valid oracle_id resolves to a Card directly — accept it verbatim.
  if (index.getCard(raw)) return raw;
  const matches = index.resolveName(raw);
  if (matches.length === 1) return matches[0]!.oracle_id;
  if (matches.length === 0) {
    throw new StructuredError("UNKNOWN_CARD", `no card named '${raw}'`);
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
