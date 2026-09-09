/**
 * Bounded deck/configuration checks. Inventory and canonical face identity are
 * evidence; starting zones, state, mana, prose and execution require game context.
 */
import type { Card, Deck } from "../types/index.js";
import type { Combo, ComboCardIngredient, SpellbookCardEntry } from "./spellbook.js";

export type RequirementStatus = "satisfied" | "unsatisfied" | "unknown";
export interface ComboCardResolver {
  getCard(oracleId: string): Card | null;
  resolveName(name: string, options?: { exact?: boolean }): readonly { oracle_id: string }[];
}
export interface IngredientApplicability {
  name: string | null;
  oracle_id: string | null;
  required_quantity: number | null;
  aggregate_required_quantity: number | null;
  available_quantity: number | null;
  missing_quantity: number | null;
  present: RequirementStatus;
  commander_requirement: RequirementStatus;
  face_requirement: RequirementStatus;
  face: { face_index: number; source_path: string; name: string | null } | null;
}
export interface ComboApplicability {
  listed_pieces_present: RequirementStatus;
  /** Only the supported static checks; prose/templates may keep this unknown. */
  deck_configuration: RequirementStatus;
  setup_prerequisites: "unknown";
  executable_now: "unknown";
  ingredients: IngredientApplicability[];
  issues: string[];
  limitations: string[];
}
function combine(statuses: readonly RequirementStatus[]): RequirementStatus {
  if (statuses.includes("unsatisfied")) return "unsatisfied";
  return statuses.length === 0 || statuses.includes("unknown") ? "unknown" : "satisfied";
}
function inventory(deck: Deck): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of deck.cards) {
    if (deck.commanders.includes(entry.oracle_id)) continue;
    counts.set(entry.oracle_id, (counts.get(entry.oracle_id) ?? 0) + entry.qty);
  }
  for (const id of deck.commanders) counts.set(id, 1);
  return counts;
}
function resolveIngredient(
  ingredient: ComboCardIngredient,
  resolver: ComboCardResolver,
): Card | null {
  if (ingredient.card.oracle_id) return resolver.getCard(ingredient.card.oracle_id);
  if (!ingredient.card.name) return null;
  const matches = resolver.resolveName(ingredient.card.name, { exact: true });
  return matches.length === 1 && matches[0] ? resolver.getCard(matches[0].oracle_id) : null;
}

/** Main never includes commander slots or the outside-the-deck companion. */
export function spellbookDeckQuery(deck: Deck, resolver: Pick<ComboCardResolver, "getCard">) {
  const commanders: SpellbookCardEntry[] = [];
  const cards: SpellbookCardEntry[] = [];
  const unresolved = new Set<string>();
  for (const [id, qty] of inventory(deck)) {
    const card = resolver.getCard(id);
    if (!card) {
      unresolved.add(id);
      continue;
    }
    if (deck.commanders.includes(id)) commanders.push({ card: card.name, quantity: 1 });
    else cards.push({ card: card.name, quantity: qty });
  }
  return { commanders, cards, unresolved_oracle_ids: [...unresolved] };
}

