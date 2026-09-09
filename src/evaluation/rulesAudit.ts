/**
 * Commander validation audit against the frozen Comprehensive Rules excerpt
 * (Commander workshop: rules and combo intelligence).
 *
 * `docs/evaluation/rules/commander-rules-excerpt-20260807.json` freezes the
 * verbatim rule and glossary text the validators were audited against, with
 * the full release's SHA-256. Each audit case cites the rule numbers it
 * exercises, quotes the load-bearing phrase from those rules, and runs a
 * deck fixture through the real validators. The pinned test fails when a
 * validator drifts from its expected verdict, when a cited rule leaves the
 * excerpt, or when the quoted wording no longer matches the frozen text — so
 * a future rules release is re-audited deliberately instead of silently.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { Card, Deck, Violation, ViolationRule } from "../types/index.js";
import {
  validateCommander,
  validateCompanion,
  validateCore,
  commanderColorIdentity,
  anyNumberReason,
  type CardLookup,
} from "../validate/index.js";

export const RULES_EXCERPT_PATH = fileURLToPath(
  new URL("../../docs/evaluation/rules/commander-rules-excerpt-20260807.json", import.meta.url),
);

const excerptSchema = z.object({
  corpus: z.object({
    source_url: z.string(),
    published_version: z.string(),
    effective_date: z.string(),
    effective_date_text: z.string(),
    retrieved_at: z.string(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    bytes: z.number().int().positive(),
  }),
  rules: z.record(z.string(), z.string()),
  glossary: z.record(z.string(), z.string()),
});

export type RulesExcerpt = z.infer<typeof excerptSchema>;

export interface LoadedRulesExcerpt {
  excerpt: RulesExcerpt;
  /** SHA-256 of the excerpt file bytes; pinned so fixture edits are reviewed. */
  digest: string;
}

export async function loadRulesExcerpt(
  path: string = RULES_EXCERPT_PATH,
): Promise<LoadedRulesExcerpt> {
  const raw = await readFile(path);
  return {
    excerpt: excerptSchema.parse(JSON.parse(raw.toString("utf8"))),
    digest: createHash("sha256").update(raw).digest("hex"),
  };
}

/* ------------------------------------------------------------------------ */
/* Fixtures                                                                  */
/* ------------------------------------------------------------------------ */

function card(partial: Partial<Card> & { oracle_id: string; name: string }): Card {
  return {
    mana_cost: "",
    mv: 0,
    colors: [],
    color_identity: [],
    type_line: "Creature — Human",
    oracle_text: "",
    keywords: [],
    legalities: { commander: "legal" },
    prices: {},
    is_commander_eligible: false,
    roles: [],
    printings: [],
    ...partial,
  };
}

function legend(partial: Partial<Card> & { oracle_id: string; name: string }): Card {
  return card({
    type_line: "Legendary Creature — Human",
    is_commander_eligible: true,
    ...partial,
  });
}

function lookupOf(...cards: Card[]): CardLookup {
  const byId = new Map(cards.map((c) => [c.oracle_id, c]));
  return (id) => byId.get(id) ?? null;
}

interface DeckFixture {
  deck: Deck;
  lookup: CardLookup;
}

/** A deck of `commanders` plus `library` entries, filled to 100 with basic Forests. */
function commanderDeck(
  commanders: Card[],
  library: Array<{ card: Card; qty: number }>,
  options: { kind?: Deck["command_zone_kind"]; companion?: Card; total?: number } = {},
): DeckFixture {
  const forest = card({
    oracle_id: "forest",
    name: "Forest",
    type_line: "Basic Land — Forest",
    color_identity: [],
  });
  const total = options.total ?? 100;
  const explicit = library.reduce((sum, e) => sum + e.qty, 0) + commanders.length;
  const filler = Math.max(0, total - explicit);
  const cards = [
    ...library.map((e) => ({ oracle_id: e.card.oracle_id, qty: e.qty })),
    ...(filler > 0 ? [{ oracle_id: forest.oracle_id, qty: filler }] : []),
  ];
  const lookup = lookupOf(
    ...commanders,
    ...library.map((e) => e.card),
    forest,
    ...(options.companion ? [options.companion] : []),
  );
  const partial: Pick<Deck, "commanders"> = { commanders: commanders.map((c) => c.oracle_id) };
  const deck: Deck = {
    deck_id: "audit",
    name: "Rules audit",
    format: "commander",
    commanders: partial.commanders,
    command_zone_kind: options.kind ?? "single",
    ...(options.companion ? { companion: options.companion.oracle_id } : {}),
    cards,
    computed_color_identity: commanderColorIdentity(partial, lookup),
    version: 1,
    data_snapshot: "2026-09-08",
  };
  return { deck, lookup };
}

