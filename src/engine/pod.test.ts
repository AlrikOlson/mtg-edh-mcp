import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, expect, it } from "vitest";
import { z } from "zod";
import { DeckStore } from "../deck/deckStore.js";
import type { Deck } from "../types/index.js";
import { captureCatalog } from "./catalog.js";
import {
  baselineCatalogFixture,
  catalogFixture,
  type CatalogFixture,
} from "./catalogFixture.test-support.js";
import { capturePod, commanderAdmission, physicalId, podDigest, POD_SEATS } from "./pod.js";
import { assertCompatibleHello, WorkerFrameDecoder } from "./protocol.js";
import {
  AdmissionSchema,
  CatalogPayloadSchema,
  ENGINE_VERSION,
  PROTOCOL_VERSION,
  SCHEMA_SHA256,
  type CatalogPayload,
  type Limits,
  type Policy,
  type Response,
} from "./protocol.generated.js";

const binary = process.env.MTG_WORKER_BINARY;
const native = it.skipIf(!binary);

const LIMITS: Limits = {
  trials: 1,
  concurrency: 1,
  max_turns: 10,
  max_actions: 10_000,
  max_actions_per_turn: 1_000,
  max_work: 1_000_000,
  max_elapsed_ms: 30_000,
  max_memory_bytes: 100_000_000,
  max_output_bytes: 1_000_000,
};
const policy = (id: string): Policy => ({
  id,
  version: "1",
  observation_version: "1",
  search_nodes: 1,
});
const POLICIES = [
  policy("fixture-baseline"),
  policy("fixture-pass"),
  policy("fixture-baseline"),
  policy("fixture-pass"),
];

async function rulesDigest(): Promise<string> {
  return z
    .object({ rules: z.object({ sha256: z.string() }) })
    .parse(
      JSON.parse(
        await readFile(
          new URL("../../engine/contract/preview-fixture.json", import.meta.url),
          "utf8",
        ),
      ),
    ).rules.sha256;
}

/**
 * Two authored decks over one synthetic index: `deck-1` (the fixture's
 * commander and 99 islands) and `deck-2` (a second legendary creature and 99
 * forests), both legal by the construction authority.
 */
