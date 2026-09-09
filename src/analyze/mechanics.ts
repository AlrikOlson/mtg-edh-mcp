/**
 * Mechanics evidence extractor (Commander workshop: strategy and synergy).
 *
 * Reads a card's canonical face Oracle text and emits bounded annotations for a
 * DECLARED catalog of patterns — recurring triggers, costs, effects and standing
 * permissions across sacrifice, tokens, counters, draw/discard, graveyard,
 * spellcasting, combat, lifegain and landfall. Every annotation carries the
 * exact source span that supports it, the ability it belongs to, whose
 * resources it concerns and whether it is conditional.
 *
 * Text outside the catalog is reported as `unmodeled`; text the extractor sees
 * but refuses to classify (granted ability text, unrecognized trigger events or
 * cost elements) is `uncertain`. Nothing here is a rules interpreter: the
 * extractor never asserts legality, playability, or that an ability resolves.
 *
 * ADVISORY ONLY: like classifyRoles, this never feeds src/validate.
 */
import { oracleTextEvidence } from "../index/map.js";
import {
  MECHANICS_EXTRACTOR_VERSION,
  type AbilityKind,
  type Card,
  type CardCharacteristics,
  type CardMechanics,
  type EffectKind,
  type MechanicAmount,
  type MechanicAnnotation,
  type MechanicCategory,
  type MechanicCondition,
  type MechanicKind,
  type MechanicPattern,
  type MechanicSubject,
  type MechanicZone,
  type MechanicsCoverage,
  type OracleTextEvidence,
  type TriggerKind,
  type UnmodeledSpan,
} from "../types/index.js";

function pattern(category: MechanicCategory, kind: MechanicKind, description: string) {
  return { id: `${category}.${kind}`, category, kind, description } satisfies MechanicPattern;
}

/** The only claims the extractor may make; consumers can enumerate and display them. */
export const SUPPORTED_MECHANIC_PATTERNS: readonly MechanicPattern[] = [
  pattern("trigger", "enters_battlefield", "A permanent enters the battlefield."),
  pattern("trigger", "dies", "A creature dies (battlefield to graveyard)."),
  pattern("trigger", "leaves_battlefield", "A permanent leaves the battlefield."),
  pattern("trigger", "landfall", "A land enters under a player's control."),
  pattern("trigger", "cast_spell", "A player casts a spell (qualifier holds the spell filter)."),
  pattern("trigger", "sacrifice", "A player sacrifices a permanent."),
  pattern("trigger", "attacks", "A creature attacks."),
  pattern("trigger", "blocks", "A creature blocks or becomes blocked."),
  pattern("trigger", "combat_damage_player", "A creature deals combat damage to a player."),
  pattern("trigger", "deals_damage", "A source deals damage."),
  pattern("trigger", "lifegain", "A player gains life."),
  pattern("trigger", "lose_life", "A player loses life."),
  pattern("trigger", "draw", "A player draws a card."),
  pattern("trigger", "discard", "A player discards a card."),
  pattern("trigger", "token_created", "A token is created or enters."),
  pattern("trigger", "counters_placed", "Counters are put on a permanent."),
  pattern("trigger", "upkeep", "Beginning of an upkeep step."),
  pattern("trigger", "draw_step", "Beginning of a draw step."),
  pattern("trigger", "beginning_of_combat", "Beginning of combat."),
  pattern("trigger", "end_step", "Beginning of an end step."),
  pattern("trigger", "card_to_graveyard", "A card is put into a graveyard from anywhere."),
  pattern("trigger", "leaves_graveyard", "A card leaves a graveyard."),
  pattern("trigger", "becomes_tapped", "A permanent becomes tapped."),
  pattern("trigger", "becomes_targeted", "A permanent becomes the target of a spell or ability."),
  pattern("cost", "tap", "{T} activation cost."),
  pattern("cost", "untap", "{Q} activation cost."),
  pattern("cost", "mana", "Mana symbols in an activation cost."),
  pattern("cost", "sacrifice_self", "Sacrifice this permanent as a cost."),
  pattern("cost", "sacrifice_permanent", "Sacrifice another permanent as a cost."),
  pattern("cost", "discard_cards", "Discard cards as a cost."),
  pattern("cost", "pay_life", "Pay life as a cost."),
  pattern("cost", "remove_counters", "Remove counters as a cost."),
  pattern("cost", "exile_from_graveyard", "Exile cards from your graveyard as a cost."),
  pattern("cost", "return_to_hand", "Return a permanent to hand as a cost."),
  pattern("cost", "tap_permanent", "Tap untapped permanents you control as a cost."),
  pattern("effect", "create_token", "Create tokens (qualifier holds the token description)."),
  pattern(
    "effect",
    "put_counters",
    "Put counters on an object (qualifier holds the counter type).",
  ),
  pattern("effect", "enters_with_counters", "This permanent enters with counters."),
  pattern("effect", "proliferate", "Proliferate."),
  pattern("effect", "draw_cards", "A player draws cards."),
  pattern("effect", "discard_cards", "A player discards cards."),
  pattern("effect", "sacrifice_self", "This permanent is sacrificed by an effect."),
  pattern("effect", "sacrifice_permanent", "A player sacrifices permanents by an effect."),
  pattern("effect", "gain_life", "A player gains life."),
  pattern("effect", "lose_life", "A player loses life."),
  pattern("effect", "mill", "A player mills cards."),
  pattern("effect", "scry", "Scry N."),
  pattern("effect", "surveil", "Surveil N."),
  pattern(
    "effect",
    "return_from_graveyard",
    "Return or put cards from a graveyard to another zone.",
  ),
  pattern("effect", "exile_from_graveyard", "Exile cards from a graveyard."),
  pattern("effect", "deal_damage", "A source deals damage (subject is the affected party)."),
  pattern("effect", "destroy", "Destroy permanents."),
  pattern("effect", "exile", "Exile objects from the battlefield or library."),
  pattern("effect", "search_library", "Search a library."),
  pattern("effect", "add_mana", "Add mana."),
  pattern("effect", "counter_spell", "Counter a spell or ability."),
  pattern("permission", "cast_from_graveyard", "May cast or play cards from your graveyard."),
];

const PATTERN_IDS = new Set(SUPPORTED_MECHANIC_PATTERNS.map((p) => p.id));

interface Span {
  start: number;
  end: number;
}

interface FaceSource {
  faceIndex: number | null;
  name: string;
  typeLine: string;
  /** Original Oracle text; evidence offsets address it. */
  text: string;
  evidence: (start: number, end: number) => OracleTextEvidence;
}

interface AbilityContext {
  face: FaceSource;
  abilityIndex: number;
  abilityKind: AbilityKind;
  selfRef: RegExp;
  /** A condition inherited by every annotation of the ability (intervening-if, timing restriction, modal choice). */
  inherited: MechanicCondition;
  annotations: MechanicAnnotation[];
  unmodeled: UnmodeledSpan[];
}

interface Sink {
  annotations: MechanicAnnotation[];
  unmodeled: UnmodeledSpan[];
  coverage: MechanicsCoverage;
}

interface ModalContext {
  context: MechanicCondition;
  abilityKind: AbilityKind;
}

const UNCONDITIONAL: MechanicCondition = { kind: "unconditional", text: null };

const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