function allViolations({ deck, lookup }: DeckFixture): Violation[] {
  return [
    ...validateCore(deck, lookup),
    ...validateCommander(deck, lookup),
    ...validateCompanion(deck, lookup),
  ];
}

/* ------------------------------------------------------------------------ */
/* Case table                                                                */
/* ------------------------------------------------------------------------ */

export interface AuditQuote {
  rule: string;
  /** Verbatim phrase that must appear in the frozen rule text. */
  text: string;
}

export interface AuditCase {
  id: string;
  /** Rule identifiers exercised; every one must exist in the excerpt. */
  rules: string[];
  claim: string;
  quotes: AuditQuote[];
  /** Expected violation rules (sorted, unique). */
  expected: ViolationRule[];
  run(): Violation[];
}

const GREEN: Card = legend({
  oracle_id: "omnath",
  name: "Omnath, Locus of Mana",
  color_identity: ["G"],
  mv: 3,
  mana_cost: "{2}{G}",
});
const RED_SPELL = card({
  oracle_id: "bolt",
  name: "Lightning Bolt",
  type_line: "Instant",
  color_identity: ["R"],
  mv: 1,
  mana_cost: "{R}",
});
const GREEN_SPELL = card({
  oracle_id: "growth",
  name: "Giant Growth",
  type_line: "Instant",
  color_identity: ["G"],
  mv: 1,
  mana_cost: "{G}",
});
const RATS = card({
  oracle_id: "rats",
  name: "Relentless Rats",
  type_line: "Creature — Rat",
  color_identity: ["B"],
  mv: 3,
  oracle_text: "A deck can have any number of cards named Relentless Rats.",
});
const BLACK = legend({ oracle_id: "black", name: "Black Legend", color_identity: ["B"] });
const BANNED = card({
  oracle_id: "banned",
  name: "Banned Card",
  type_line: "Artifact",
  legalities: { commander: "banned" },
});

