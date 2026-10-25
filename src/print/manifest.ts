/**
 * Print card manifest (Proxy Order Helper, step 1).
 *
 * A pure reader: a saved {@link Deck} plus a card lookup becomes the exact,
 * ordered list of physical cards a printer must produce, pinned to the deck
 * version the user reviewed. It owns no storage and performs no network I/O;
 * the later print_* owners (job store, image selector, project file) read
 * this record and never recount the deck themselves.
 *
 * Rules carried from the roadmap record (`print-card-manifest`, think:442):
 * - quantities are preserved and each commander is printed exactly once;
 * - the companion and tokens are separately selected extras outside the count;
 * - both faces of a transform or modal double-faced card share one physical
 *   card (a front image and a back image); split, adventure, flip, prepare and
 *   meld layouts are one printed face;
 * - nothing is omitted or replaced silently: every irregularity is an entry in
 *   the manifest's attention list while the card itself stays in the manifest.
 */
import type { Card, Deck } from "../types/index.js";
import type { CardLookup } from "../validate/index.js";

export type { CardLookup };

/** Where a physical card comes from within the deck record. */
export type PrintSource = "commander" | "library" | "companion";

/** One printed face, identified by its catalog position, never by an image. */
export interface PrintFace {
  /** `faces[face_index]` on the catalog record; 0 for a card printed from its root. */
  face_index: number;
  /** JSON Pointer of the face in the source card (`""` for the root record). */
  source_path: string;
  name: string;
}

/** One physical card to print. */
export interface PrintCard {
  /** 1-based position in the print order; unique across cards and extras. */
  slot: number;
  oracle_id: string;
  name: string;
  source: PrintSource;
  /** The deck entry was force-added despite a validation violation; the card is still printed. */
  illegal: boolean;
  front: PrintFace;
  /** Set only when both faces share this physical card (transform, modal). */
  back: PrintFace | null;
}

/** A token the deck's cards can create, offered as an optional extra. */
export interface TokenExtra {
  /** Scryfall id of the token printing named by the catalog's related cards. */
  related_id: string;
  name: string;
  type_line: string;
  /** Deck cards that name this token, in deck order, each once. */
  from_oracle_ids: readonly string[];
  selected: boolean;
}

export type AttentionKind =
  | "illegal_card"
  | "unknown_card"
  | "missing_faces"
  | "commander_in_library"
  | "unknown_companion"
  | "unknown_token";

/** An irregularity the user must see; the affected cards stay in the manifest. */
export interface AttentionItem {
  kind: AttentionKind;
  /** The oracle_id (or token related_id) the item is about. */
  ref: string;
  /** Slots of the affected physical cards; empty when no card was produced. */
  slots: readonly number[];
  message: string;
}

/** The deck identity a manifest is pinned to. */
export interface PrintPin {
  deck_id: string;
  version: number;
  /** When set, the manifest must come from this card-index snapshot too. */
  data_snapshot?: string;
}

export interface PrintManifest {
  deck_id: string;
  deck_name: string;
  version: number;
  data_snapshot: string;
  /** Commanders first, in command-zone order, then library entries in deck order. */
  cards: readonly PrintCard[];
  extras: {
    companion: PrintCard | null;
    tokens: readonly TokenExtra[];
  };
  /** Sum of library quantities plus the number of commanders; extras excluded. */
  total: number;
  attention: readonly AttentionItem[];
}

export interface ManifestConflict {
  reason: "deck_id" | "version" | "data_snapshot";
  pinned: PrintPin;
  actual: { deck_id: string; version: number; data_snapshot: string };
}

export type PrintManifestResult =
  { kind: "manifest"; manifest: PrintManifest } | { kind: "conflict"; conflict: ManifestConflict };

export interface BuildPrintManifestOptions {
  /** The deck identity the user reviewed; a different live deck is a conflict. */
  pinned?: PrintPin;
  /** Token extras (by related_id) the user chose to print. */
  selected_tokens?: readonly string[];
}

/** Layouts whose two catalog faces are printed on one physical card (CR 712). */
const TWO_SIDED_RELATIONSHIPS: ReadonlySet<string> = new Set(["transform", "modal"]);

function detectConflict(deck: Deck, pinned: PrintPin): ManifestConflict | null {
  const actual = {
    deck_id: deck.deck_id,
    version: deck.version,
    data_snapshot: deck.data_snapshot,
  };
  if (pinned.deck_id !== deck.deck_id) return { reason: "deck_id", pinned, actual };
  if (pinned.version !== deck.version) return { reason: "version", pinned, actual };
  if (pinned.data_snapshot !== undefined && pinned.data_snapshot !== deck.data_snapshot) {
    return { reason: "data_snapshot", pinned, actual };
  }
  return null;
}

class AttentionList {
  private readonly items = new Map<
    string,
    { kind: AttentionKind; ref: string; slots: number[]; message: string }
  >();

  add(kind: AttentionKind, ref: string, slot: number | null, message: string): void {
    const key = `${kind}:${ref}`;
    const existing = this.items.get(key);
    if (existing) {
      if (slot !== null) existing.slots.push(slot);
      return;
    }
    this.items.set(key, { kind, ref, slots: slot === null ? [] : [slot], message });
  }

