/** Evaluation-only oracle. Never import production legality, price, role or mana helpers here. */
import type { BenchmarkCase, BenchmarkEntry, BenchmarkFact } from "./corpus.js";

export interface DeckArtifact {
  commanders: string[];
  main: BenchmarkEntry[];
  companion?: string;
  maybeboard?: BenchmarkEntry[];
}
export interface GradeFailure {
  code: string;
  detail: string;
}
export interface GradeResult {
  passed: boolean;
  failures: GradeFailure[];
}
type Facts = Readonly<Record<string, BenchmarkFact>>;
export interface PriceEvidence {
  deckPriceCents: number | null;
  acquirePriceCents: number | null;
  companionPriceCents: number | null;
  knownDeckPriceCents: number;
  knownAcquirePriceCents: number;
  unknownPriceIds: string[];
}
export interface BenchmarkClaims {
  legal?: boolean;
  totalCards?: number;
  deckPriceCents?: number | null;
  acquirePriceCents?: number | null;
  companionPriceCents?: number | null;
  themeCounts?: Record<string, number>;
}

function deckEntries(artifact: DeckArtifact): BenchmarkEntry[] {
  return [...artifact.main, ...artifact.commanders.map((id) => ({ id, qty: 1 }))];
}
function quantities(entries: readonly BenchmarkEntry[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { id, qty } of entries) counts.set(id, (counts.get(id) ?? 0) + qty);
  return counts;
}
function canonical(entries: readonly BenchmarkEntry[]): string {
  return JSON.stringify([...quantities(entries)].sort(([a], [b]) => a.localeCompare(b)));
}
function themeCounts(artifact: DeckArtifact, facts: Facts): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const { id, qty } of artifact.main) {
    for (const role of facts[id]?.roles ?? []) counts[role] = (counts[role] ?? 0) + qty;
  }
  return counts;
}

/** Integer-cents reference. Ownership is consumed once across every copy, including commanders. */
export function priceDeck(
  artifact: DeckArtifact,
  facts: Facts,
  owned: Readonly<Record<string, number>> = {},
): PriceEvidence {
  let knownDeckPriceCents = 0;
  let knownAcquirePriceCents = 0;
  let incompleteAcquire = false;
  const unknownPriceIds: string[] = [];
  for (const [id, qty] of quantities(deckEntries(artifact))) {
    const cents = facts[id]?.priceCents;
    const missing = Math.max(0, qty - (owned[id] ?? 0));
    if (cents === null || cents === undefined) {
      unknownPriceIds.push(id);
      if (missing > 0) incompleteAcquire = true;
    } else {
      knownDeckPriceCents += cents * qty;
      knownAcquirePriceCents += cents * missing;
    }
  }
  return {
    deckPriceCents: unknownPriceIds.length ? null : knownDeckPriceCents,
    acquirePriceCents: incompleteAcquire ? null : knownAcquirePriceCents,
    companionPriceCents: artifact.companion ? (facts[artifact.companion]?.priceCents ?? null) : 0,
    knownDeckPriceCents,
    knownAcquirePriceCents,
    unknownPriceIds: unknownPriceIds.sort(),
  };
}