const PARTNER_A = legend({
  oracle_id: "tymna",
  name: "Tymna the Weaver",
  color_identity: ["W", "B"],
  keywords: ["Partner"],
  oracle_text: "Partner (You can have two commanders if both have partner.)",
});
const PARTNER_B = legend({
  oracle_id: "thrasios",
  name: "Thrasios, Triton Hero",
  color_identity: ["G", "U"],
  keywords: ["Partner"],
  oracle_text: "Partner (You can have two commanders if both have partner.)",
});
const SURVIVOR_A = legend({
  oracle_id: "abby",
  name: "Abby, Merciless Soldier",
  type_line: "Legendary Creature — Human Survivor",
  keywords: ["Partner"],
  oracle_text: "Partner—Survivors (You can have two commanders if both have Partner—Survivors.)",
});
const SURVIVOR_B = legend({
  oracle_id: "joel",
  name: "Joel, Resolute Survivor",
  type_line: "Legendary Creature — Human Survivor",
  keywords: ["Partner", "Menace"],
  oracle_text:
    "Menace\nPartner—Survivors (You can have two commanders if both have Partner—Survivors.)",
});
const FATHER_SON = legend({
  oracle_id: "jecht",
  name: "Jecht, Blitzball Legend",
  keywords: ["Partner"],
  oracle_text:
    "Partner—Father & son (You can have two commanders if both have Partner—Father & son.)",
});
const PIR = legend({
  oracle_id: "pir",
  name: "Pir, Imaginative Rascal",
  oracle_text: "Partner with Toothy, Imaginary Friend",
});
const TOOTHY = legend({
  oracle_id: "toothy",
  name: "Toothy, Imaginary Friend",
  oracle_text: "Partner with Pir, Imaginative Rascal",
});
const WILSON = legend({
  oracle_id: "wilson",
  name: "Wilson, Refined Grizzly",
  oracle_text: "Choose a Background",
});
const BACKGROUND = card({
  oracle_id: "cult",
  name: "Cult of the Pit",
  type_line: "Legendary Enchantment — Background",
});
const NOT_BACKGROUND = card({
  oracle_id: "painting",
  name: "Background Painting",
  type_line: "Legendary Artifact — Background",
});
const DOCTOR = legend({
  oracle_id: "fourth",
  name: "The Fourth Doctor",
  type_line: "Legendary Creature — Time Lord Doctor",
});
const MISSY = legend({
  oracle_id: "missy",
  name: "Missy",
  type_line: "Legendary Creature — Time Lord Rogue",
});
const DOCTOR_EXTRA_TYPE = legend({
  oracle_id: "hybrid",
  name: "Hypothetical Doctor",
  type_line: "Legendary Creature — Time Lord Doctor Noble",
});
const COMPANION_ACE = legend({
  oracle_id: "ace",
  name: "Ace, Fearless Rebel",
  type_line: "Legendary Creature — Human Rebel",
  keywords: ["Doctor's companion"],
  oracle_text: "Doctor's companion (You can have two commanders if the other is the Doctor.)",
});
const VEHICLE = card({
  oracle_id: "parhelion",
  name: "Parhelion II",
  type_line: "Legendary Artifact — Vehicle",
  power: "5",
  toughness: "5",
});
const SPACECRAFT = card({
  oracle_id: "voyager",
  name: "Eternal Voyager",
  type_line: "Legendary Artifact — Spacecraft",
  power: "3",
  toughness: "4",
});
const RELIC = card({
  oracle_id: "relic",
  name: "Legendary Relic",
  type_line: "Legendary Artifact",
});
const NONLEGENDARY = card({
  oracle_id: "bear",
  name: "Grizzly Bears",
  type_line: "Creature — Bear",
  power: "2",
  toughness: "2",
});
const PLANESWALKER = card({
  oracle_id: "rowan",
  name: "Rowan Kenrith",
  type_line: "Legendary Planeswalker — Rowan",
  oracle_text: "Rowan Kenrith can be your commander.",
});
const LURRUS = card({
  oracle_id: "lurrus",
  name: "Lurrus of the Dream-Den",
  type_line: "Legendary Creature — Cat Nightmare",
  oracle_text: "Companion — Each permanent card in your starting deck has mana value 2 or less.",
});
const YORION = card({
  oracle_id: "yorion",
  name: "Yorion, Sky Nomad",
  type_line: "Legendary Creature — Bird Serpent",
  oracle_text:
    "Companion — Your starting deck contains at least twenty cards more than the minimum deck size.",
});
const CHEAP_LEGEND = legend({ oracle_id: "cheap", name: "Cheap Legend", mv: 2 });
const PRICY_LEGEND = legend({ oracle_id: "pricy", name: "Pricy Legend", mv: 4 });
const PRICY_PERMANENT = card({
  oracle_id: "golem",
  name: "Big Golem",
  type_line: "Artifact Creature — Golem",
  mv: 5,
});

function violationRules(violations: Violation[]): ViolationRule[] {
  return [...new Set(violations.map((v) => v.rule))].sort();
}