async function twoDeckFixture(): Promise<{
  f: CatalogFixture;
  store: DeckStore;
  first: Deck;
  second: Deck;
}> {
  const base = CatalogPayloadSchema.parse(
    JSON.parse(
      await readFile(
        new URL("../../engine/contract/catalog-fixture.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  const rename = (record: CatalogPayload["records"][number], oracle_id: string, name: string) => {
    const copy = structuredClone(record);
    copy.oracle_id = oracle_id;
    copy.gameplay.source = { scryfall_id: `p-${oracle_id}`, oracle_id };
    copy.printing_ids = [`p-${oracle_id}`];
    copy.gameplay.characteristics.name = name;
    if (copy.gameplay.faces?.[0]) copy.gameplay.faces[0].characteristics.name = name;
    return copy;
  };
  const commander = base.records[0]!;
  const island = base.records[1]!;
  commander.gameplay.characteristics.type_line = "Legendary Creature — Elemental";
  commander.gameplay.faces![0]!.characteristics.type_line = "Legendary Creature — Elemental";
  island.gameplay.characteristics.type_line = "Basic Land — Island";
  island.gameplay.color_identity = ["U"];
  commander.gameplay.color_identity = ["B", "G", "U"];
  const titania = rename(commander, "commander-2", "Titania");
  titania.gameplay.color_identity = ["G"];
  const forest = rename(island, "forest", "Forest");
  forest.gameplay.characteristics.type_line = "Basic Land — Forest";
  forest.gameplay.color_identity = ["G"];
  const f = await catalogFixture({ ...base, records: [commander, island, titania, forest] });
  let next = 0;
  const store = new DeckStore({ newId: () => `deck-${(next += 1)}` });
  const author = (deck: Omit<Deck, "deck_id" | "version" | "name" | "format">): Deck => {
    const created = store.create({ name: "Authored", dataSnapshot: deck.data_snapshot });
    return store.update(created.deck_id, (current) => ({ ...current, ...deck }));
  };
  const first = author({
    commanders: ["commander"],
    command_zone_kind: "single",
    cards: [{ oracle_id: "island", qty: 99 }],
    // The identity authority orders colors W U B R G.
    computed_color_identity: ["U", "B", "G"],
    data_snapshot: base.data_snapshot,
  });
  const second = author({
    commanders: ["commander-2"],
    command_zone_kind: "single",
    cards: [{ oracle_id: "forest", qty: 99 }],
    computed_color_identity: ["G"],
    data_snapshot: base.data_snapshot,
  });
  return { f, store, first, second };
}

let fixture: Awaited<ReturnType<typeof twoDeckFixture>>;
beforeEach(async () => {
  fixture = await twoDeckFixture();
});
afterEach(async () => {
  await fixture.f.close();
});

function seatInputs(decks: readonly Deck[]) {
  return decks.map((deck) => ({ deckId: deck.deck_id, expectedVersion: deck.version }));
}

function options(decks: readonly Deck[]) {
  const { f, store } = fixture;
  return {
    index: f.index,
    deckStore: store,
    expectedIndexRevision: f.index.revision(),
    snapshot: f.snapshot.provider,
    seats: seatInputs(decks),
  };
}

it("captures each authored deck version once and binds every seat to its own capture", () => {
  const { f, store, first, second } = fixture;
  const result = capturePod(options([first, second, first, second]));
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.code);
  const { pod } = result;
  expect(pod.decks).toHaveLength(2);
  expect(pod.seats.map((seat) => seat.deck)).toEqual([0, 1, 0, 1]);
  expect(pod.seats.map((seat) => seat.deck_id)).toEqual([
    first.deck_id,
    second.deck_id,
    first.deck_id,
    second.deck_id,
  ]);
  expect(pod.seats.map((seat) => seat.version)).toEqual([2, 2, 2, 2]);
  // Each capture is exactly what the per-deck owner captures on its own.
  for (const [index, deck] of [first, second].entries()) {
    const single = captureCatalog({
      index: f.index,
      deckStore: store,
      deckId: deck.deck_id,
      expectedVersion: deck.version,
      expectedIndexRevision: f.index.revision(),
      snapshot: f.snapshot.provider,
    });
    if (!single.ok) throw new Error(single.code);
    expect(pod.decks[index]).toEqual(single.envelope);
    expect(pod.seats[index]?.deck_digest).toBe(single.envelope.payload_digest);
  }
  expect(pod.catalog_digest).toBe(podDigest(pod.decks.map((deck) => deck.payload_digest)));
  expect(pod.catalog_digest).not.toBe(pod.decks[0]?.payload_digest);
  expect(pod.data_snapshot).toBe(first.data_snapshot);
  expect(pod.index_revision).toBe(f.index.revision());
  expect(pod.payloads[1]?.deck.commanders[0]?.oracle_id).toBe("commander-2");
  expect(Object.isFrozen(pod)).toBe(true);
  expect(Object.isFrozen(pod.seats)).toBe(true);

  // A mirror pod is one capture named by every seat; a reordered pod is another pod.
  const mirror = capturePod(options([first, first, first, first]));
  if (!mirror.ok) throw new Error(mirror.code);
  expect(mirror.pod.decks).toHaveLength(1);
  expect(mirror.pod.seats.map((seat) => seat.deck)).toEqual([0, 0, 0, 0]);
  const reordered = capturePod(options([second, first, second, first]));
  if (!reordered.ok) throw new Error(reordered.code);
  expect(reordered.pod.catalog_digest).not.toBe(pod.catalog_digest);
  expect(new Set(reordered.pod.decks.map((deck) => deck.payload_digest))).toEqual(
    new Set(pod.decks.map((deck) => deck.payload_digest)),
  );
});

it("refuses a seat the per-deck owner refuses, naming the seat, and never substitutes a deck", () => {
  const { store, first, second } = fixture;
  expect(capturePod(options([first, second, first]))).toEqual({
    ok: false,
    code: "invalid_pod",
    seat: null,
    violations: [],
  });
  const stale = options([first, second, first, second]);
  stale.seats[2] = { deckId: first.deck_id, expectedVersion: first.version + 1 };
  expect(capturePod(stale)).toMatchObject({ ok: false, code: "stale_deck", seat: 2 });
  const missing = options([first, second, first, second]);
  missing.seats[3] = { deckId: "absent", expectedVersion: 1 };
  expect(capturePod(missing)).toMatchObject({ ok: false, code: "missing_deck", seat: 3 });
  // A seat whose authored deck is illegal refuses the pod with that seat's verdict.
  const illegal = store.update(second.deck_id, (deck) => ({
    ...deck,
    cards: [{ oracle_id: "forest", qty: 98 }],
  }));
  const construction = capturePod(options([first, illegal, first, second]));
  expect(construction).toMatchObject({ ok: false, code: "invalid_construction", seat: 1 });
  if (construction.ok) throw new Error("unreachable");
  expect(construction.violations.length).toBeGreaterThan(0);
  // A version behind the current one is refused for the seat that named it.
  expect(capturePod(options([first, second, first, second]))).toMatchObject({
    ok: false,
    code: "stale_deck",
    seat: 1,
  });
});

it("builds a Commander admission whose seats play their own physical copies of their own decks", async () => {
  const { first, second } = fixture;
  const result = capturePod(options([first, second, first, second]));
  if (!result.ok) throw new Error(result.code);
  const admission = commanderAdmission({
    pod: result.pod,
    scenarioId: "mixed-pod",
    rulesDigest: await rulesDigest(),
    seed: "0123456789abcdef",
    limits: LIMITS,
    policies: POLICIES,
    implementationVersion: "core-support-v1",
  });
  expect(AdmissionSchema.safeParse(admission).success).toBe(true);
  expect(Object.isFrozen(admission)).toBe(true);
  if (admission.scenario.type !== "commander" || admission.catalog.type !== "commander")
    throw new Error("a Commander admission");
  expect(admission.catalog.data.decks).toEqual(result.pod.decks);
  const scenario = admission.scenario.data;
  expect(scenario.engine_version).toBe(ENGINE_VERSION);
  expect(scenario.snapshot_digest).toBe(result.pod.catalog_digest);
  expect(scenario.seats).toHaveLength(POD_SEATS);
  const physical = new Set<string>();
  for (const [index, seat] of scenario.seats.entries()) {
    const deck = index % 2 === 0 ? first : second;
    const land = index % 2 === 0 ? "island" : "forest";
    expect(seat.seat).toBe(index);
    expect(seat.policy).toEqual(POLICIES[index]);
    expect(seat.deck_digest).toBe(result.pod.decks[index % 2]?.payload_digest);
    expect(seat.cards).toHaveLength(100);
    expect(seat.commanders).toEqual([physicalId(index, deck.commanders[0]!, 0)]);
    expect(seat.cards[0]).toEqual({
      physical_id: physicalId(index, deck.commanders[0]!, 0),
      oracle_id: deck.commanders[0],
    });
    for (const [copy, card] of seat.cards.slice(1).entries()) {
      expect(card).toEqual({ physical_id: physicalId(index, land, copy), oracle_id: land });
    }
    for (const card of seat.cards) {
      expect(physical.has(card.physical_id)).toBe(false);
      physical.add(card.physical_id);
    }
  }
  expect(physical.size).toBe(400);
  expect(() =>
    commanderAdmission({
      pod: result.pod,
      scenarioId: "short",
      rulesDigest: "0".repeat(64),
      seed: "0123456789abcdef",
      limits: LIMITS,
      policies: POLICIES.slice(0, 3),
      implementationVersion: "core-support-v1",
    }),
  ).toThrow(RangeError);
});

const hello = {
  request_id: "h-1",
  message: {
    type: "hello",
    data: {
      protocol_version: PROTOCOL_VERSION,
      engine_version: ENGINE_VERSION,
      schema_sha256: SCHEMA_SHA256,
    },
  },
};
const line = (value: unknown) => Buffer.from(JSON.stringify(value) + "\n");

/** Acceptance harness only; the production supervisor owns real runs. */
async function run(input: Buffer): Promise<Response[]> {
  if (!binary) throw new Error("MTG_WORKER_BINARY is required for native acceptance");
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ["--protocol"], {
      stdio: ["pipe", "pipe", "pipe"],
      signal: AbortSignal.timeout(10_000),
    });
    const decoder = new WorkerFrameDecoder();
    const replies: Response[] = [];
    let diagnostics = "";
    child.stdout.on("data", (chunk: Buffer) => {
      try {
        replies.push(...decoder.push(chunk));
      } catch (error) {
        child.kill("SIGKILL");
        reject(error);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      diagnostics += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) => {
      try {
        decoder.finish();
        expect(code).toBe(0);
        expect(diagnostics).toBe("");
        resolve(replies);
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.on("error", reject);
    child.stdin.end(input);
  });
}

native(
  "admits a mixed pod of the real Muldrotha deck and a second authored deck to the pinned worker, refused once per distinct identity",
  async () => {
    const f = await baselineCatalogFixture();
    try {
      // A second deck over the same served records: Izoni leads the black and
      // green cards of the baseline, filled with Swamps and Forests to 99.
      const izoni = "5a210b32-6e1f-4578-bd8b-4e481b761159";
      const swamp = "56719f6a-1a6c-4c0a-8d21-18f7d7350b68";
      const forest = "b34bb2dc-c1af-4d77-b0b3-a0fb342a5fc6";
      const inIdentity = (oracle_id: string) => {
        const card = f.index.getCard(oracle_id);
        if (!card) throw new Error(`missing ${oracle_id}`);
        return card.color_identity.every((color) => color === "B" || color === "G");
      };
      const kept = f.deck.cards
        .filter((entry) => entry.oracle_id !== izoni && inIdentity(entry.oracle_id))
        .filter((entry) => entry.oracle_id !== swamp && entry.oracle_id !== forest);
      const fill = 99 - kept.reduce((n, entry) => n + entry.qty, 0);
      const swamps = Math.floor(fill / 2);
      const secondCards = [
        ...kept,
        { oracle_id: swamp, qty: swamps },
        { oracle_id: forest, qty: fill - swamps },
      ];
      let next = 0;
      const store = new DeckStore({ newId: () => `pod-deck-${(next += 1)}` });
      const author = (deck: Pick<Deck, "commanders" | "cards" | "computed_color_identity">) => {
        const created = store.create({ name: "Authored", dataSnapshot: f.deck.data_snapshot });
        return store.update(created.deck_id, (current) => ({
          ...current,
          ...deck,
          command_zone_kind: "single",
        }));
      };
      const first = author({
        commanders: [...f.deck.commanders],
        cards: f.deck.cards.map(({ oracle_id, qty }) => ({ oracle_id, qty })),
        computed_color_identity: f.deck.computed_color_identity,
      });
      const second = author({
        commanders: [izoni],
        cards: secondCards,
        computed_color_identity: ["B", "G"],
      });
      const captured = capturePod({
        index: f.index,
        deckStore: store,
        expectedIndexRevision: f.index.revision(),
        snapshot: f.snapshot.provider,
        seats: seatInputs([first, second, first, second]),
      });
      if (!captured.ok) throw new Error(JSON.stringify(captured));
      const { pod } = captured;
      expect(pod.decks).toHaveLength(2);
      expect(pod.payloads[1]?.deck.commanders[0]?.oracle_id).toBe(izoni);
      const admission = commanderAdmission({
        pod,
        scenarioId: "muldrotha-mixed-pod",
        rulesDigest: await rulesDigest(),
        seed: "0123456789abcdef",
        limits: LIMITS,
        policies: POLICIES,
        implementationVersion: "core-support-v1",
      });
      const replies = await run(
        Buffer.concat([
          line(hello),
          line({ request_id: "pod", message: { type: "admit", data: admission } }),
        ]),
      );
      expect(replies.map((reply) => reply.request_id)).toEqual(["h-1", "pod"]);
      assertCompatibleHello(replies[0]!, "h-1");
      const outcome = replies[1]?.message;
      if (outcome?.type !== "outcome" || outcome.data.type !== "unsupported")
        throw new Error(JSON.stringify(outcome));
      const diagnostics = z
        .array(
          z.object({
            code: z.string(),
            oracle_id: z.string().optional(),
            physical_id: z.string().optional(),
          }),
        )
        .parse(outcome.data.data.diagnostics);
      // Every distinct identity across both captures once, in capture order
      // then deck order: the second deck adds none the first did not carry.
      const expected = [...pod.payloads[0]!.deck.commanders, ...pod.payloads[0]!.deck.cards].map(
        (entry) => entry.oracle_id,
      );
      const secondIdentities = [
        ...pod.payloads[1]!.deck.commanders,
        ...pod.payloads[1]!.deck.cards,
      ].map((entry) => entry.oracle_id);
      expect(secondIdentities.every((oracle_id) => expected.includes(oracle_id))).toBe(true);
      expect(diagnostics.map((d) => d.oracle_id)).toEqual(expected);
      expect(diagnostics).toHaveLength(f.source.records.length);
      for (const diagnostic of diagnostics) {
        expect(diagnostic.code).toBe("card_unsupported");
        expect(diagnostic.physical_id).toBeUndefined();
      }
      expect(replies.some((reply) => reply.message.type === "admitted")).toBe(false);
    } finally {
      await f.close();
    }
  },
);