/** Grade authored constraints, not production validator conclusions or classifier labels. */
export function gradeDeck(
  scenario: BenchmarkCase,
  facts: Facts,
  artifact: DeckArtifact,
): GradeResult {
  const failures: GradeFailure[] = [];
  const fail = (code: string, detail: string) => failures.push({ code, detail });
  const entries = deckEntries(artifact);
  const all = [...entries, ...(artifact.companion ? [{ id: artifact.companion, qty: 1 }] : [])];
  for (const entry of [...all, ...(artifact.maybeboard ?? [])]) {
    if (!Number.isSafeInteger(entry.qty) || entry.qty <= 0)
      fail("QUANTITY", `${entry.id}: invalid quantity ${entry.qty}`);
    if (!facts[entry.id]) fail("UNKNOWN_CARD", entry.id);
  }
  const total = entries.reduce((sum, entry) => sum + entry.qty, 0);
  if (total !== 100)
    fail("CARD_COUNT", `expected 100 main plus commander cards, observed ${total}`);
  if (
    canonical(artifact.commanders.map((id) => ({ id, qty: 1 }))) !==
    canonical(scenario.commanders.map((id) => ({ id, qty: 1 })))
  ) {
    fail("COMMAND_ZONE", "commanders differ from the authored single or legal pairing");
  }
  if (artifact.companion !== scenario.companion)
    fail("COMPANION_ZONE", "outside-deck companion changed");
  if (canonical(artifact.maybeboard ?? []) !== canonical(scenario.maybeboard ?? []))
    fail("MAYBEBOARD", "outside-deck maybeboard changed");
  const authoredPair = scenario.expectedPair;
  const exactPair =
    authoredPair !== undefined &&
    canonical(authoredPair.map((id) => ({ id, qty: 1 }))) ===
      canonical(artifact.commanders.map((id) => ({ id, qty: 1 })));
  if (artifact.commanders.length !== 1 && !exactPair)
    fail("COMMAND_ZONE", "no authored legal pairing for this command zone");
  for (const id of artifact.commanders) {
    const fact = facts[id];
    if (fact && !fact.commander && !exactPair)
      fail("COMMANDER_ELIGIBILITY", `${id} cannot lead this command zone`);
  }
  const colors = new Set(artifact.commanders.flatMap((id) => facts[id]?.colors ?? []));
  const names = new Map<string, { count: number; cap: number | null }>();
  for (const { id, qty } of all) {
    const fact = facts[id];
    if (!fact) continue;
    if (!fact.legal) fail("LEGALITY", `${id} is not Commander legal in the frozen facts`);
    if (fact.colors.some((color) => !colors.has(color)))
      fail("COLOR_IDENTITY", `${id} exceeds commander identity`);
    const existing = names.get(fact.name);
    // Same-name aliases cannot evade the strictest authored copy cap.
    const caps = [existing?.cap, fact.maxCopies].filter(
      (cap): cap is number => typeof cap === "number",
    );
    names.set(fact.name, {
      count: (existing?.count ?? 0) + qty,
      cap: caps.length ? Math.min(...caps) : null,
    });
  }
  for (const [name, { count, cap }] of names) {
    if (cap !== null && count > cap)
      fail("COPY_LIMIT", `${name}: ${count} exceeds authored cap ${cap}`);
  }
  const observedCounts = quantities(entries);
  const initialCounts = quantities(scenario.startingMain);
  const targetCounts = quantities([
    ...scenario.main,
    ...scenario.commanders.map((id) => ({ id, qty: 1 })),
  ]);
  for (const id of scenario.protected) {
    const expected = initialCounts.get(id) ?? targetCounts.get(id) ?? 0;
    if ((observedCounts.get(id) ?? 0) !== expected)
      fail("PROTECTED", `${id}: preserve ${expected} copies`);
  }
  const roles = themeCounts(artifact, facts);
  for (const { role, min } of scenario.theme) {
    if ((roles[role] ?? 0) < min)
      fail("THEME", `${role}: ${roles[role] ?? 0} below authored minimum ${min}`);
  }
  if (scenario.budgetCents !== undefined) {
    const prices = priceDeck(artifact, facts, scenario.owned);
    const cost =
      scenario.request === "acquisition" ? prices.acquirePriceCents : prices.deckPriceCents;
    if (cost === null || cost > scenario.budgetCents)
      fail(
        "BUDGET",
        `${scenario.request}: cost ${cost ?? "unknown"}; cap ${scenario.budgetCents} cents`,
      );
  }
  return { passed: failures.length === 0, failures };
}

const LEGAL_FAILURES = new Set([
  "CARD_COUNT",
  "QUANTITY",
  "UNKNOWN_CARD",
  "COMMAND_ZONE",
  "COMMANDER_ELIGIBILITY",
  "COLOR_IDENTITY",
  "LEGALITY",
  "COPY_LIMIT",
]);

/** Reject plausible but incorrect output claims using the independently priced artifact. */
export function gradeClaims(
  scenario: BenchmarkCase,
  facts: Facts,
  artifact: DeckArtifact,
  claims: BenchmarkClaims,
): GradeResult {
  const failures: GradeFailure[] = [];
  const compare = (code: string, observed: unknown, expected: unknown) => {
    if (observed !== expected)
      failures.push({
        code,
        detail: `claimed ${JSON.stringify(observed)}; expected ${JSON.stringify(expected)}`,
      });
  };
  const price = priceDeck(artifact, facts, scenario.owned);
  if (claims.deckPriceCents !== undefined)
    compare("DECK_PRICE", claims.deckPriceCents, price.deckPriceCents);
  if (claims.acquirePriceCents !== undefined)
    compare("ACQUIRE_PRICE", claims.acquirePriceCents, price.acquirePriceCents);
  if (claims.companionPriceCents !== undefined)
    compare("COMPANION_PRICE", claims.companionPriceCents, price.companionPriceCents);
  if (claims.totalCards !== undefined)
    compare(
      "CLAIMED_COUNT",
      claims.totalCards,
      deckEntries(artifact).reduce((sum, entry) => sum + entry.qty, 0),
    );
  if (claims.legal !== undefined)
    compare(
      "CLAIMED_LEGALITY",
      claims.legal,
      !gradeDeck(scenario, facts, artifact).failures.some((failure) =>
        LEGAL_FAILURES.has(failure.code),
      ),
    );
  const roles = themeCounts(artifact, facts);
  for (const [role, claimed] of Object.entries(claims.themeCounts ?? {}))
    compare("CLAIMED_THEME", claimed, roles[role] ?? 0);
  return { passed: failures.length === 0, failures };
}