  toArray(): AttentionItem[] {
    return [...this.items.values()].map((item) => ({ ...item, slots: [...item.slots] }));
  }
}

interface Faces {
  front: PrintFace;
  back: PrintFace | null;
  /** The layout wants a back face the catalog record does not carry. */
  facesMissing: boolean;
}

function rootFace(name: string): PrintFace {
  return { face_index: 0, source_path: "", name };
}

function printFace(card: Card, index: number): PrintFace | null {
  const face = card.gameplay?.faces?.[index];
  if (!face) return null;
  return {
    face_index: face.face_index,
    source_path: face.source_path,
    name: face.characteristics.name ?? card.name,
  };
}

function facesOf(card: Card): Faces {
  const twoSided = TWO_SIDED_RELATIONSHIPS.has(card.gameplay?.face_relationship ?? "");
  const front = printFace(card, 0) ?? rootFace(card.name);
  if (!twoSided) return { front, back: null, facesMissing: false };
  const back = printFace(card, 1);
  return { front, back, facesMissing: back === null };
}

class ManifestBuilder {
  private nextSlot = 1;
  readonly attention = new AttentionList();
  private readonly tokens = new Map<string, { name: string; type_line: string; from: string[] }>();

  constructor(private readonly lookup: CardLookup) {}

  place(oracle_id: string, source: PrintSource, illegal: boolean): PrintCard {
    const slot = this.nextSlot++;
    const card = this.lookup(oracle_id);
    if (!card) {
      this.attention.add(
        source === "companion" ? "unknown_companion" : "unknown_card",
        oracle_id,
        slot,
        `No catalog record for ${oracle_id}; the slot is kept under its oracle id and needs a user-supplied image.`,
      );
      return {
        slot,
        oracle_id,
        name: oracle_id,
        source,
        illegal,
        front: rootFace(oracle_id),
        back: null,
      };
    }
    const faces = facesOf(card);
    if (faces.facesMissing) {
      this.attention.add(
        "missing_faces",
        oracle_id,
        slot,
        `${card.name} is a two-sided card but its catalog record carries no back face; only the front is printed.`,
      );
    }
    if (illegal) {
      this.attention.add(
        "illegal_card",
        oracle_id,
        slot,
        `${card.name} is flagged illegal in the deck; it is printed as saved.`,
      );
    }
    this.collectTokens(card);
    return {
      slot,
      oracle_id,
      name: card.name,
      source,
      illegal,
      front: faces.front,
      back: faces.back,
    };
  }

  private collectTokens(card: Card): void {
    for (const related of card.gameplay?.related_cards ?? []) {
      if (related.component !== "token") continue;
      const entry = this.tokens.get(related.id) ?? {
        name: related.name,
        type_line: related.type_line,
        from: [],
      };
      if (!entry.from.includes(card.oracle_id)) entry.from.push(card.oracle_id);
      this.tokens.set(related.id, entry);
    }
  }

  tokenExtras(selected: readonly string[]): TokenExtra[] {
    for (const id of selected) {
      if (!this.tokens.has(id)) {
        this.attention.add(
          "unknown_token",
          id,
          null,
          `No card in this deck names token ${id}; it was not added.`,
        );
      }
    }
    return [...this.tokens.entries()].map(([related_id, entry]) => ({
      related_id,
      name: entry.name,
      type_line: entry.type_line,
      from_oracle_ids: [...entry.from],
      selected: selected.includes(related_id),
    }));
  }
}

/**
 * Build the physical-card manifest for `deck`, or report a conflict when the
 * live deck is not the one `options.pinned` names.
 */
export function buildPrintManifest(
  deck: Deck,
  lookup: CardLookup,
  options: BuildPrintManifestOptions = {},
): PrintManifestResult {
  if (options.pinned) {
    const conflict = detectConflict(deck, options.pinned);
    if (conflict) return { kind: "conflict", conflict };
  }

  const builder = new ManifestBuilder(lookup);
  const commanders = new Set(deck.commanders);
  const cards: PrintCard[] = [];

  for (const oracle_id of deck.commanders) {
    cards.push(builder.place(oracle_id, "commander", false));
  }
  for (const entry of deck.cards) {
    for (let copy = 0; copy < entry.qty; copy += 1) {
      const card = builder.place(entry.oracle_id, "library", entry.illegal === true);
      if (commanders.has(entry.oracle_id)) {
        builder.attention.add(
          "commander_in_library",
          entry.oracle_id,
          card.slot,
          `${card.name} is a commander and also a library entry; both copies are printed as saved.`,
        );
      }
      cards.push(card);
    }
  }

  const companion =
    deck.companion === undefined ? null : builder.place(deck.companion, "companion", false);
  const tokens = builder.tokenExtras(options.selected_tokens ?? []);
  const total = deck.commanders.length + deck.cards.reduce((sum, entry) => sum + entry.qty, 0);

  return {
    kind: "manifest",
    manifest: {
      deck_id: deck.deck_id,
      deck_name: deck.name,
      version: deck.version,
      data_snapshot: deck.data_snapshot,
      cards,
      extras: { companion, tokens },
      total,
      attention: builder.attention.toArray(),
    },
  };
}