export const RULES_AUDIT_CASES: readonly AuditCase[] = [
  {
    id: "count-exactly-100",
    rules: ["903.5a", "702.124b"],
    claim: "A deck of exactly 100 cards including one or two commanders passes; 99 or 101 fails.",
    quotes: [
      { rule: "903.5a", text: "exactly 100 cards, including its commander" },
      { rule: "702.124b", text: "exactly 100 cards, including its two commanders" },
    ],
    expected: [],
    run: () => [
      ...allViolations(commanderDeck([GREEN], [])),
      ...allViolations(
        commanderDeck([PARTNER_A, PARTNER_B], [{ card: GREEN_SPELL, qty: 1 }], { kind: "partner" }),
      ),
    ],
  },
  {
    id: "count-short",
    rules: ["903.5a"],
    claim: "A 99-card deck is a CARD_COUNT error.",
    quotes: [
      { rule: "903.5a", text: "the minimum deck size and the maximum deck size are both 100" },
    ],
    expected: ["CARD_COUNT"],
    run: () => allViolations(commanderDeck([GREEN], [], { total: 99 })),
  },
  {
    id: "count-over",
    rules: ["903.5a"],
    claim: "A 101-card deck is a CARD_COUNT error.",
    quotes: [{ rule: "903.5a", text: "exactly 100 cards" }],
    expected: ["CARD_COUNT"],
    run: () => allViolations(commanderDeck([GREEN], [], { total: 101 })),
  },
  {
    id: "singleton-nonbasic",
    rules: ["903.5b"],
    claim: "Two copies of a nonbasic card violate singleton.",
    quotes: [
      { rule: "903.5b", text: "each card in a Commander deck must have a different English name" },
    ],
    expected: ["SINGLETON"],
    run: () => allViolations(commanderDeck([GREEN], [{ card: GREEN_SPELL, qty: 2 }])),
  },
  {
    id: "singleton-basic-lands",
    rules: ["903.5b"],
    claim: "Any number of basic lands is legal.",
    quotes: [{ rule: "903.5b", text: "Other than basic lands" }],
    expected: [],
    run: () => allViolations(commanderDeck([GREEN], [])),
  },
  {
    id: "singleton-any-number-text",
    rules: ["903.5b", "101.1"],
    claim:
      "A card whose own text allows any number of copies is exempt; the exemption reason is reported as oracle_text or allowlist.",
    quotes: [
      {
        rule: "101.1",
        text: "Whenever a card’s text directly contradicts these rules, the card takes precedence",
      },
    ],
    expected: [],
    run: () => {
      const fixture = commanderDeck([BLACK], [{ card: RATS, qty: 20 }]);
      const reason = anyNumberReason(RATS);
      if (reason !== "allowlist" && reason !== "oracle_text") {
        return [
          {
            rule: "SINGLETON",
            severity: "error",
            detail: `expected an any-number exemption, got ${String(reason)}`,
          },
        ];
      }
      return allViolations(fixture);
    },
  },
  {
    id: "color-identity-outside",
    rules: ["903.5c", "903.4"],
    claim: "A red card in a green-commander deck violates color identity.",
    quotes: [
      {
        rule: "903.5c",
        text: "only if every color in its color identity is also found in the color identity of the deck’s commander",
      },
      {
        rule: "903.4",
        text: "The Commander variant uses color identity to determine what cards can be in a deck",
      },
    ],
    expected: ["COLOR_IDENTITY"],
    run: () => allViolations(commanderDeck([GREEN], [{ card: RED_SPELL, qty: 1 }])),
  },
  {
    id: "color-identity-inside",
    rules: ["903.5c"],
    claim: "A green card in a green-commander deck passes.",
    quotes: [{ rule: "903.5c", text: "every color in its color identity" }],
    expected: [],
    run: () => allViolations(commanderDeck([GREEN], [{ card: GREEN_SPELL, qty: 1 }])),
  },
  {
    id: "color-identity-partner-union",
    rules: ["702.124c", "903.4"],
    claim: "Two partners combine their color identities.",
    quotes: [
      { rule: "702.124c", text: "refers to the combined color identities of your two commanders" },
    ],
    expected: [],
    run: () => {
      const fixture = commanderDeck([PARTNER_A, PARTNER_B], [{ card: GREEN_SPELL, qty: 1 }], {
        kind: "partner",
      });
      const identity = fixture.deck.computed_color_identity.join("");
      return identity === "WUBG"
        ? allViolations(fixture)
        : [{ rule: "COLOR_IDENTITY", severity: "error", detail: `identity ${identity}` }];
    },
  },
  {
    id: "banlist-from-data",
    rules: ["903.5", "100.2c"],
    claim:
      "A card with Commander legality banned is a BANLIST error (the list itself is data, not text).",
    quotes: [
      {
        rule: "100.2c",
        text: "Commander decks are subject to additional deckbuilding restrictions",
      },
    ],
    expected: ["BANLIST"],
    run: () => allViolations(commanderDeck([GREEN], [{ card: BANNED, qty: 1 }])),
  },
  {
    id: "eligible-legendary-creature",
    rules: ["903.3"],
    claim: "A legendary creature is an eligible commander.",
    quotes: [{ rule: "903.3", text: "That card must be either (a) a creature card" }],
    expected: [],
    run: () => allViolations(commanderDeck([GREEN], [])),
  },
  {
    id: "eligible-vehicle-spacecraft",
    rules: ["903.3"],
    claim: "A legendary Vehicle or Spacecraft with a printed power/toughness box is eligible.",
    quotes: [
      {
        rule: "903.3",
        text: "(b) a Vehicle card, or (c) a Spacecraft card with one or more power/toughness boxes",
      },
    ],
    expected: [],
    run: () => [
      ...allViolations(commanderDeck([VEHICLE], [])),
      ...allViolations(commanderDeck([SPACECRAFT], [])),
    ],
  },
  {
    id: "ineligible-legendary-artifact",
    rules: ["903.3"],
    claim: "A legendary artifact without a power/toughness box is not eligible.",
    quotes: [{ rule: "903.3", text: "Each deck has a legendary card designated as its commander" }],
    expected: ["COMMANDER_ELIGIBILITY"],
    run: () => allViolations(commanderDeck([RELIC], [])),
  },
  {
    id: "ineligible-nonlegendary-creature",
    rules: ["903.3"],
    claim: "A nonlegendary creature is not eligible.",
    quotes: [{ rule: "903.3", text: "a legendary card designated as its commander" }],
    expected: ["COMMANDER_ELIGIBILITY"],
    run: () => allViolations(commanderDeck([NONLEGENDARY], [])),
  },
  {
    id: "eligible-can-be-your-commander",
    rules: ["903.3a"],
    claim: "A card stating it can be your commander is eligible regardless of type.",
    quotes: [
      {
        rule: "903.3a",
        text: "Some cards have an ability that states the card can be your commander",
      },
    ],
    expected: [],
    run: () => allViolations(commanderDeck([PLANESWALKER], [])),
  },
  {
    id: "single-zone-two-cards",
    rules: ["903.3", "702.124g"],
    claim: "Two commanders without a partner ability is a MULTI_COMMANDER error.",
    quotes: [
      {
        rule: "702.124g",
        text: "no partner ability or combination of partner abilities can ever let a player have more than two commanders",
      },
    ],
    expected: ["MULTI_COMMANDER"],
    run: () => allViolations(commanderDeck([GREEN, BLACK], [])),
  },
  {
    id: "partner-plain-pair",
    rules: ["702.124h"],
    claim: "Two cards with partner pair.",
    quotes: [{ rule: "702.124h", text: "if each of them has partner" }],
    expected: [],
    run: () => allViolations(commanderDeck([PARTNER_A, PARTNER_B], [], { kind: "partner" })),
  },
  {
    id: "partner-text-same-label",
    rules: ["702.124i"],
    claim: "Two Partner—Survivors cards pair.",
    quotes: [{ rule: "702.124i", text: "if each of them has the same ‘partner—[text]’ ability" }],
    expected: [],
    run: () => allViolations(commanderDeck([SURVIVOR_A, SURVIVOR_B], [], { kind: "partner" })),
  },
  {
    id: "partner-text-different-labels",
    rules: ["702.124i", "702.124f"],
    claim: "Partner—Survivors and Partner—Father & son do not pair.",
    quotes: [
      {
        rule: "702.124f",
        text: "Different partner abilities are distinct from one another and cannot be combined",
      },
    ],
    expected: ["MULTI_COMMANDER"],
    run: () => allViolations(commanderDeck([SURVIVOR_A, FATHER_SON], [], { kind: "partner" })),
  },
  {
    id: "partner-text-with-plain-partner",
    rules: ["702.124f", "702.124i"],
    claim:
      "Partner—Survivors does not pair with plain partner even though Scryfall lists both as Partner.",
    quotes: [{ rule: "702.124f", text: "cannot be combined" }],
    expected: ["MULTI_COMMANDER"],
    run: () => allViolations(commanderDeck([SURVIVOR_A, PARTNER_A], [], { kind: "partner" })),
  },
  {
    id: "partner-with-named-pair",
    rules: ["702.124j"],
    claim: "Partner with [name] pairs only the two named cards.",
    quotes: [
      {
        rule: "702.124j",
        text: "if each has a ‘partner with [name]’ ability with the other’s name",
      },
    ],
    expected: ["MULTI_COMMANDER"],
    run: () => {
      const ok = allViolations(commanderDeck([PIR, TOOTHY], [], { kind: "partner" }));
      const wrong = allViolations(commanderDeck([PIR, PARTNER_B], [], { kind: "partner" }));
      return ok.length === 0
        ? wrong
        : [{ rule: "CARD_COUNT", severity: "error", detail: "named pair unexpectedly rejected" }];
    },
  },
  {
    id: "background-pair",
    rules: ["702.124k"],
    claim: "Choose a Background pairs with a legendary Background enchantment.",
    quotes: [{ rule: "702.124k", text: "the other is a legendary Background enchantment card" }],
    expected: [],
    run: () => allViolations(commanderDeck([WILSON, BACKGROUND], [], { kind: "background" })),
  },
  {
    id: "background-not-enchantment",
    rules: ["702.124k"],
    claim: "Choose a Background does not pair with a non-enchantment Background.",
    quotes: [
      { rule: "702.124k", text: "the other is not a legendary Background enchantment card" },
    ],
    expected: ["COMMANDER_ELIGIBILITY", "MULTI_COMMANDER"],
    run: () => allViolations(commanderDeck([WILSON, NOT_BACKGROUND], [], { kind: "background" })),
  },
  {
    id: "doctor-companion-pair",
    rules: ["702.124m"],
    claim: "A Doctor's companion pairs with a legendary Time Lord Doctor.",
    quotes: [
      {
        rule: "702.124m",
        text: "the other is a legendary Time Lord Doctor creature card that has no other creature types",
      },
    ],
    expected: [],
    run: () =>
      allViolations(commanderDeck([DOCTOR, COMPANION_ACE], [], { kind: "doctor_companion" })),
  },
  {
    id: "doctor-companion-non-doctor-time-lord",
    rules: ["702.124m"],
    claim: "A Doctor's companion does not pair with a Time Lord that is not a Doctor.",
    quotes: [{ rule: "702.124m", text: "Time Lord Doctor creature card" }],
    expected: ["MULTI_COMMANDER"],
    run: () =>
      allViolations(commanderDeck([MISSY, COMPANION_ACE], [], { kind: "doctor_companion" })),
  },
  {
    id: "doctor-companion-extra-creature-type",
    rules: ["702.124m"],
    claim: "A Time Lord Doctor with another creature type does not qualify.",
    quotes: [{ rule: "702.124m", text: "has no other creature types" }],
    expected: ["MULTI_COMMANDER"],
    run: () =>
      allViolations(
        commanderDeck([DOCTOR_EXTRA_TYPE, COMPANION_ACE], [], { kind: "doctor_companion" }),
      ),
  },
  {
    id: "companion-condition-over-starting-deck",
    rules: ["702.139a", "702.139b"],
    claim:
      "A companion's condition is checked over the starting deck, and in Commander that includes the commander.",
    quotes: [
      {
        rule: "702.139a",
        text: "with a companion ability whose condition is fulfilled by your starting deck",
      },
      {
        rule: "702.139b",
        text: "In a Commander game, this is also before you’ve set aside your commander",
      },
    ],
    expected: ["COMPANION"],
    run: () => {
      const passes = allViolations(commanderDeck([CHEAP_LEGEND], [], { companion: LURRUS }));
      const commanderBreaks = allViolations(
        commanderDeck([PRICY_LEGEND], [], { companion: LURRUS }),
      );
      const libraryBreaks = allViolations(
        commanderDeck([CHEAP_LEGEND], [{ card: PRICY_PERMANENT, qty: 1 }], { companion: LURRUS }),
      );
      if (passes.length > 0) {
        return [{ rule: "CARD_COUNT", severity: "error", detail: "legal companion deck rejected" }];
      }
      return [...commanderBreaks, ...libraryBreaks];
    },
  },
  {
    id: "companion-yorion-impossible",
    rules: ["702.139a", "903.5a"],
    claim: "Yorion's twenty-over-minimum condition cannot be met in a fixed 100-card deck.",
    quotes: [
      { rule: "903.5a", text: "the minimum deck size and the maximum deck size are both 100" },
    ],
    expected: ["COMPANION"],
    run: () => allViolations(commanderDeck([CHEAP_LEGEND], [], { companion: YORION })),
  },
];

