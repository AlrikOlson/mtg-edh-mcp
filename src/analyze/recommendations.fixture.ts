import type { Deck, Role } from "../types/index.js";
import { rawCard } from "./discovery.fixture.js";

/**
 * Frozen synthetic design scenarios, authored before inspecting recommendation
 * scores. They assess a bounded heuristic's directional judgment, not win rate,
 * human preference, full-pool recall, or quality on real Commander decks.
 *
 * Every card is a synthetic Oracle-text probe except Sol Ring. Its name, identity,
 * text, type, mana value and rank were verified on 2026-09-09 against
 * https://api.scryfall.com/cards/named?exact=Sol%20Ring (edhrec_rank: 1).
 * Popularity is provenance for the contrast, never an input to the expected score.
 */
const pool = new Map<string, ReturnType<typeof rawCard>>();
function probe(id: string, text: string, type = "Creature — Human", mv = 2): string {
  pool.set(id, rawCard(id, text, { type_line: type, cmc: mv, mana_cost: `{${mv}}` }));
  return id;
}
function leader(id: string, text: string): string {
  return probe(id, text, "Legendary Creature — Human");
}
const neutral = leader("Quiet Cartographer", "Partner");
const bodies = probe("Village Muster", "Create two 1/1 white Soldier creature tokens.", "Sorcery");
const treasure = probe("Buried Cache", "Create two Treasure tokens.", "Sorcery");
const clues = probe("Follow the Footprints", "Investigate.", "Sorcery");
const draw = probe("Patient Study", "Draw two cards.", "Sorcery");
const opponentDraw = probe("Opposing Counsel", "Each opponent draws two cards.", "Sorcery");
const gain = probe("Field Medicine", "You gain 3 life.", "Sorcery");
const drain = probe("Evening Toll", "Each opponent loses 3 life.", "Sorcery");
const discard = probe("Deliberate Discard", "Discard a card.", "Sorcery");
const mill = probe("Excavate Memories", "You mill three cards.", "Sorcery");
const opponentMill = probe("Erased Records", "Target opponent mills three cards.", "Sorcery");
const counters = probe("Bolster the Guard", "Put a +1/+1 counter on target creature.", "Sorcery");
const charges = probe("Residual Charge", "Put a charge counter on target creature.", "Sorcery");
const creatureOutlet = probe("Ashen Altar", "Sacrifice a creature: Add {C}{C}.", "Artifact");
const artifactOutlet = probe("Scrap Furnace", "Sacrifice an artifact: Add {C}{C}.", "Artifact");
const tapper = probe("Workshop Lever", "Tap an untapped artifact you control: Scry 1.", "Artifact");
const drawPayoff = probe("Ink Collector", "Whenever you draw a card, each opponent loses 1 life.");
const lifePayoff = probe("Restored Spirit", "Whenever you gain life, each opponent loses 1 life.");
const discardPayoff = probe(
  "Waste Collector",
  "Whenever you discard a card, each opponent loses 1 life.",
);
const sacrificePayoff = probe(
  "Offering Witness",
  "Whenever you sacrifice a permanent, each opponent loses 1 life.",
);
const deathPayoff = probe(
  "Mourning Witness",
  "Whenever another creature you control dies, each opponent loses 1 life.",
);
const tokenPayoff = probe(
  "Crowd Witness",
  "Whenever you create a token, each opponent loses 1 life.",
);
const recovery = probe(
  "Retrieve Memories",
  "Return target card from your graveyard to your hand.",
  "Sorcery",
);
const counterUser = probe(
  "Growing Battery",
  "Remove a +1/+1 counter from Growing Battery: Scry 1.",
);
const scry = probe("Study the Horizon", "Scry 2.", "Instant");
const ramp = probe("Stored Sunlight", "{T}: Add {C}{C}.", "Artifact");
const removal = probe("Clean Answer", "Destroy target creature.", "Instant");
const counterspell = probe("Close the Gate", "Counter target spell.", "Instant");
const protection = probe(
  "Shelter the Team",
  "Creatures you control gain indestructible until end of turn.",
  "Instant",
);
const wipe = probe("Reset the Field", "Destroy all creatures.", "Sorcery", 4);
const filler = probe("Plain Veteran", "Vigilance");
// Repeated functions, but distinct identities, keep every partial draft singleton.
const coveredSlots = Array.from({ length: 12 }, (_, i) =>
  probe(`Declared Utility Slot ${i + 1}`, "Vigilance"),
);
const topEnd = Array.from({ length: 30 }, (_, i) =>
  probe(`Towering Veteran ${i + 1}`, "Vigilance", "Creature — Giant", 8),
);
const rampPackage = Array.from({ length: 15 }, (_, i) =>
  probe(`Established Mana Rock ${i + 1}`, "{T}: Add {C}{C}.", "Artifact"),
);
const slowDraw = probe("Lengthy Research", "Draw two cards.", "Sorcery", 7);
const slowRemoval = probe("Unwieldy Answer", "Destroy target creature.", "Sorcery", 7);
const slowProtection = probe(
  "Late Shelter",
  "Creatures you control gain indestructible until end of turn.",
  "Instant",
  7,
);
const slowTokens = probe(
  "Distant Reinforcements",
  "Create two 1/1 white Soldier creature tokens.",
  "Sorcery",
  7,
);
const solRing = "6ad8011d-3471-4369-9d68-b264cc027487";
pool.set(
  solRing,
  rawCard("Sol Ring", "{T}: Add {C}{C}.", {
    oracle_id: solRing,
    id: "91fdb56b-54d5-4272-8319-505ff987fe9b",
    type_line: "Artifact",
    cmc: 1,
    mana_cost: "{1}",
    edhrec_rank: 1,
  }),
);

