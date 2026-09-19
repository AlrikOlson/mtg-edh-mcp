/**
 * Capture an independently authored Commander pod for the internal worker.
 *
 * Every seat names one authored deck version; each distinct version is
 * captured once through the per-deck capture owner ({@link captureCatalog}:
 * the deck store, the pinned index read, the served snapshot label, the
 * identity authority and the construction validator), under one index read
 * so all captures share one revision. The pod is the list of those captures
 * in first-seat order; a seat binds to its capture through the capture's
 * digest and the scenario binds to the ordered pod through the pod digest
 * (SHA-256 over the capture digests in order), exactly as worker contract 7
 * defines it. Success is never play admission: the worker still qualifies
 * every card and may refuse the pod.
 */
import { createHash } from "node:crypto";
import type { CardIndex } from "../index/cardIndex.js";
import type { DeckStore } from "../deck/deckStore.js";
import type { SnapshotProvider } from "../server/snapshot.js";
import type { Violation } from "../types/index.js";
import { captureCatalog, type CatalogCaptureResult } from "./catalog.js";
import {
  AdmissionSchema,
  CatalogPayloadSchema,
  ENGINE_VERSION,
  type Admission,
  type CatalogEnvelope,
  type CatalogPayload,
  type Limits,
  type Policy,
} from "./protocol.generated.js";

/** A Commander pod has exactly four seats (worker contract `CommanderScenario`). */
export const POD_SEATS = 4;

export interface PodSeatInput {
  readonly deckId: string;
  /** The authored version the caller reviewed; any other version is refused. */
  readonly expectedVersion: number;
  /** Optional printing choice per Oracle identity for this seat's deck. */
  readonly printings?: Readonly<Record<string, string>>;
}

export interface PodCaptureOptions {
  readonly index: CardIndex;
  readonly deckStore: DeckStore;
  readonly session?: string;
  readonly expectedIndexRevision: string;
  readonly snapshot: SnapshotProvider;
  /** One authored deck version per seat, in seat order. */
  readonly seats: readonly PodSeatInput[];
}

/** One seat of a captured pod: which capture it plays. */
export interface CapturedPodSeat {
  readonly seat: number;
  /** Position of the seat's capture in {@link CapturedPod.decks}. */
  readonly deck: number;
  readonly deck_id: string;
  readonly version: number;
  readonly deck_digest: string;
}

export interface CapturedPod {
  /** Distinct captures in first-seat order; a version several seats play appears once. */
  readonly decks: readonly CatalogEnvelope[];
  /** The captured payloads, parsed once, in the same order as `decks`. */
  readonly payloads: readonly CatalogPayload[];
  readonly seats: readonly CapturedPodSeat[];
  /** SHA-256 over the captures' digests in order: the scenario's `snapshot_digest`. */
  readonly catalog_digest: string;
  readonly data_snapshot: string;
  readonly index_revision: string;
  /** Construction warnings per capture, as the validator reported them. */
  readonly violations: readonly (readonly Violation[])[];
}

type CaptureFailure = Extract<CatalogCaptureResult, { ok: false }>;
export type PodCaptureError = CaptureFailure["code"] | "invalid_pod";
export type PodCaptureResult =
  | { ok: true; pod: CapturedPod }
  | {
      ok: false;
      code: PodCaptureError;
      /** The seat whose capture failed; null when the pod shape itself is refused. */
      seat: number | null;
      violations: Violation[];
    };

/** The pod's catalog digest as worker contract 7 defines it. */
export function podDigest(captureDigests: readonly string[]): string {
  const hash = createHash("sha256");
  for (const digest of captureDigests) hash.update(digest, "utf8");
  return hash.digest("hex");
}

/**
 * Capture every seat's authored deck version once, under one pinned index
 * read. A seat whose deck cannot be captured refuses the whole pod with that
 * seat and the capture owner's code; nothing is substituted.
 */