function parseAmount(word: string | undefined | null): MechanicAmount {
  if (!word) return null;
  const w = word.trim().toLowerCase();
  if (w === "") return null;
  if (w === "x") return "X";
  if (/^\d+$/.test(w)) return Number(w);
  if (Object.hasOwn(NUMBER_WORDS, w)) return NUMBER_WORDS[w] ?? null;
  if (
    /^(?:that many|that much|twice|half|equal|a number of|any number of|all|each|up to|the rest|their hands?|your hand|cards)/.test(
      w,
    )
  )
    return "variable";
  return null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Matches this card's own name (full and short legendary name) and Oracle self-references. */
function selfReference(name: string): RegExp {
  const names = new Set<string>();
  const trimmed = name.trim();
  if (trimmed) names.add(trimmed);
  const short = trimmed.split(",")[0]?.trim();
  if (short) names.add(short);
  const alternatives = [...names].map(escapeRegExp);
  alternatives.push(
    "this (?:creature|permanent|artifact|enchantment|land|planeswalker|vehicle|spell|token|card|equipment|aura|saga|battle)",
  );
  return new RegExp(`^(?:${alternatives.join("|")})\\b`, "i");
}

/** Replace reminder text with spaces so offsets stay stable. */
function maskParentheses(text: string): string {
  let masked = text;
  let previous: string;
  do {
    previous = masked;
    masked = masked.replace(/\([^()]*\)/g, (m) => " ".repeat(m.length));
  } while (masked !== previous);
  return masked;
}

function trimSpan(text: string, start: number, end: number): Span | null {
  let s = start;
  let e = end;
  while (s < e && /\s/.test(text[s] ?? "")) s += 1;
  while (e > s && /\s/.test(text[e - 1] ?? "")) e -= 1;
  return s < e ? { start: s, end: e } : null;
}

/** Sentences of a body: split after a period that is followed by whitespace or the end. */
function sentences(text: string, span: Span): Span[] {
  const out: Span[] = [];
  let cursor = span.start;
  const body = text.slice(span.start, span.end);
  const re = /\.(?=\s+\S|\s*$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const end = span.start + m.index + 1;
    const t = trimSpan(text, cursor, end);
    if (t) out.push(t);
    cursor = end;
  }
  const tail = trimSpan(text, cursor, span.end);
  if (tail) out.push(tail);
  return out;
}

const SUBJECT_LEADS: ReadonlyArray<[RegExp, MechanicSubject]> = [
  [/^(?:each|every) other player\b/i, "opponent"],
  [/^(?:each|every|an|that|target|the) opponent\b/i, "opponent"],
  [/^each of your opponents\b/i, "opponent"],
  [/^(?:each|every) player\b/i, "each_player"],
  [/^target player\b/i, "target_player"],
  [/^you\b/i, "controller"],
  [/^(?:that|the) player\b/i, "unknown"],
  [/^its (?:owner|controller)\b/i, "unknown"],
  [/^(?:that|the) (?:creature|permanent|card)'s (?:owner|controller)\b/i, "unknown"],
  [/^defending player\b/i, "opponent"],
  [/^a player\b/i, "any_player"],
];

function leadSubject(clause: string): MechanicSubject | null {
  for (const [re, subject] of SUBJECT_LEADS) if (re.test(clause)) return subject;
  return null;
}

/** Whose permanents a phrase like "creature you control" or "an opponent controls" concerns. */
function controlSubject(phrase: string, fallback: MechanicSubject): MechanicSubject {
  const p = phrase.toLowerCase();
  if (/\byou (?:control|own)\b|\bunder your control\b|\byour (?!opponents?\b)/.test(p))
    return "controller";
  if (
    /\b(?:an|each|target|that) opponent(?:'s)? (?:control|controls|own|owns)\b|\bunder an opponent's control\b|\byou don't control\b|\byour opponents control\b|\bopponents? controls?\b/.test(
      p,
    )
  )
    return "opponent";
  if (/\beach player(?:'s)?\b|\ball players\b/.test(p)) return "each_player";
  if (/\btarget player(?:'s)?\b/.test(p)) return "target_player";
  return fallback;
}

const CONDITION_RE =
  /\b(?:if|unless|as long as|only if|only once each turn|only during|only any time|only as a sorcery|only before|only while|only when|only from|activate only|this ability triggers only)\b/i;

function conditionOf(text: string, span: Span): MechanicCondition {
  const s = text.slice(span.start, span.end);
  const m = CONDITION_RE.exec(s);
  if (!m) return UNCONDITIONAL;
  const rest = s.slice(m.index);
  const stop = rest.search(/[,.;]/);
  const clause = (stop === -1 ? rest : rest.slice(0, stop)).trim();
  return { kind: "conditional", text: clause };
}

function mergeCondition(a: MechanicCondition, b: MechanicCondition): MechanicCondition {
  if (a.kind === "unconditional") return b;
  if (b.kind === "unconditional") return a;
  if (a.text === b.text) return a;
  return { kind: "conditional", text: `${a.text}; ${b.text}` };
}

interface EmitFields {
  subject: MechanicSubject;
  qualifier?: string | null;
  amount?: MechanicAmount;
  zones?: { from: MechanicZone | null; to: MechanicZone | null };
  condition: MechanicCondition;
  optional?: boolean;
  provenance?: "explicit" | "inferred";
}

function emit(
  ctx: AbilityContext,
  category: MechanicCategory,
  kind: MechanicKind,
  span: Span,
  fields: EmitFields,
): void {
  const pattern_id = `${category}.${kind}`;
  if (!PATTERN_IDS.has(pattern_id)) return;
  ctx.annotations.push({
    status: "supported",
    pattern_id,
    category,
    kind,
    ability_index: ctx.abilityIndex,
    ability_kind: ctx.abilityKind,
    face_index: ctx.face.faceIndex,
    subject: fields.subject,
    qualifier: fields.qualifier ?? null,
    amount: fields.amount ?? null,
    zones: fields.zones ?? { from: null, to: null },
    condition: mergeCondition(ctx.inherited, fields.condition),
    optional: fields.optional ?? false,
    provenance: fields.provenance ?? "inferred",
    evidence: ctx.face.evidence(span.start, span.end),
    extractor_version: MECHANICS_EXTRACTOR_VERSION,
  });
}

function flag(
  ctx: AbilityContext,
  status: "unmodeled" | "uncertain",
  span: Span,
  reason: string,
): void {
  ctx.unmodeled.push({
    status,
    ability_index: ctx.abilityIndex,
    ability_kind: ctx.abilityKind,
    face_index: ctx.face.faceIndex,
    reason,
    evidence: ctx.face.evidence(span.start, span.end),
  });
}

// ---------------------------------------------------------------------------
// Triggers

interface TriggerRead {
  kind: TriggerKind;
  subject: MechanicSubject;
  qualifier: string | null;
  zones?: { from: MechanicZone | null; to: MechanicZone | null };
}

const OBJECT_FILTER =
  /^(?:a|an|another|one or more|each) (nontoken |token |legendary |artifact |non-\w+ )?(creature|permanent|artifact|enchantment|planeswalker|land)/;

function readTrigger(clause: string, selfRef: RegExp, atLead: boolean): TriggerRead | null {
  const c = clause.trim();
  const l = c.toLowerCase();
  const isSelf = selfRef.test(c);
  const owned = (fallback: MechanicSubject): MechanicSubject =>
    isSelf ? "self" : controlSubject(l, fallback);
  const actor = (): MechanicSubject => {
    if (/^you\b/.test(l)) return "controller";
    if (/^(?:an|each|target|one or more|another) opponents?\b/.test(l)) return "opponent";
    if (/^(?:a|any|each|one or more) players?\b/.test(l)) return "any_player";
    return controlSubject(l, "any_player");
  };

  if (atLead) {
    const who: MechanicSubject = /\byour\b/.test(l)
      ? "controller"
      : /\bopponent/.test(l)
        ? "opponent"
        : /\beach player|\beach upkeep|\beach end step|\beach combat|\beach draw step/.test(l)
          ? "each_player"
          : "unknown";
    if (/\bupkeep\b/.test(l)) return { kind: "upkeep", subject: who, qualifier: null };
    if (/\bdraw step\b/.test(l)) return { kind: "draw_step", subject: who, qualifier: null };
    if (/\bend step\b/.test(l)) return { kind: "end_step", subject: who, qualifier: null };
    if (/\bcombat\b/.test(l)) return { kind: "beginning_of_combat", subject: who, qualifier: null };
    return null;
  }
  let m: RegExpExecArray | null;
  if (
    /\b(?:a|another|one or more) lands? (?:you control |an opponent controls )?enters?\b|\blands? enters? (?:the battlefield )?under (?:your|an opponent's) control|^you play a land\b|\bland enters\b/.test(
      l,
    )
  ) {
    const subject: MechanicSubject = /\byou play\b|\byou control\b|\bunder your control\b/.test(l)
      ? "controller"
      : /\bopponent/.test(l)
        ? "opponent"
        : "any_player";
    return { kind: "landfall", subject, qualifier: null, zones: { from: null, to: "battlefield" } };
  }
  // "enters or dies": the first-named event classifies the trigger.
  const entersAt = l.search(/\benters?\b/);
  const diesAt = l.search(/\bdies\b/);
  const entersFirst = entersAt !== -1 && (diesAt === -1 || entersAt < diesAt);
  if (
    !entersFirst &&
    /\bdies\b|\b(?:creatures|tokens|permanents|they|both|all) die\b|(?:is|are) put into (?:a|your|an opponent's) graveyard from the battlefield/.test(
      l,
    )
  ) {
    const q = OBJECT_FILTER.exec(l);
    return {
      kind: "dies",
      subject: owned("any_player"),
      qualifier: q ? `${q[1] ?? ""}${q[2]}`.trim() : null,
      zones: { from: "battlefield", to: "graveyard" },
    };
  }
  if (/\benters?(?: the battlefield)?\b/.test(l) && !/\bdeals? damage\b/.test(l)) {
    const q = OBJECT_FILTER.exec(l);
    return {
      kind: "enters_battlefield",
      subject: owned("any_player"),
      qualifier: q ? `${q[1] ?? ""}${q[2]}`.trim() : null,
      zones: { from: null, to: "battlefield" },
    };
  }
  if (/\bleaves? the battlefield\b/.test(l)) {
    return {
      kind: "leaves_battlefield",
      subject: owned("any_player"),
      qualifier: null,
      zones: { from: "battlefield", to: null },
    };
  }
  if (
    (m =
      /\bcasts? (?:a|an|your first|your second|one or more|another)?\s*([a-z][a-z ,/'-]*?)?\s*spells?\b/.exec(
        l,
      )) !== null
  ) {
    const filter = (m[1] ?? "").trim();
    return {
      kind: "cast_spell",
      subject: actor(),
      qualifier: filter === "" ? null : filter,
      zones: { from: null, to: "stack" },
    };
  }
  if (
    (m = /\bsacrifices? (?:a|an|another|one or more)?\s*([a-z][a-z ]*?)(?:,|$)/.exec(l)) !== null
  ) {
    return { kind: "sacrifice", subject: actor(), qualifier: (m[1] ?? "").trim() || null };
  }
  if (
    /\bdeals? combat damage to (?:a player|an opponent|you|a player or planeswalker|a player or battle|one of your opponents|a planeswalker|one or more players|a player or a planeswalker)/.test(
      l,
    )
  ) {
    const t = /\bcombat damage to ([a-z ]+?)(?:,|$)/.exec(l);
    return {
      kind: "combat_damage_player",
      subject: owned("any_player"),
      qualifier: t ? (t[1] ?? "").trim() : null,
    };
  }
  if (/\bdeals? damage\b|\bis dealt damage\b|\bdeals? noncombat damage\b/.test(l)) {
    return { kind: "deals_damage", subject: owned("any_player"), qualifier: null };
  }
  if (/\battacks?\b/.test(l)) {
    const subject: MechanicSubject = /\battacks? you\b/.test(l) ? "opponent" : owned("any_player");
    return { kind: "attacks", subject, qualifier: null };
  }
  if (/\bblocks?\b|\bbecomes? blocked\b/.test(l)) {
    return { kind: "blocks", subject: owned("any_player"), qualifier: null };
  }
  if (/\bgains? (?:\d+ or more |x or more )?life\b/.test(l)) {
    return { kind: "lifegain", subject: actor(), qualifier: null };
  }
  if (/\bloses? (?:\d+ or more |x or more )?life\b/.test(l)) {
    return { kind: "lose_life", subject: actor(), qualifier: null };
  }
  if (
    /\bdraws? (?:(?:a|an|your first|your second|one or more|two or more) )?(?:[a-z-]+ )*cards?\b/.test(
      l,
    )
  ) {
    return {
      kind: "draw",
      subject: actor(),
      qualifier: null,
      zones: { from: "library", to: "hand" },
    };
  }
  if ((m = /\bdiscards? (?:(?:a|an|one or more) )?((?:[a-z,-]+ )*)cards?\b/.exec(l)) !== null) {
    const filter = (m[1] ?? "").trim();
    return {
      kind: "discard",
      subject: actor(),
      qualifier: filter === "" ? null : filter,
      zones: { from: "hand", to: "graveyard" },
    };
  }
  if (
    /\btokens? (?:enters?|you create|is created|are created|enter)\b|\bcreates? (?:a|an|one or more) (?:[a-z/ ]+ )?tokens?\b|\bone or more tokens\b/.test(
      l,
    )
  ) {
    return {
      kind: "token_created",
      subject: /\byou create\b|\bunder your control\b|\byou control\b/.test(l)
        ? "controller"
        : actor(),
      qualifier: null,
    };
  }
  if (
    /\bcounters? (?:is|are) put on\b|\bput (?:a|an|one or more|\d+) [+a-z0-9/ -]*counters? on\b/.test(
      l,
    )
  ) {
    return { kind: "counters_placed", subject: controlSubject(l, "any_player"), qualifier: null };
  }
  if (
    /\b(?:is|are) put into (?:your|a|an opponent's|each player's) graveyard from anywhere\b|\bcards? (?:is|are) put into (?:your|a) graveyard\b/.test(
      l,
    )
  ) {
    return {
      kind: "card_to_graveyard",
      subject: controlSubject(l, "any_player"),
      qualifier: null,
      zones: { from: null, to: "graveyard" },
    };
  }
  if (/\bleaves? (?:your|a) graveyard\b/.test(l)) {
    return {
      kind: "leaves_graveyard",
      subject: controlSubject(l, "any_player"),
      qualifier: null,
      zones: { from: "graveyard", to: null },
    };
  }
  if (/\bbecomes? tapped\b/.test(l)) {
    return { kind: "becomes_tapped", subject: owned("any_player"), qualifier: null };
  }
  if (/\bbecomes? the target of\b/.test(l)) {
    return { kind: "becomes_targeted", subject: owned("any_player"), qualifier: null };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Costs

function readCost(ctx: AbilityContext, span: Span, masked: string): void {
  const raw = masked.slice(span.start, span.end).trim();
  const l = raw.toLowerCase();
  let m: RegExpExecArray | null;
  if (l === "{t}")
    return emit(ctx, "cost", "tap", span, { subject: "self", condition: UNCONDITIONAL });
  if (l === "{q}")
    return emit(ctx, "cost", "untap", span, { subject: "self", condition: UNCONDITIONAL });
  if (/^(?:\{[0-9wubrgcxsp/]+\})+$/.test(l)) {
    return emit(ctx, "cost", "mana", span, {
      subject: "controller",
      qualifier: raw,
      condition: UNCONDITIONAL,
    });
  }
  if ((m = /^sacrifice (.+)$/i.exec(raw)) !== null) {
    const object = (m[1] ?? "").trim();
    if (ctx.selfRef.test(object)) {
      return emit(ctx, "cost", "sacrifice_self", span, {
        subject: "self",
        zones: { from: "battlefield", to: "graveyard" },
        condition: UNCONDITIONAL,
      });
    }
    const det = /^(a|an|another|two|three|x|\d+|one) /i.exec(object);
    return emit(ctx, "cost", "sacrifice_permanent", span, {
      subject: "controller",
      qualifier: object.replace(/^(a|an|another|two|three|x|\d+|one) /i, ""),
      amount: parseAmount(det?.[1]) ?? (/^another/i.test(object) ? 1 : null),
      zones: { from: "battlefield", to: "graveyard" },
      condition: UNCONDITIONAL,
    });
  }
  if ((m = /^discard (.+)$/i.exec(raw)) !== null) {
    const object = (m[1] ?? "").trim();
    const det = /^(a|an|two|three|x|\d+|one|your hand) /i.exec(`${object} `);
    return emit(ctx, "cost", "discard_cards", span, {
      subject: "controller",
      qualifier: object,
      amount: parseAmount(det?.[1]),
      zones: { from: "hand", to: "graveyard" },
      condition: UNCONDITIONAL,
    });
  }
  if ((m = /^pay (\d+|x|half your life|any amount of) life$/i.exec(raw)) !== null) {
    return emit(ctx, "cost", "pay_life", span, {
      subject: "controller",
      amount: parseAmount(m[1]) ?? "variable",
      condition: UNCONDITIONAL,
    });
  }
  if (
    (m =
      /^remove (a|an|one|two|three|x|\d+|all|any number of) ([+-]\d+\/[+-]\d+|[a-z]+(?: [a-z]+)?)? ?counters? from (.+)$/i.exec(
        raw,
      )) !== null
  ) {
    const from = m[3] ?? "";
    return emit(ctx, "cost", "remove_counters", span, {
      subject: ctx.selfRef.test(from) ? "self" : controlSubject(from, "controller"),
      qualifier: m[2] ?? null,
      amount: parseAmount(m[1]),
      condition: UNCONDITIONAL,
    });
  }
  if ((m = /^exile (.+?) from your graveyard$/i.exec(raw)) !== null) {
    const object = (m[1] ?? "").trim();
    const det = /^(a|an|two|three|x|\d+|one) /i.exec(object);
    return emit(ctx, "cost", "exile_from_graveyard", span, {
      subject: "controller",
      qualifier: object,
      amount: parseAmount(det?.[1]),
      zones: { from: "graveyard", to: "exile" },
      condition: UNCONDITIONAL,
    });
  }
  if ((m = /^return (.+?) to (?:its|their) owner'?s'? hands?$/i.exec(raw)) !== null) {
    const object = (m[1] ?? "").trim();
    return emit(ctx, "cost", "return_to_hand", span, {
      subject: ctx.selfRef.test(object) ? "self" : "controller",
      qualifier: object,
      zones: { from: "battlefield", to: "hand" },
      condition: UNCONDITIONAL,
    });
  }
  if (
    (m =
      /^tap (an untapped|two untapped|three untapped|x untapped|\d+ untapped|another untapped) (.+)$/i.exec(
        raw,
      )) !== null
  ) {
    const det = (m[1] ?? "").split(" ")[0];
    return emit(ctx, "cost", "tap_permanent", span, {
      subject: "controller",
      qualifier: (m[2] ?? "").trim(),
      amount: parseAmount(det) ?? (det === "another" ? 1 : null),
      condition: UNCONDITIONAL,
    });
  }
  flag(ctx, "uncertain", span, "unrecognized cost element");
}

// ---------------------------------------------------------------------------
// Effects

const DAMAGE_RE = new RegExp(
  "\\bdeals? (?:(\\d+|x|that much|twice that much|double that much) )?damage( equal to .+?)? to (" +
    [
      "each opponent",
      "each player",
      "any target",
      "target creature or planeswalker",
      "target creature or player",
      "target creature or battle",
      "target creature",
      "target player or planeswalker",
      "target player",
      "target opponent or planeswalker",
      "target opponent",
      "target attacking or blocking creature",
      "target attacking creature",
      "target blocking creature",
      "each creature and each player",
      "each creature and each planeswalker",
      "each creature your opponents control",
      "each creature you don't control",
      "each creature you control",
      "each other creature",
      "each creature",
      "each opponent and each creature they control",
      "each opponent and each planeswalker they control",
      "you",
      "that player",
      "that creature",
      "its controller",
      "that creature's controller",
      "defending player",
      "any number of targets",
      "up to [a-z]+ targets?",
      "that player or planeswalker",
      "each of up to [a-z]+ targets?",
      "that source's controller",
      "the controller of that spell",
    ].join("|") +
    ")\\b",
  "i",
);

function damageSubject(target: string): MechanicSubject {
  const t = target.toLowerCase();
  if (
    /^each opponent|^target opponent|opponents control|you don't control|^defending player/.test(t)
  )
    return "opponent";
  if (/^each player/.test(t)) return "each_player";
  if (/^target player/.test(t)) return "target_player";
  if (/^you$/.test(t)) return "controller";
  if (/you control/.test(t)) return "controller";
  if (/^that player|^its controller|controller$|^that creature$/.test(t)) return "unknown";
  return "any_player";
}

function stripDeterminer(phrase: string): { amount: MechanicAmount; rest: string } {
  const m =
    /^(a|an|one|two|three|four|five|six|seven|x|\d+|another|all|each|that|those|up to (?:one|two|three|four|five|x|\d+)|any number of|target|another target)\s+/i.exec(
      phrase,
    );
  if (!m) return { amount: null, rest: phrase };
  const det = (m[1] ?? "").toLowerCase();
  let amount: MechanicAmount = parseAmount(det);
  if (det === "another" || det === "target" || det === "another target" || det === "that")
    amount = 1;
  if (det === "those" || det === "all" || det === "each" || det === "any number of")
    amount = "variable";
  if (det.startsWith("up to ")) amount = "variable";
  return { amount, rest: phrase.slice(m[0].length) };
}

function ownerSubject(owner: string, fallback: MechanicSubject): MechanicSubject {
  switch (owner) {
    case "your":
      return "controller";
    case "an opponent's":
    case "each opponent's":
      return "opponent";
    case "target player's":
      return "target_player";
    case "each player's":
    case "all":
      return "each_player";
    case "that player's":
      return "unknown";
    default:
      return fallback;
  }
}

/** Annotate one clause; returns how many supported annotations it produced. */
function readEffects(
  ctx: AbilityContext,
  sentence: Span,
  clause: Span,
  masked: string,
  inheritedLead: MechanicSubject | null = null,
): number {
  const raw = masked.slice(clause.start, clause.end).trim();
  if (raw === "") return 0;
  const sentenceText = masked.slice(sentence.start, sentence.end);
  const condition = conditionOf(masked, sentence);
  const optional = /\bmay\b/i.test(sentenceText);
  const lead = leadSubject(raw) ?? inheritedLead;
  const acting = lead ?? "controller";
  const isSelfLead = ctx.selfRef.test(raw);
  let count = 0;
  const add = (
    kind: EffectKind | "cast_from_graveyard",
    fields: Omit<EmitFields, "condition" | "optional">,
    category: MechanicCategory = "effect",
  ) => {
    emit(ctx, category, kind, clause, { ...fields, condition, optional });
    count += 1;
  };
  let m: RegExpExecArray | null;

  if (
    (m =
      /\bcreates? (a|an|one|two|three|four|five|six|seven|x|that many|twice that many|a number of|\d+) (?:tapped |tapped and attacking |legendary )?(.+?) ?tokens?\b/i.exec(
        raw,
      )) !== null
  ) {
    add("create_token", {
      subject: acting,
      qualifier: (m[2] ?? "").trim() || null,
      amount: parseAmount(m[1]),
      zones: { from: null, to: "battlefield" },
    });
  } else if (/\binvestigate\b/i.test(raw)) {
    add("create_token", {
      subject: acting,
      qualifier: "Clue",
      amount: 1,
      zones: { from: null, to: "battlefield" },
    });
  }
  if (
    (m =
      /\bputs? (a|an|one|two|three|four|five|x|that many|twice that many|\d+|another) ([+-]\d+\/[+-]\d+|[a-z]+(?: [a-z]+)?) counters? on (.+?)(?=[,.]|$| for each| unless| if )/i.exec(
        raw,
      )) !== null
  ) {
    const target = (m[3] ?? "").trim();
    const onSelf = ctx.selfRef.test(target) || (/^it$/i.test(target) && isSelfLead);
    add("put_counters", {
      subject: onSelf ? "self" : controlSubject(target, "any_player"),
      qualifier: m[2] ?? null,
      amount: parseAmount(m[1]) ?? (m[1]?.toLowerCase() === "another" ? 1 : null),
      zones: { from: null, to: "battlefield" },
    });
  }
  if (
    (m =
      /\benters(?: the battlefield)? with (a|an|one|two|three|four|five|x|\d+|that many|twice that many) (?:additional )?([+-]\d+\/[+-]\d+|[a-z]+) counters? on it\b/i.exec(
        raw,
      )) !== null
  ) {
    add("enters_with_counters", {
      subject: "self",
      qualifier: m[2] ?? null,
      amount: parseAmount(m[1]),
      zones: { from: null, to: "battlefield" },
    });
  }
  if (/\bproliferate\b/i.test(raw)) add("proliferate", { subject: "controller" });
  if (
    (m =
      /\bdraws? (a card for each|two cards for each|cards equal to|a card|one card|two cards|three cards|four cards|five cards|six cards|seven cards|x cards|that many cards|half that many cards|\d+ cards)\b/i.exec(
        raw,
      )) !== null
  ) {
    const phrase = (m[1] ?? "").toLowerCase();
    add("draw_cards", {
      subject: acting,
      amount: /for each|equal to/.test(phrase)
        ? "variable"
        : (parseAmount(phrase.split(" ")[0]) ?? "variable"),
      zones: { from: "library", to: "hand" },
    });
  }
  if (
    (m =
      /\bdiscards? (a card at random|two cards at random|a card|one card|two cards|three cards|four cards|x cards|that many cards|your hand|their hands?|all the cards in (?:your|their) hands?|the rest|\d+ cards|cards)\b/i.exec(
        raw,
      )) !== null
  ) {
    const phrase = (m[1] ?? "").toLowerCase();
    add("discard_cards", {
      subject: acting,
      qualifier: phrase,
      amount: parseAmount(phrase.split(" ")[0]) ?? "variable",
      zones: { from: "hand", to: "graveyard" },
    });
  }
  if (
    (m =
      /\bsacrifices? (.+?)(?=,|\.|$| unless | if | at the | for each | with | that (?:isn't|aren't|is |are )| they | you control| an opponent| of (?:their|your|its|his|her) choice)/i.exec(
        raw,
      )) !== null
  ) {
    const object = (m[1] ?? "").trim();
    if (ctx.selfRef.test(object) || (/^it$/i.test(object) && isSelfLead)) {
      add("sacrifice_self", { subject: "self", zones: { from: "battlefield", to: "graveyard" } });
    } else {
      const { amount, rest } = stripDeterminer(object);
      add("sacrifice_permanent", {
        subject: acting,
        qualifier: rest || null,
        amount,
        zones: { from: "battlefield", to: "graveyard" },
      });
    }
  }
  if (
    (m =
      /\bgains? (?:(\d+|x|that much|twice that much|half that much|one|two|three|four|five) life|life equal to|life for each|an amount of life)/i.exec(
        raw,
      )) !== null
  ) {
    add("gain_life", { subject: acting, amount: parseAmount(m[1]) ?? "variable" });
  }
  if (
    (m =
      /\bloses? (?:(\d+|x|that much|twice that much|half|one|two|three|four|five) life|life equal to|life for each|an amount of life)/i.exec(
        raw,
      )) !== null
  ) {
    add("lose_life", { subject: acting, amount: parseAmount(m[1]) ?? "variable" });
  }
  if (
    (m =
      /\bmills? (a card|one card|two cards|three cards|four cards|five cards|six cards|seven cards|eight cards|ten cards|x cards|that many cards|half|\d+ cards|cards)\b/i.exec(
        raw,
      )) !== null
  ) {
    add("mill", {
      subject: acting,
      amount: parseAmount((m[1] ?? "").split(" ")[0]) ?? "variable",
      zones: { from: "library", to: "graveyard" },
    });
  }
  if ((m = /\bscry (\d+|x)\b/i.exec(raw)) !== null) {
    add("scry", {
      subject: "controller",
      amount: parseAmount(m[1]),
      zones: { from: "library", to: "library" },
    });
  }
  if ((m = /\bsurveil (\d+|x)\b/i.exec(raw)) !== null) {
    add("surveil", {
      subject: "controller",
      amount: parseAmount(m[1]),
      zones: { from: "library", to: "graveyard" },
    });
  }
  if (
    (m =
      /\b(?:returns?|puts?) (.+?) from (your|a|their|an opponent's|target player's|each player's|that player's|any) graveyards? (?:to|onto|into|on) (the battlefield|your hand|its owner's hand|their owner's hand|their owners' hands|the top of your library|the top of its owner's library|the bottom of your library|your library)/i.exec(
        raw,
      )) !== null
  ) {
    const owner = (m[2] ?? "").toLowerCase();
    const dest = (m[3] ?? "").toLowerCase();
    const { amount, rest } = stripDeterminer((m[1] ?? "").trim());
    add("return_from_graveyard", {
      subject: ownerSubject(owner, "any_player"),
      qualifier: rest || null,
      amount,
      zones: {
        from: "graveyard",
        to: dest.includes("battlefield")
          ? "battlefield"
          : dest.includes("hand")
            ? "hand"
            : "library",
      },
    });
  }
  const exileFrom =
    /\bexiles? (.+?) from (your|a|their|an opponent's|target player's|each player's|each opponent's|that player's|all|any) graveyards?\b/i.exec(
      raw,
    );
  const exileWhole =
    exileFrom === null
      ? /\bexiles? (target player's|each opponent's|each player's|all|that player's) graveyards?\b/i.exec(
          raw,
        )
      : null;
  if (exileFrom !== null || exileWhole !== null) {
    const owner = (exileFrom ? exileFrom[2] : exileWhole?.[1])?.toLowerCase() ?? "";
    const objectPhrase = exileFrom ? (exileFrom[1] ?? "").trim() : "all cards";
    const { amount, rest } = stripDeterminer(objectPhrase);
    add("exile_from_graveyard", {
      subject: ownerSubject(owner, "any_player"),
      qualifier: rest || null,
      amount,
      zones: { from: "graveyard", to: "exile" },
    });
  }
  if ((m = DAMAGE_RE.exec(raw)) !== null) {
    add("deal_damage", {
      subject: damageSubject(m[3] ?? ""),
      qualifier: (m[3] ?? "").toLowerCase(),
      amount: parseAmount(m[1]) ?? (m[2] ? "variable" : null),
    });
  }
  if (
    (m =
      /\bdestroy (target .+?|all .+?|each .+?|another target .+?|up to .+?|any number of .+?|that .+?|those .+?)(?=\.|,| unless| if | at the| and | that (?:isn't|aren't)|$)/i.exec(
        raw,
      )) !== null
  ) {
    const { amount, rest } = stripDeterminer((m[1] ?? "").trim());
    add("destroy", {
      subject: controlSubject(m[1] ?? "", "any_player"),
      qualifier: rest || null,
      amount,
      zones: { from: "battlefield", to: "graveyard" },
    });
  }
  if (
    (m =
      /\bexile (target .+?|all .+?|each .+?|another target .+?|up to .+?|any number of .+?|the top (?:card|two cards|three cards|x cards|\d+ cards) of (?:your|their|target player's|each player's) library)(?=\.|,| unless| if | at the| until | and | that (?:isn't|aren't)|$)/i.exec(
        raw,
      )) !== null &&
    !/graveyard/i.test(m[1] ?? "")
  ) {
    const phrase = (m[1] ?? "").trim();
    const fromLibrary = /^the top /i.test(phrase);
    const { amount, rest } = stripDeterminer(phrase);
    add("exile", {
      subject: controlSubject(phrase, "any_player"),
      qualifier: rest || null,
      amount: fromLibrary ? (parseAmount(/top (\w+)/i.exec(phrase)?.[1]) ?? "variable") : amount,
      zones: { from: fromLibrary ? "library" : "battlefield", to: "exile" },
    });
  }
  if (
    (m =
      /\bsearch (your|their|that player's|target player's|each player's) library for (.+?)(?=, |\.| and |$)/i.exec(
        raw,
      )) !== null
  ) {
    const owner = (m[1] ?? "").toLowerCase();
    const whole = sentenceText.toLowerCase();
    const { amount, rest } = stripDeterminer((m[2] ?? "").trim());
    add("search_library", {
      subject: ownerSubject(owner, acting === "controller" ? "unknown" : acting),
      qualifier: rest || null,
      amount,
      zones: {
        from: "library",
        to: /onto the battlefield/.test(whole)
          ? "battlefield"
          : /into (?:your|their|that player's) hand/.test(whole)
            ? "hand"
            : /on top of (?:your|their) library/.test(whole)
              ? "library"
              : /exile/.test(whole)
                ? "exile"
                : null,
      },
    });
  }
  if (
    (m =
      /\badd ((?:\{[^}]+\})+|one mana|two mana|three mana|x mana|an amount of|that much mana|one additional mana|an additional|mana of any|one mana of any|two mana of any|three mana of any)/i.exec(
        raw,
      )) !== null
  ) {
    const q = m[1] ?? "";
    const symbols = q.match(/\{[^}]+\}/g);
    add("add_mana", {
      subject: "controller",
      qualifier: q,
      amount: symbols
        ? symbols.length
        : (parseAmount(q.split(" ")[0]) ?? (/\bany\b/i.test(q) ? 1 : "variable")),
    });
  }
  if ((m = /\bcounter target ((?:[a-z]+,? )*(?:spell|ability))\b/i.exec(raw)) !== null) {
    add("counter_spell", {
      subject: "any_player",
      qualifier: (m[1] ?? "").toLowerCase(),
      amount: 1,
      zones: { from: "stack", to: null },
    });
  }
  if ((m = /\byou may (?:cast|play) (.+?) from your graveyard\b/i.exec(raw)) !== null) {
    add(
      "cast_from_graveyard",
      {
        subject: "controller",
        qualifier: (m[1] ?? "").trim() || null,
        zones: { from: "graveyard", to: "stack" },
      },
      "permission",
    );
  }
  return count;
}

/** Split a sentence into clauses at ", then" / "and" boundaries that introduce a new actor. */
function clauses(masked: string, sentence: Span): Span[] {
  const body = masked.slice(sentence.start, sentence.end);
  const re =
    /,? (?:and|then) (?=(?:you |each opponent|each other player|each player|target player|target opponent|an opponent|its controller|its owner|that player|defending player)\b)|, then /gi;
  const out: Span[] = [];
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const t = trimSpan(masked, sentence.start + cursor, sentence.start + m.index);
    if (t) out.push(t);
    cursor = m.index + m[0].length;
  }
  const tail = trimSpan(masked, sentence.start + cursor, sentence.end);
  if (tail) out.push(tail);
  return out;
}

const RESTRICTION_SENTENCE =
  /^(?:activate (?:this ability )?only\b|this ability triggers only\b|activate only\b)/i;
const KEYWORD_LINE =
  /^[A-Z][A-Za-z'-]*(?: [a-z][a-z'-]*)*(?: (?:\{[^}]+\})+)?(?:, [a-z][a-z'-]*(?: [a-z][a-z'-]*)*(?: (?:\{[^}]+\})+)?)*$/;

function isKeywordLine(body: string, keywords: readonly string[]): boolean {
  if (body.endsWith(".") || body.includes(":")) return false;
  if (!KEYWORD_LINE.test(body)) return false;
  const lowered = keywords.map((k) => k.toLowerCase());
  const parts = body.split(", ").map((p) => p.toLowerCase().replace(/ \{[^}]+\}.*$/, ""));
  if (parts.every((p) => lowered.some((k) => p === k || p.startsWith(`${k} `)))) return true;
  return body.split(/\s+/).length <= 4;
}

/** Sentences of an effect body, with timing/trigger restriction sentences lifted into conditions. */
function effectSentences(masked: string, span: Span, restrictions: MechanicCondition[]): Span[] {
  const kept: Span[] = [];
  for (const sentence of sentences(masked, span)) {
    const s = masked.slice(sentence.start, sentence.end);
    if (RESTRICTION_SENTENCE.test(s)) {
      restrictions.push({ kind: "conditional", text: s.replace(/\.$/, "") });
      continue;
    }
    kept.push(sentence);
  }
  return kept;
}

const REPLACEMENT_SENTENCE = /\bwould\b|\binstead\b/i;
const ADDITIONAL_COST = /^as an additional cost to cast this spell, (.+?)\.?$/i;
/** Third-person verbs that continue the previous clause's actor ("…, then draws seven cards"). */
const CONTINUATION_VERB =
  /^(?:draws|discards|sacrifices|gains|loses|creates|mills|puts|exiles|returns|searches|shuffles|reveals|scries|surveils)\b/i;

function runEffectSentences(ctx: AbilityContext, masked: string, sents: readonly Span[]): void {
  for (const sentence of sents) {
    const sentenceText = masked.slice(sentence.start, sentence.end);
    if (REPLACEMENT_SENTENCE.test(sentenceText)) {
      // Replacement effects change what another event does; they are not modeled as effects.
      flag(ctx, "unmodeled", sentence, "replacement effect text is not modeled");
      continue;
    }
    const additional = ADDITIONAL_COST.exec(sentenceText);
    if (additional) {
      // A spell's additional cost is a cost, not a resolution effect.
      const costs = additional[1] ?? "";
      let cursor = sentence.start + sentenceText.indexOf(costs);
      for (const part of costs.split(/, | and /)) {
        const at = masked.indexOf(part, cursor);
        const span = at === -1 ? null : trimSpan(masked, at, at + part.length);
        if (span) readCost(ctx, span, masked);
        cursor = at === -1 ? cursor : at + part.length;
      }
      continue;
    }
    let previousLead: MechanicSubject | null = null;
    for (const clause of clauses(masked, sentence)) {
      const clauseText = masked.slice(clause.start, clause.end);
      const lead = leadSubject(clauseText);
      const inherited =
        lead === null && previousLead !== null && CONTINUATION_VERB.test(clauseText)
          ? previousLead
          : null;
      if (lead !== null) previousLead = lead;
      if (readEffects(ctx, sentence, clause, masked, inherited) > 0) continue;
      const words = clauseText.split(/\s+/).length;
      if (words >= 2) flag(ctx, "unmodeled", clause, "no supported pattern in this clause");
    }
  }
}

function analyzeAbility(
  card: Card,
  face: FaceSource,
  abilityIndex: number,
  body: Span,
  masked: string,
  modal: ModalContext | null,
  sink: Sink,
): void {
  const bodyText = masked.slice(body.start, body.end);
  const isSpellFace = /\b(?:Instant|Sorcery)\b/.test(face.typeLine);
  const ctx: AbilityContext = {
    face,
    abilityIndex,
    abilityKind: modal ? modal.abilityKind : isSpellFace ? "spell" : "static",
    selfRef: selfReference(face.name),
    inherited: modal ? modal.context : UNCONDITIONAL,
    annotations: [],
    unmodeled: [],
  };
  sink.coverage.abilities_total += 1;

  // Ability word prefix ("Landfall — Whenever …").
  let cursor = body.start;
  let explicitWord: string | null = null;
  const wordMatch = /^([A-Z][a-z]+(?: [A-Za-z]+)*) — /.exec(bodyText);
  if (wordMatch) {
    explicitWord = wordMatch[1] ?? null;
    cursor = body.start + wordMatch[0].length;
  }
  const analysis: Span = { start: cursor, end: body.end };
  const analysisText = masked.slice(analysis.start, analysis.end);
  const keywordBacked =
    explicitWord !== null &&
    card.keywords.some((k) => k.toLowerCase() === explicitWord?.toLowerCase());

  const restrictions: MechanicCondition[] = [];
  let counted: Span[];

  const triggerLead = /^(when|whenever|at the beginning of|at the end of)\s+/i.exec(analysisText);
  if (triggerLead) {
    ctx.abilityKind = "triggered";
    // A comma inside this card's own name ("Korvold, Fae-Cursed King") does not end the trigger.
    const afterLead = analysisText.slice(triggerLead[0].length);
    const nameSkip = afterLead.startsWith(face.name)
      ? triggerLead[0].length + face.name.length
      : triggerLead[0].length;
    const firstComma = analysisText.indexOf(",", nameSkip);
    const triggerEnd = firstComma === -1 ? analysis.end : analysis.start + firstComma;
    const triggerSpan: Span = { start: analysis.start, end: triggerEnd };
    const eventText = analysisText.slice(
      triggerLead[0].length,
      firstComma === -1 ? undefined : firstComma,
    );
    let rest: Span = { start: Math.min(triggerEnd + 1, analysis.end), end: analysis.end };
    // Further ", or <event>," segments extend the trigger; they are reported, not modeled.
    let more: RegExpExecArray | null;
    while ((more = /^\s*(or [^,]+),/i.exec(masked.slice(rest.start, rest.end))) !== null) {
      const segment = more[1] ?? "";
      const segmentStart = rest.start + more[0].indexOf(segment);
      flag(
        ctx,
        "uncertain",
        { start: segmentStart, end: segmentStart + segment.length },
        "additional trigger event is not modeled",
      );
      rest = { start: rest.start + more[0].length, end: rest.end };
    }
    // An intervening-if clause applies to the whole ability.
    const iv = /^\s*(if [^,]+),/i.exec(masked.slice(rest.start, rest.end));
    if (iv) {
      ctx.inherited = mergeCondition(ctx.inherited, { kind: "conditional", text: iv[1] ?? "" });
      rest = { start: rest.start + iv[0].length, end: rest.end };
    }
    const sents = effectSentences(masked, rest, restrictions);
    for (const r of restrictions) ctx.inherited = mergeCondition(ctx.inherited, r);
    const read = readTrigger(eventText, ctx.selfRef, /^at\b/i.test(triggerLead[1] ?? ""));
    if (read) {
      emit(ctx, "trigger", read.kind, triggerSpan, {
        subject: read.subject,
        qualifier: read.qualifier,
        zones: read.zones,
        condition: UNCONDITIONAL,
        provenance: keywordBacked ? "explicit" : "inferred",
      });
    } else {
      flag(ctx, "uncertain", triggerSpan, "unrecognized trigger event");
    }
    runEffectSentences(ctx, masked, sents);
    counted = sentences(masked, analysis).filter(
      (s) => !RESTRICTION_SENTENCE.test(masked.slice(s.start, s.end)),
    );
  } else if (/^[^.:"]{1,160}:\s/.test(analysisText)) {
    ctx.abilityKind = "activated";
    const colon = analysisText.indexOf(":");
    const costSpan: Span = { start: analysis.start, end: analysis.start + colon };
    const rest: Span = { start: costSpan.end + 1, end: analysis.end };
    const sents = effectSentences(masked, rest, restrictions);
    for (const r of restrictions) ctx.inherited = mergeCondition(ctx.inherited, r);
    let elementStart = 0;
    for (const part of masked.slice(costSpan.start, costSpan.end).split(", ")) {
      const span = trimSpan(
        masked,
        costSpan.start + elementStart,
        costSpan.start + elementStart + part.length,
      );
      if (span) readCost(ctx, span, masked);
      elementStart += part.length + 2;
    }
    runEffectSentences(ctx, masked, sents);
    counted = sentences(masked, analysis).filter(
      (s) => !RESTRICTION_SENTENCE.test(masked.slice(s.start, s.end)),
    );
  } else if (isKeywordLine(analysisText, card.keywords)) {
    flag(ctx, "unmodeled", analysis, "keyword ability line; keywords are not modeled as mechanics");
    counted = [analysis];
  } else {
    const sents = effectSentences(masked, analysis, restrictions);
    for (const r of restrictions) ctx.inherited = mergeCondition(ctx.inherited, r);
    runEffectSentences(ctx, masked, sents);
    counted = sents;
  }

  // Coverage accounting per sentence; the trigger clause belongs to the first sentence.
  let withSupport = ctx.annotations.length > 0;
  for (const s of counted) {
    sink.coverage.sentences_total += 1;
    const supported = ctx.annotations.some(
      (a) => a.evidence.start >= s.start && a.evidence.start < s.end,
    );
    const flagged = ctx.unmodeled.filter(
      (u) => u.evidence.start >= s.start && u.evidence.start < s.end,
    );
    if (supported) {
      sink.coverage.sentences_supported += 1;
      withSupport = true;
    } else if (flagged.some((u) => u.status === "uncertain")) {
      sink.coverage.sentences_uncertain += 1;
    } else {
      sink.coverage.sentences_unmodeled += 1;
    }
  }
  if (withSupport) sink.coverage.abilities_with_support += 1;
  if (withSupport && ctx.unmodeled.length === 0) sink.coverage.abilities_fully_modeled += 1;
  sink.annotations.push(...ctx.annotations);
  sink.unmodeled.push(...ctx.unmodeled);
}

function faceSources(card: Card): { source: CardMechanics["source"]; faces: FaceSource[] } {
  const gameplay = card.gameplay;
  if (!gameplay) {
    return {
      source: "flat_oracle_text",
      faces: [
        {
          faceIndex: null,
          name: card.name,
          typeLine: card.type_line,
          text: card.oracle_text,
          evidence: (start, end) => ({
            oracle_id: card.oracle_id,
            scryfall_id: null,
            source_oracle_id: null,
            face_index: null,
            field_path: "/oracle_text",
            offset_unit: "utf16_code_units",
            start,
            end,
            text: card.oracle_text.slice(start, end),
          }),
        },
      ],
    };
  }
  const entries: Array<{ faceIndex: number | null; characteristics: CardCharacteristics }> =
    gameplay.faces && gameplay.faces.length > 0
      ? gameplay.faces.map((f) => ({ faceIndex: f.face_index, characteristics: f.characteristics }))
      : [{ faceIndex: null, characteristics: gameplay.characteristics }];
  const faces: FaceSource[] = [];
  for (const { faceIndex, characteristics } of entries) {
    const text = characteristics.oracle_text;
    if (text === null) continue;
    faces.push({
      faceIndex,
      name: characteristics.name ?? card.name,
      typeLine: characteristics.type_line ?? card.type_line,
      text,
      evidence: (start, end) =>
        oracleTextEvidence(card, faceIndex, start, end) ?? {
          oracle_id: card.oracle_id,
          scryfall_id: gameplay.source.scryfall_id,
          source_oracle_id: gameplay.source.oracle_id,
          face_index: faceIndex,
          field_path: faceIndex === null ? "/oracle_text" : `/card_faces/${faceIndex}/oracle_text`,
          offset_unit: "utf16_code_units",
          start,
          end,
          text: text.slice(start, end),
        },
    });
  }
  return { source: "gameplay_faces", faces };
}

/** A modal header ends its paragraph with an em dash ("Choose one —"). */
const MODAL_HEADER =
  /(?:^|, )(choose (?:one|two|three|one or more|one or both|any number|up to \w+))\s*—\s*$/i;

/** Extract supported mechanics with exact Oracle evidence. Pure; never mutates the card. */
export function extractMechanics(card: Card): CardMechanics {
  const { source, faces } = faceSources(card);
  const sink: Sink = {
    annotations: [],
    unmodeled: [],
    coverage: {
      abilities_total: 0,
      abilities_with_support: 0,
      abilities_fully_modeled: 0,
      sentences_total: 0,
      sentences_supported: 0,
      sentences_unmodeled: 0,
      sentences_uncertain: 0,
    },
  };
  let abilityIndex = 0;
  for (const face of faces) {
    let masked = maskParentheses(face.text);
    // Granted ability text: report it, never attribute it to this card.
    const quoted: Span[] = [];
    masked = masked.replace(/"[^"]*"/g, (m, offset: number) => {
      quoted.push({ start: offset, end: offset + m.length });
      return " ".repeat(m.length);
    });
    let modal: ModalContext | null = null;
    let offset = 0;
    for (const paragraph of masked.split("\n")) {
      const paragraphStart = offset;
      const paragraphEnd = offset + paragraph.length;
      const span = trimSpan(masked, paragraphStart, paragraphEnd);
      offset += paragraph.length + 1;
      const quotedHere = quoted.filter((q) => q.start >= paragraphStart && q.start < paragraphEnd);
      if (!span) {
        for (const q of quotedHere) {
          sink.unmodeled.push({
            status: "uncertain",
            ability_index: abilityIndex,
            ability_kind: null,
            face_index: face.faceIndex,
            reason: "granted ability text is not attributed to this card",
            evidence: face.evidence(q.start, q.end),
          });
        }
        continue;
      }
      const body = masked.slice(span.start, span.end);
      if (/^•/.test(body)) {
        const inner = trimSpan(masked, span.start + 1, span.end);
        if (inner) {
          analyzeAbility(card, face, abilityIndex, inner, masked, modal, sink);
          abilityIndex += 1;
        }
        continue;
      }
      const header = MODAL_HEADER.exec(body);
      if (header) {
        const isTriggered = /^(?:when|whenever|at the beginning of)\b/i.test(body);
        const kind: AbilityKind = isTriggered
          ? "triggered"
          : /^[^.:"]{1,160}:\s/.test(body)
            ? "activated"
            : /\b(?:Instant|Sorcery)\b/.test(face.typeLine)
              ? "spell"
              : "static";
        modal = {
          context: { kind: "conditional", text: header[1] ?? "choose one" },
          abilityKind: kind,
        };
        if (isTriggered || kind === "activated") {
          // The header still carries a trigger or cost to read; its modal tail is the choice.
          const head = trimSpan(masked, span.start, span.start + header.index);
          if (head) {
            analyzeAbility(card, face, abilityIndex, head, masked, null, sink);
            abilityIndex += 1;
          }
        }
        continue;
      }
      modal = null;
      for (const q of quotedHere) {
        sink.unmodeled.push({
          status: "uncertain",
          ability_index: abilityIndex,
          ability_kind: "static",
          face_index: face.faceIndex,
          reason: "granted ability text is not attributed to this card",
          evidence: face.evidence(q.start, q.end),
        });
      }
      analyzeAbility(card, face, abilityIndex, span, masked, null, sink);
      abilityIndex += 1;
    }
  }
  return {
    version: 1,
    extractor_version: MECHANICS_EXTRACTOR_VERSION,
    oracle_id: card.oracle_id,
    name: card.name,
    source,
    annotations: sink.annotations,
    unmodeled: sink.unmodeled,
    coverage: sink.coverage,
    legality: "not_evaluated",
  };
}