const creatureLeader = leader("Keeper of the Offering", "Sacrifice a creature: Scry 1.");
const tapLeader = leader("Keeper of the Workshop", "Tap an untapped artifact you control: Scry 1.");
const drawLeader = leader(
  "Keeper of the Library",
  "Whenever you draw a card, each opponent loses 1 life.",
);
const lifeLeader = leader(
  "Keeper of the Infirmary",
  "Whenever you gain life, each opponent loses 1 life.",
);
const discardLeader = leader(
  "Keeper of the Waste",
  "Whenever you discard a card, each opponent loses 1 life.",
);
const sacrificeLeader = leader(
  "Keeper of the Ritual",
  "Whenever you sacrifice a permanent, each opponent loses 1 life.",
);
const deathLeader = leader(
  "Keeper of the Crypt",
  "Whenever another creature you control dies, each opponent loses 1 life.",
);
const tokenLeader = leader(
  "Keeper of the Crowd",
  "Whenever you create a token, each opponent loses 1 life.",
);
const recoveryLeader = leader(
  "Keeper of Memories",
  "Return target card from your graveyard to your hand.",
);
const counterLeader = leader(
  "Keeper of Growth",
  "Remove a +1/+1 counter from Keeper of Growth: Scry 1.",
);
const partnerDraw = leader(
  "Inkbound Partner",
  "Partner\nWhenever you draw a card, each opponent loses 1 life.",
);
const partnerLife = leader(
  "Lifebound Partner",
  "Partner\nWhenever you gain life, each opponent loses 1 life.",
);
const partnerCreature = leader("Village Partner", "Partner\nSacrifice a creature: Scry 1.");
const partnerArtifact = leader(
  "Workshop Partner",
  "Partner\nTap an untapped artifact you control: Scry 1.",
);

type Family =
  | "token_sacrifice"
  | "token_tap"
  | "draw_trigger"
  | "lifegain_trigger"
  | "discard_trigger"
  | "sacrifice_trigger"
  | "death_trigger"
  | "token_trigger"
  | "graveyard_supply"
  | "counter_cost"
  | "roles"
  | "curve"
  | "intent"
  | "staple";