export function evaluateCombo(
  combo: Combo,
  deck: Deck,
  resolver: ComboCardResolver,
): ComboApplicability {
  const counts = inventory(deck);
  const issues = new Set<string>();
  const resolved = combo.uses.map((ingredient) => resolveIngredient(ingredient, resolver));
  const required = new Map<string, number>();
  const unknownQuantity = new Set<string>();
  combo.uses.forEach((ingredient, i) => {
    const card = resolved[i];
    if (!card) return;
    if (ingredient.quantity === null) unknownQuantity.add(card.oracle_id);
    else required.set(card.oracle_id, (required.get(card.oracle_id) ?? 0) + ingredient.quantity);
  });
  const ingredients = combo.uses.map((ingredient, i): IngredientApplicability => {
    const card = resolved[i];
    const id = card?.oracle_id ?? null;
    const available = id === null ? null : (counts.get(id) ?? 0);
    const total = id === null || unknownQuantity.has(id) ? null : (required.get(id) ?? null);
    const missing = available === null || total === null ? null : Math.max(0, total - available);
    const present = missing === null ? "unknown" : missing > 0 ? "unsatisfied" : "satisfied";
    if (!card)
      issues.add(
        "unresolved_card:" + (ingredient.card.name ?? ingredient.card.oracle_id ?? "unknown"),
      );
    if (present === "unsatisfied") issues.add("insufficient_quantity:" + id);
    if (total === null) issues.add("quantity_unknown:" + (id ?? i));
    const commandOnly =
      ingredient.zone_locations?.length === 1 && ingredient.zone_locations[0] === "C";
    let commander: RequirementStatus = "unknown";
    if (id !== null && (ingredient.must_be_commander === true || commandOnly)) {
      commander = deck.commanders.includes(id) ? "satisfied" : "unsatisfied";
    } else if (
      ingredient.must_be_commander === false &&
      ingredient.zone_locations !== null &&
      ingredient.zone_locations.length > 0 &&
      ingredient.zone_locations.every((zone) => ["H", "B", "C", "E", "G", "L"].includes(zone))
    ) {
      commander = "satisfied";
    }
    if (commander !== "satisfied")
      issues.add("commander_requirement_" + commander + ":" + (id ?? i));
    let faceStatus: RequirementStatus = "unknown";
    let face: IngredientApplicability["face"] = null;
    if (!ingredient.missing_fields.includes("used_face")) {
      if (ingredient.used_face === null) faceStatus = "satisfied";
      else if (card?.gameplay?.faces) {
        const usedFace = ingredient.used_face;
        const found = card.gameplay.faces.find((f) => f.face_index === usedFace - 1);
        faceStatus = found ? "satisfied" : "unsatisfied";
        if (found)
          face = {
            face_index: found.face_index,
            source_path: found.source_path,
            name: found.characteristics.name,
          };
      }
    }
    if (faceStatus !== "satisfied") issues.add("face_requirement_" + faceStatus + ":" + (id ?? i));
    return {
      name: ingredient.card.name,
      oracle_id: id,
      required_quantity: ingredient.quantity,
      aggregate_required_quantity: total,
      available_quantity: available,
      missing_quantity: missing,
      present,
      commander_requirement: commander,
      face_requirement: faceStatus,
      face,
    };
  });
  const listed = combine(ingredients.map((i) => i.present));
  const staticChecks: RequirementStatus[] = [
    listed,
    ...ingredients.flatMap((i) => [i.commander_requirement, i.face_requirement]),
  ];
  if (combo.status !== "OK") {
    issues.add("variant_status_not_verified");
    staticChecks.push("unknown");
  }
  if (combo.missing_fields.includes("uses") || combo.missing_fields.includes("requires")) {
    issues.add("ingredient_evidence_missing");
    staticChecks.push("unknown");
  }
  if (combo.requires.length > 0) {
    issues.add("templates_not_evaluated");
    staticChecks.push("unknown");
  }
  if (combo.easy_prerequisites !== "" || combo.notable_prerequisites !== "") {
    issues.add("text_prerequisites_not_evaluated");
    staticChecks.push("unknown");
  }
  return {
    listed_pieces_present: listed,
    deck_configuration: combine(staticChecks),
    setup_prerequisites: "unknown",
    executable_now: "unknown",
    ingredients,
    issues: [...issues],
    limitations: [
      "Starting zones, card state, mana payment, timing and steps are not evaluated from a deck list.",
      "Template queries and prerequisite prose are preserved for review, not interpreted.",
      "A matching face identifies source evidence; it does not establish that the face is playable.",
      "Deck configuration checks do not replace validate_deck or establish combo execution.",
    ],
  };
}