/* ------------------------------------------------------------------------ */
/* Runner                                                                    */
/* ------------------------------------------------------------------------ */

export interface AuditCaseResult {
  id: string;
  rules: string[];
  claim: string;
  expected: ViolationRule[];
  actual: ViolationRule[];
  /** Cited rule identifiers absent from the excerpt. */
  missing_rules: string[];
  /** Quotes whose text is not present in the frozen rule text. */
  missing_quotes: AuditQuote[];
  passed: boolean;
}

export interface AuditCoverage {
  /** Rule identifiers exercised by at least one case. */
  cited: string[];
  /** Rules in the excerpt that no validator models, with the reason. */
  not_modeled: Array<{ rule: string; reason: string }>;
}

export interface RulesAuditReport {
  corpus: RulesExcerpt["corpus"];
  cases: AuditCaseResult[];
  passed: number;
  failed: number;
  coverage: AuditCoverage;
}

/** Rules present in the excerpt that the validators deliberately do not model. */
export const NOT_MODELED: AuditCoverage["not_modeled"] = [
  {
    rule: "903.5d",
    reason:
      "Basic land type colors are already folded into Scryfall color_identity; the validator checks identity, not land types.",
  },
  {
    rule: "201.3",
    reason:
      "Interchangeable-name cards are treated by exact English name; no interchangeable-name table exists.",
  },
  { rule: "903.5e", reason: "Sideboards are not represented; decks have no sideboard zone." },
  {
    rule: "903.11",
    reason: "Cards from outside the game are a play-time rule, not a deck construction check.",
  },
  { rule: "903.12", reason: "Brawl is not a supported format." },
  { rule: "903.13", reason: "Commander Draft deck construction is not a supported format." },
];

export function runRulesAudit(excerpt: RulesExcerpt): RulesAuditReport {
  const cases = RULES_AUDIT_CASES.map((c): AuditCaseResult => {
    const actual = violationRules(c.run());
    const expected = [...new Set(c.expected)].sort();
    const missingRules = c.rules.filter((rule) => !(rule in excerpt.rules));
    const missingQuotes = c.quotes.filter((q) => !(excerpt.rules[q.rule] ?? "").includes(q.text));
    return {
      id: c.id,
      rules: c.rules,
      claim: c.claim,
      expected,
      actual,
      missing_rules: missingRules,
      missing_quotes: missingQuotes,
      passed:
        missingRules.length === 0 &&
        missingQuotes.length === 0 &&
        JSON.stringify(actual) === JSON.stringify(expected),
    };
  });
  const cited = [...new Set(cases.flatMap((c) => c.rules))].sort();
  return {
    corpus: excerpt.corpus,
    cases,
    passed: cases.filter((c) => c.passed).length,
    failed: cases.filter((c) => !c.passed).length,
    coverage: { cited, not_modeled: NOT_MODELED },
  };
}