export interface PreferenceCase {
  id: string;
  family: Family;
  rationale: string;
  preferred: string;
  other: string;
  deck: Deck;
}
function deck(commander = neutral, library: string[] = [], patch: Partial<Deck> = {}): Deck {
  return {
    deck_id: "frozen-recommendation-preference",
    name: "Synthetic preference scenario",
    format: "commander",
    commanders: [commander],
    command_zone_kind: "single",
    cards: library.map((oracle_id) => ({ oracle_id, qty: 1 })),
    computed_color_identity: [],
    version: 1,
    data_snapshot: "2026-09-08",
    ...patch,
  };
}
function roleScenario(shortage: Role, saturated: Role): Deck {
  return deck(neutral, coveredSlots, {
    role_overrides: Object.fromEntries(coveredSlots.map((id) => [id, [saturated]])),
    intent: {
      schema_version: 1,
      soft: {
        role_targets: { [shortage]: { min: 10, max: 12 }, [saturated]: { min: 10, max: 12 } },
      },
    },
  });
}
function paired(second: string): Deck {
  return deck(neutral, [], { commanders: [neutral, second], command_zone_kind: "partner" });
}
function topHeavy(commander = neutral): Deck {
  return deck(commander, topEnd);
}
function intended(strategy: string): Deck {
  return deck(neutral, [], { intent: { schema_version: 1, soft: { strategy } } });
}
function saturatedRamp(commander: string): Deck {
  return deck(commander, rampPackage);
}
function preference(
  id: string,
  family: Family,
  rationale: string,
  preferred: string,
  other: string,
  state: Deck,
): PreferenceCase {
  return { id, family, rationale, preferred, other, deck: state };
}