export function capturePod(options: PodCaptureOptions): PodCaptureResult {
  if (options.seats.length !== POD_SEATS)
    return { ok: false, code: "invalid_pod", seat: null, violations: [] };
  return options.index.withRead(() => {
    const decks: CatalogEnvelope[] = [];
    const payloads: CatalogPayload[] = [];
    const violations: Violation[][] = [];
    const seats: CapturedPodSeat[] = [];
    for (const [seat, input] of options.seats.entries()) {
      const captured = captureCatalog({
        index: options.index,
        deckStore: options.deckStore,
        deckId: input.deckId,
        ...(options.session === undefined ? {} : { session: options.session }),
        expectedVersion: input.expectedVersion,
        expectedIndexRevision: options.expectedIndexRevision,
        snapshot: options.snapshot,
        ...(input.printings === undefined ? {} : { printings: input.printings }),
      });
      if (!captured.ok)
        return { ok: false, code: captured.code, seat, violations: captured.violations };
      const digest = captured.envelope.payload_digest;
      let deck = decks.findIndex((existing) => existing.payload_digest === digest);
      if (deck < 0) {
        deck = decks.length;
        decks.push(captured.envelope);
        payloads.push(CatalogPayloadSchema.parse(JSON.parse(captured.envelope.payload_json)));
        violations.push([...captured.violations]);
      }
      seats.push({
        seat,
        deck,
        deck_id: captured.envelope.expected_deck_id,
        version: captured.envelope.expected_deck_version,
        deck_digest: digest,
      });
    }
    const first = payloads[0];
    if (!first) return { ok: false, code: "invalid_pod", seat: null, violations: [] };
    return {
      ok: true,
      pod: deepFreeze({
        decks,
        payloads,
        seats,
        catalog_digest: podDigest(decks.map((deck) => deck.payload_digest)),
        data_snapshot: first.data_snapshot,
        index_revision: first.index_revision,
        violations,
      }),
    };
  });
}

export interface PodAdmissionInput {
  readonly pod: CapturedPod;
  readonly scenarioId: string;
  /** The engine's official rules snapshot digest (the preview fixture's). */
  readonly rulesDigest: string;
  readonly seed: string;
  readonly limits: Limits;
  /** One named client per seat, in seat order. */
  readonly policies: readonly Policy[];
  readonly implementationVersion: string;
  readonly implementationDigest?: string | null;
}

/**
 * The physical id of one copy of an Oracle identity at a seat. Every seat's
 * cards are its own; the engine's setup owner allocates the objects.
 */
export function physicalId(seat: number, oracleId: string, copy: number): string {
  return `s${seat}-${oracleId}-${copy}`;
}

/**
 * Build the Commander admission for a captured pod: each seat lists every
 * physical copy of every entry of its own deck (commanders first, then the
 * main deck, in captured order), names its commanders among them, binds to
 * its capture through `deck_digest`, and the scenario binds to the ordered
 * pod through `snapshot_digest`. Nothing here judges construction or
 * executability.
 */
export function commanderAdmission(input: PodAdmissionInput): Admission {
  const { pod } = input;
  if (input.policies.length !== pod.seats.length)
    throw new RangeError(`a pod of ${pod.seats.length} seats needs one policy per seat`);
  const seats = pod.seats.map((seat) => {
    const payload = pod.payloads[seat.deck];
    if (!payload) throw new RangeError(`seat ${seat.seat} names no capture`);
    const copies = new Map<string, number>();
    const instance = (oracle_id: string) => {
      const copy = copies.get(oracle_id) ?? 0;
      copies.set(oracle_id, copy + 1);
      return { physical_id: physicalId(seat.seat, oracle_id, copy), oracle_id };
    };
    const commanders = payload.deck.commanders.flatMap((entry) =>
      Array.from({ length: entry.qty }, () => instance(entry.oracle_id)),
    );
    const cards = payload.deck.cards.flatMap((entry) =>
      Array.from({ length: entry.qty }, () => instance(entry.oracle_id)),
    );
    return {
      seat: seat.seat,
      deck_digest: seat.deck_digest,
      policy: input.policies[seat.seat],
      commanders: commanders.map((card) => card.physical_id),
      cards: [...commanders, ...cards],
    };
  });
  return deepFreeze(
    AdmissionSchema.parse({
      scenario: {
        type: "commander",
        data: {
          scenario_id: input.scenarioId,
          engine_version: ENGINE_VERSION,
          snapshot_digest: pod.catalog_digest,
          rules_digest: input.rulesDigest,
          seats,
          seed: input.seed,
          limits: input.limits,
        },
      },
      catalog: { type: "commander", data: { decks: pod.decks } },
      expected_implementation_version: input.implementationVersion,
      expected_implementation_digest: input.implementationDigest ?? null,
    }),
  );
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