/** Cases are explicit decisions, not generated from the support catalog or scorer. */
export const preferenceCases: readonly PreferenceCase[] = [
  preference(
    "creature-fodder",
    "token_sacrifice",
    "A creature sacrifice engine needs expendable creatures; Treasure alone cannot pay that cost.",
    bodies,
    treasure,
    deck(creatureLeader),
  ),
  preference(
    "artifact-tapping",
    "token_tap",
    "An artifact tapping engine can use Treasure, while ordinary Soldier tokens lack the artifact type.",
    treasure,
    bodies,
    deck(tapLeader),
  ),
  preference(
    "own-draw-events",
    "draw_trigger",
    "A payoff for our draws needs our draw spell rather than cards given only to opponents.",
    draw,
    opponentDraw,
    deck(drawLeader),
  ),
  preference(
    "gain-life-events",
    "lifegain_trigger",
    "Our life-gain payoff needs life gained, not simply life lost by opponents.",
    gain,
    drain,
    deck(lifeLeader),
  ),
  preference(
    "discard-not-mill",
    "discard_trigger",
    "Discarding supplies the discard commander's event; milling is a different action.",
    discard,
    mill,
    deck(discardLeader),
  ),
  preference(
    "sacrifice-action",
    "sacrifice_trigger",
    "A sacrifice outlet supplies actual sacrifice events; token creation alone does not.",
    artifactOutlet,
    treasure,
    deck(sacrificeLeader),
  ),
  preference(
    "creature-deaths",
    "death_trigger",
    "A creature sacrifice outlet supplies creature deaths; sacrificing arbitrary artifacts does not establish them.",
    creatureOutlet,
    artifactOutlet,
    deck(deathLeader),
  ),
  preference(
    "create-token-events",
    "token_trigger",
    "Creating Clues activates the token plan; placing counters does not create tokens.",
    clues,
    counters,
    deck(tokenLeader),
  ),
  preference(
    "own-graveyard",
    "graveyard_supply",
    "Unrestricted recovery from our graveyard benefits from self-mill rather than milling an opponent.",
    mill,
    opponentMill,
    deck(recoveryLeader),
  ),
  preference(
    "matching-counter-resource",
    "counter_cost",
    "The commander's +1/+1 counter cost needs the matching counter type on it.",
    counters,
    charges,
    deck(counterLeader),
  ),

  preference(
    "library-fodder-outlet",
    "token_sacrifice",
    "Existing Soldier production makes a creature sacrifice outlet usable; it cannot feed a counter-removal ability.",
    creatureOutlet,
    counterUser,
    deck(neutral, [bodies]),
  ),
  preference(
    "library-artifact-outlet",
    "token_tap",
    "Existing Clue production supplies an artifact tapper, but not creature sacrifice fodder.",
    tapper,
    creatureOutlet,
    deck(neutral, [clues]),
  ),
  preference(
    "library-draw-payoff",
    "draw_trigger",
    "The actual library contains draw supply, so a draw payoff has support and a life payoff does not.",
    drawPayoff,
    lifePayoff,
    deck(neutral, [draw]),
  ),
  preference(
    "library-life-payoff",
    "lifegain_trigger",
    "Changing only the library to life gain should favor its payoff over the same draw payoff.",
    lifePayoff,
    drawPayoff,
    deck(neutral, [gain]),
  ),
  preference(
    "library-discard-payoff",
    "discard_trigger",
    "A discard package supplies discard events, not token-created events.",
    discardPayoff,
    tokenPayoff,
    deck(neutral, [discard]),
  ),
  preference(
    "library-death-payoff",
    "death_trigger",
    "An existing creature outlet supports a death payoff without requiring token creation.",
    deathPayoff,
    tokenPayoff,
    deck(neutral, [creatureOutlet]),
  ),
  preference(
    "library-sacrifice-payoff",
    "sacrifice_trigger",
    "An artifact outlet supports sacrifice triggers, whereas creature deaths are not established.",
    sacrificePayoff,
    deathPayoff,
    deck(neutral, [artifactOutlet]),
  ),
  preference(
    "library-token-payoff",
    "token_trigger",
    "Changing the library to token creation should reverse the discard-versus-token payoff preference.",
    tokenPayoff,
    discardPayoff,
    deck(neutral, [treasure]),
  ),
  preference(
    "library-graveyard-use",
    "graveyard_supply",
    "Self-mill supplies unrestricted recovery; it gives a token payoff no event supply.",
    recovery,
    tokenPayoff,
    deck(neutral, [mill]),
  ),
  preference(
    "library-counter-use",
    "counter_cost",
    "Targeted +1/+1 counter placement supplies the counter consumer, while no artifacts are available for tapping.",
    counterUser,
    tapper,
    deck(neutral, [counters]),
  ),

  preference(
    "second-commander-draw",
    "draw_trigger",
    "With the first commander unchanged, the draw partner needs draw supply.",
    draw,
    gain,
    paired(partnerDraw),
  ),
  preference(
    "second-commander-life",
    "lifegain_trigger",
    "Swapping only the second commander to a life payoff should reverse draw-versus-life supply.",
    gain,
    draw,
    paired(partnerLife),
  ),
  preference(
    "second-commander-creatures",
    "token_sacrifice",
    "A second commander that consumes creatures prefers Soldier fodder over Clues.",
    bodies,
    clues,
    paired(partnerCreature),
  ),
  preference(
    "second-commander-artifacts",
    "token_tap",
    "Swapping only the second commander to an artifact tapper reverses the token-type preference.",
    clues,
    bodies,
    paired(partnerArtifact),
  ),

  preference(
    "short-ramp",
    "roles",
    "A ramp shortage matters more than another removal spell when removal already meets the declared target.",
    ramp,
    removal,
    roleScenario("ramp", "spot_removal"),
  ),
  preference(
    "short-removal",
    "roles",
    "The same candidate pair reverses when ramp is saturated and removal is missing.",
    removal,
    ramp,
    roleScenario("spot_removal", "ramp"),
  ),
  preference(
    "short-draw",
    "roles",
    "A library with sufficient counters but no draw should replenish cards first.",
    draw,
    counterspell,
    roleScenario("card_draw", "counterspell"),
  ),
  preference(
    "short-counters",
    "roles",
    "The same pair reverses when draw is covered and the declared counterspell target is unmet.",
    counterspell,
    draw,
    roleScenario("counterspell", "card_draw"),
  ),
  preference(
    "short-protection",
    "roles",
    "The declared protection shortage outranks extra recursion in a library already meeting its recursion target.",
    protection,
    recovery,
    roleScenario("protection", "recursion"),
  ),
  preference(
    "short-recursion",
    "roles",
    "The same pair reverses when protection is covered and recursion is missing.",
    recovery,
    protection,
    roleScenario("recursion", "protection"),
  ),
  preference(
    "short-sweepers",
    "roles",
    "A declared sweeper shortage needs a board wipe more than another saturated mana rock.",
    wipe,
    ramp,
    roleScenario("board_wipe", "ramp"),
  ),
  preference(
    "short-mana-over-sweeper",
    "roles",
    "The same pair reverses when sweepers are covered and ramp is missing.",
    ramp,
    wipe,
    roleScenario("ramp", "board_wipe"),
  ),

  preference(
    "top-heavy-draw",
    "curve",
    "A top-heavy library prefers cheap access to the same number of cards.",
    draw,
    slowDraw,
    topHeavy(),
  ),
  preference(
    "top-heavy-answer",
    "curve",
    "A top-heavy library prefers cheap spot removal to a much more expensive equivalent.",
    removal,
    slowRemoval,
    topHeavy(),
  ),
  preference(
    "top-heavy-protection",
    "curve",
    "Holding up the same team protection is easier at lower mana value in a top-heavy library.",
    protection,
    slowProtection,
    topHeavy(),
  ),
  preference(
    "top-heavy-fodder",
    "curve",
    "The sacrifice plan wants the same token supply earlier when its library is already expensive.",
    bodies,
    slowTokens,
    topHeavy(creatureLeader),
  ),

  preference(
    "declared-token-plan",
    "intent",
    "A declared tokens direction prefers token generation over an unrelated counter spell effect.",
    bodies,
    counters,
    intended("tokens"),
  ),
  preference(
    "declared-counter-plan",
    "intent",
    "Changing only declared intent to counters reverses that preference.",
    counters,
    bodies,
    intended("counters"),
  ),
  preference(
    "declared-scry-plan",
    "intent",
    "Declared scry intent gives a scry effect a purpose that self-mill does not fulfill.",
    scry,
    mill,
    intended("scry"),
  ),
  preference(
    "declared-graveyard-plan",
    "intent",
    "Changing declared intent to graveyard favors self-mill over scry.",
    mill,
    scry,
    intended("graveyard"),
  ),

  preference(
    "niche-fodder-over-staple",
    "staple",
    "With ramp already plentiful, supplying the creature-sacrifice commander's missing fodder is more relevant than Sol Ring's generic mana.",
    bodies,
    solRing,
    saturatedRamp(creatureLeader),
  ),
  preference(
    "niche-mill-over-staple",
    "staple",
    "With ramp already plentiful, stocking the recovery commander's graveyard matters more than another mana rock.",
    mill,
    solRing,
    saturatedRamp(recoveryLeader),
  ),
  preference(
    "niche-counters-over-staple",
    "staple",
    "With ramp already plentiful, matching the commander's counter cost is more relevant than Sol Ring.",
    counters,
    solRing,
    saturatedRamp(counterLeader),
  ),
  preference(
    "staple-when-ramp-is-needed",
    "staple",
    "Sol Ring remains appropriate when mana is missing and the alternative creature offers no established plan contribution.",
    solRing,
    filler,
    deck(),
  ),
];

export const preferenceCards = [...pool.values()];
export function preferenceName(id: string): string {
  const card = pool.get(id);
  if (!card) throw new Error(`Missing frozen preference card: ${id}`);
  return card.name;
}
