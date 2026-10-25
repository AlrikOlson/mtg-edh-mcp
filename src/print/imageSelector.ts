/**
 * Print image selector (Proxy Order Helper, step 3).
 *
 * For every face the manifest names, decide where its image comes from,
 * obtain the bytes, and leave one print-ready file in the job directory, or
 * say exactly why that face has no image. It reads the manifest owner's
 * faces and the job store's per-slot choices, fetches Scryfall images only
 * through the existing live client, and prepares catalog images with
 * {@link prepareCardImage}. It never picks a different card than the one in
 * the slot: a chosen printing that is not one of the card's printings is
 * reported, not replaced, and a community search is only accepted when a
 * single image carries exactly the face's name.
 *
 * Precedence per face: the slot's recorded choice (the preset, or an explicit
 * prepare-time choice, as the job store merged them) -> for the back of a
 * two-sided card, the printing already chosen for its front -> the
 * deterministic default printing from the catalog -> the optional community
 * source -> an attention item.
 *
 * Files: `<job_dir>/cache/scryfall/<scryfall_id>[-back].png` keep the fetched
 * bytes so a re-prepare and repeated copies cost one request per face;
 * `<job_dir>/images/slot-<nnn>-<face>.<ext>` and `card-back.<ext>` are what
 * the project file will reference. The selector creates the job directory.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { ScryfallImageFace } from "../ingest/live.js";
import { StructuredError } from "../types/errors.js";
import type { Card, Printing } from "../types/index.js";
import type { CardLookup } from "../validate/index.js";
import { communityQuery, type CommunityCandidate, type CommunityImageSource } from "./community.js";
import {
  MPC_POKER_HEIGHT_PX,
  MPC_POKER_WIDTH_PX,
  meetsPokerTemplate,
  prepareCardImage,
  readImageDimensions,
  type PreparedTreatment,
} from "./imagePrep.js";
import type { PrintImageRef, PrintSlotImages } from "./jobStore.js";
import type { PrintCard, PrintManifest } from "./manifest.js";

export type ImageAttentionKind =
  | "no_printing"
  | "printing_mismatch"
  | "no_image"
  | "undersized_image"
  | "unreadable_file"
  | "source_unavailable"
  | "image_service_unavailable"
  | "ambiguous_match";

/** A face without an image, and why; the slot stays in the order. */
export interface ImageAttentionItem {
  kind: ImageAttentionKind;
  /** The manifest slot, or null for the card back. */
  slot: number | null;
  face: ScryfallImageFace;
  /** The card's oracle_id, or `card_back`. */
  ref: string;
  message: string;
  /** For `ambiguous_match`: the community images that carry the face's exact name. */
  candidates?: readonly CommunityCandidate[];
}

/** `as_is`: a user file copied unchanged after the dimension check. */
export type PreparedFaceTreatment = PreparedTreatment | "as_is";

/** One print-ready image file. */
export interface PreparedFace {
  path: string;
  width: number;
  height: number;
  treatment: PreparedFaceTreatment;
  /** The reference the file was produced from. */
  source: PrintImageRef;
}

export interface ResolvedSlot {
  front: PreparedFace | null;
  back: PreparedFace | null;
  /** The references actually chosen (defaults filled in), for the job record. */
  chosen: PrintSlotImages;
}

export interface PrintImageResolution {
  /** Keyed by manifest slot, as the job store keys images. */
  slots: Record<string, ResolvedSlot>;
  card_back: PreparedFace | null;
  attention: ImageAttentionItem[];
  /** True when every face and the chosen card back has a file. */
  complete: boolean;
}

export interface ResolvePrintImagesInput {
  manifest: PrintManifest;
  /** The job's per-slot choices; a missing slot resolves as unchosen. */
  images: Readonly<Record<string, PrintSlotImages>>;
  /** The job's card back choice; null leaves the printer's default. */
  card_back: PrintImageRef | null;
  job_dir: string;
  lookup: CardLookup;
}

/** The part of LiveScryfallClient the selector uses. */
export interface FaceImageFetcher {
  getCardImage(scryfallId: string, options?: { face?: ScryfallImageFace }): Promise<Uint8Array>;
}

export interface ImageSelectorDeps {
  scryfall: FaceImageFetcher;
  /** Optional secondary source; absent or null means no community lookups. */
  community?: CommunityImageSource | null;
}

const CACHE_DIRECTORY = join("cache", "scryfall");
const IMAGES_DIRECTORY = "images";

function compareCollectorNumbers(a: string, b: string): number {
  const na = Number.parseInt(a, 10);
  const nb = Number.parseInt(b, 10);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return a.localeCompare(b, "en");
}

/**
 * The printing used when the user has not chosen one: the newest release,
 * then the alphabetically first set code, then the lowest collector number.
 * Independent of catalog order, so stable for a given data snapshot.
 */
export function defaultPrinting(card: Card): Printing | null {
  const sorted = [...card.printings].sort((a, b) => {
    const ra = a.released_at ?? "";
    const rb = b.released_at ?? "";
    if (ra !== rb) {
      if (ra === "") return 1;
      if (rb === "") return -1;
      return rb.localeCompare(ra, "en");
    }
    if (a.set !== b.set) return a.set.localeCompare(b.set, "en");
    return compareCollectorNumbers(a.collector_number, b.collector_number);
  });
  return sorted[0] ?? null;
}

type FaceOutcome =
  { kind: "ready"; face: PreparedFace } | { kind: "attention"; item: ImageAttentionItem };

interface FaceTarget {
  slot: number | null;
  face: ScryfallImageFace;
  ref: string;
  /** Printed name of the face, for community search and messages. */
  name: string;
  /** File stem under images/, without extension. */
  stem: string;
}

type Choice = { kind: "ref"; ref: PrintImageRef } | { kind: "attention"; item: ImageAttentionItem };

class Resolver {
  private readonly cacheDir: string;
  private readonly imagesDir: string;
  private readonly searches = new Map<string, Promise<CommunityCandidate[]>>();

  constructor(
    private readonly input: ResolvePrintImagesInput,
    private readonly deps: ImageSelectorDeps,
  ) {
    this.cacheDir = join(input.job_dir, CACHE_DIRECTORY);
    this.imagesDir = join(input.job_dir, IMAGES_DIRECTORY);
  }

  async run(): Promise<PrintImageResolution> {
    // The job directory holds the user's artwork; keep it private to the user.
    await mkdir(this.input.job_dir, { recursive: true, mode: 0o700 });
    await mkdir(this.cacheDir, { recursive: true, mode: 0o700 });
    await mkdir(this.imagesDir, { recursive: true, mode: 0o700 });
    const attention: ImageAttentionItem[] = [];
    const slots: Record<string, ResolvedSlot> = {};
    const { manifest } = this.input;
    const physical: PrintCard[] = [
      ...manifest.cards,
      ...(manifest.extras.companion ? [manifest.extras.companion] : []),
    ];
    for (const printCard of physical) {
      const resolved = await this.resolveSlot(printCard, attention);
      slots[String(printCard.slot)] = resolved;
    }
    let card_back: PreparedFace | null = null;
    if (this.input.card_back) {
      const outcome = await this.materialize(this.input.card_back, {
        slot: null,
        face: "front",
        ref: "card_back",
        name: "card back",
        stem: "card-back",
      });
      if (outcome.kind === "ready") card_back = outcome.face;
      else attention.push(outcome.item);
    }
    return { slots, card_back, attention, complete: attention.length === 0 };
  }

  private async resolveSlot(
    printCard: PrintCard,
    attention: ImageAttentionItem[],
  ): Promise<ResolvedSlot> {
    const card = this.input.lookup(printCard.oracle_id);
    const recorded = this.input.images[String(printCard.slot)] ?? { front: null, back: null };
    const stem = `slot-${String(printCard.slot).padStart(3, "0")}`;
    const chosen: PrintSlotImages = { front: null, back: null };
    const result: ResolvedSlot = { front: null, back: null, chosen };

    const frontTarget: FaceTarget = {
      slot: printCard.slot,
      face: "front",
      ref: printCard.oracle_id,
      name: printCard.front.name,
      stem: `${stem}-front`,
    };
    const frontChoice = await this.choose(card, printCard, frontTarget, recorded.front, null);
    if (frontChoice.kind === "attention") attention.push(frontChoice.item);
    else {
      chosen.front = frontChoice.ref;
      const outcome = await this.materialize(frontChoice.ref, frontTarget);
      if (outcome.kind === "ready") result.front = outcome.face;
      else attention.push(outcome.item);
    }

    if (printCard.back !== null) {
      const backTarget: FaceTarget = {
        slot: printCard.slot,
        face: "back",
        ref: printCard.oracle_id,
        name: printCard.back.name,
        stem: `${stem}-back`,
      };
      const backChoice = await this.choose(
        card,
        printCard,
        backTarget,
        recorded.back,
        chosen.front,
      );
      if (backChoice.kind === "attention") attention.push(backChoice.item);
      else {
        chosen.back = backChoice.ref;
        const outcome = await this.materialize(backChoice.ref, backTarget);
        if (outcome.kind === "ready") result.back = outcome.face;
        else attention.push(outcome.item);
      }
    }
    return result;
  }

  /** Decide the reference for one face without fetching anything. */
  private async choose(
    card: Card | null,
    printCard: PrintCard,
    target: FaceTarget,
    recorded: PrintImageRef | null,
    frontChoice: PrintImageRef | null,
  ): Promise<Choice> {
    if (recorded) {
      if (
        recorded.kind === "printing" &&
        card &&
        !card.printings.some((p) => p.scryfall_id === recorded.scryfall_id)
      ) {
        return {
          kind: "attention",
          item: this.item(
            "printing_mismatch",
            target,
            `The chosen printing ${recorded.scryfall_id} is not a printing of ${printCard.name}; choose one of its printings or a file. Nothing was substituted.`,
          ),
        };
      }
      return { kind: "ref", ref: recorded };
    }
    if (target.face === "back" && frontChoice?.kind === "printing") {
      return { kind: "ref", ref: frontChoice };
    }
    const fallback = card ? defaultPrinting(card) : null;
    if (fallback)
      return { kind: "ref", ref: { kind: "printing", scryfall_id: fallback.scryfall_id } };
    if (!this.deps.community) {
      const why = card
        ? `The catalog lists no printings for ${printCard.name}`
        : `There is no catalog record for ${printCard.oracle_id}`;
      return {
        kind: "attention",
        item: this.item(
          "no_printing",
          target,
          `${why}; supply an image file for this slot or configure the community image source.`,
        ),
      };
    }
    return this.chooseFromCommunity(target);
  }

  private async chooseFromCommunity(target: FaceTarget): Promise<Choice> {
    const community = this.deps.community;
    if (!community) throw new Error("community source required");
    const wanted = communityQuery(target.name);
    let candidates: CommunityCandidate[];
    try {
      let pending = this.searches.get(wanted);
      if (!pending) {
        pending = community.search(target.name);
        this.searches.set(wanted, pending);
      }
      candidates = await pending;
    } catch (error) {
      this.searches.delete(wanted);
      return {
        kind: "attention",
        item: this.item(
          "image_service_unavailable",
          target,
          `The community image service could not be searched for ${target.name}: ${describe(error)}. Retry later or supply a file.`,
        ),
      };
    }
    const exact = candidates.filter((c) => communityQuery(c.name) === wanted);
    if (exact.length === 1 && exact[0]) {
      return { kind: "ref", ref: { kind: "community", id: exact[0].id } };
    }
    if (exact.length > 1) {
      return {
        kind: "attention",
        item: {
          ...this.item(
            "ambiguous_match",
            target,
            `${exact.length} community images are named ${target.name}; choose one by its identifier.`,
          ),
          candidates: exact,
        },
      };
    }
    return {
      kind: "attention",
      item: this.item(
        "no_image",
        target,
        `No catalog printing and no community image is named exactly ${target.name}; supply a file for this slot.`,
      ),
    };
  }

  /** Turn a chosen reference into a file under images/, or an attention item. */
  private async materialize(ref: PrintImageRef, target: FaceTarget): Promise<FaceOutcome> {
    switch (ref.kind) {
      case "printing":
        return this.fromPrinting(ref, target);
      case "file":
        return this.fromFile(ref, target);
      case "community":
        return this.fromCommunity(ref, target);
      default: {
        const never: never = ref;
        throw new Error(`unknown image ref ${JSON.stringify(never)}`);
      }
    }
  }

  private async fromPrinting(
    ref: Extract<PrintImageRef, { kind: "printing" }>,
    target: FaceTarget,
  ): Promise<FaceOutcome> {
    const suffix = target.face === "back" ? "-back" : "";
    const cachePath = join(this.cacheDir, `${ref.scryfall_id}${suffix}.png`);
    let bytes: Uint8Array;
    try {
      bytes = await readFile(cachePath);
    } catch {
      try {
        bytes = await this.deps.scryfall.getCardImage(ref.scryfall_id, { face: target.face });
      } catch (error) {
        return this.scryfallFailure(error, ref.scryfall_id, target);
      }
      await writeFileAtomically(cachePath, bytes);
    }
    try {
      return await this.prepared(bytes, ref, target);
    } catch (error) {
      return {
        kind: "attention",
        item: this.item(
          "source_unavailable",
          target,
          `Scryfall's image for printing ${ref.scryfall_id} could not be decoded: ${describe(error)}.`,
        ),
      };
    }
  }

  private scryfallFailure(error: unknown, scryfallId: string, target: FaceTarget): FaceOutcome {
    if (error instanceof StructuredError) {
      if (error.code === "UNKNOWN_CARD") {
        return {
          kind: "attention",
          item: this.item(
            "no_image",
            target,
            `Scryfall has no image for printing ${scryfallId}; choose another printing or supply a file.`,
          ),
        };
      }
      const details = error.details as { status?: number } | undefined;
      if (error.code === "UPSTREAM_UNAVAILABLE" && details?.status === 422) {
        return {
          kind: "attention",
          item: this.item(
            "no_image",
            target,
            `Scryfall serves no ${target.face} face image for printing ${scryfallId}; supply a file for this face.`,
          ),
        };
      }
    }
    return {
      kind: "attention",
      item: this.item(
        "source_unavailable",
        target,
        `Scryfall could not be reached for printing ${scryfallId}: ${describe(error)}. Retry later.`,
      ),
    };
  }

  private async fromFile(
    ref: Extract<PrintImageRef, { kind: "file" }>,
    target: FaceTarget,
  ): Promise<FaceOutcome> {
    let bytes: Uint8Array;
    let dimensions: { width: number; height: number };
    try {
      bytes = await readFile(ref.path);
      dimensions = await readImageDimensions(bytes);
    } catch (error) {
      return {
        kind: "attention",
        item: this.item(
          "unreadable_file",
          target,
          `The file ${ref.path} could not be read as an image: ${describe(error)}.`,
        ),
      };
    }
    if (!meetsPokerTemplate(dimensions)) {
      return {
        kind: "attention",
        item: this.item(
          "undersized_image",
          target,
          `The file ${ref.path} is ${dimensions.width} x ${dimensions.height} pixels; a print-ready image with bleed must be at least ${MPC_POKER_WIDTH_PX} x ${MPC_POKER_HEIGHT_PX}. Supply a larger file, or choose a catalog printing to have bleed added.`,
        ),
      };
    }
    const extension = extname(ref.path).toLowerCase() || ".png";
    const path = join(this.imagesDir, `${target.stem}${extension}`);
    await writeFileAtomically(path, bytes);
    return {
      kind: "ready",
      face: {
        path,
        width: dimensions.width,
        height: dimensions.height,
        treatment: "as_is",
        source: ref,
      },
    };
  }

  private async fromCommunity(
    ref: Extract<PrintImageRef, { kind: "community" }>,
    target: FaceTarget,
  ): Promise<FaceOutcome> {
    const community = this.deps.community;
    if (!community) {
      return {
        kind: "attention",
        item: this.item(
          "image_service_unavailable",
          target,
          `Community image ${ref.id} was chosen but no community image source is configured.`,
        ),
      };
    }
    try {
      const bytes = await community.download(ref.id);
      return await this.prepared(bytes, ref, target);
    } catch (error) {
      return {
        kind: "attention",
        item: this.item(
          "image_service_unavailable",
          target,
          `Community image ${ref.id} could not be downloaded: ${describe(error)}. Retry later or supply a file.`,
        ),
      };
    }
  }

  private async prepared(
    bytes: Uint8Array,
    source: PrintImageRef,
    target: FaceTarget,
  ): Promise<FaceOutcome> {
    const image = await prepareCardImage(bytes);
    const path = join(this.imagesDir, `${target.stem}.png`);
    await writeFileAtomically(path, image.bytes);
    return {
      kind: "ready",
      face: { path, width: image.width, height: image.height, treatment: image.treatment, source },
    };
  }

  private item(kind: ImageAttentionKind, target: FaceTarget, message: string): ImageAttentionItem {
    return { kind, slot: target.slot, face: target.face, ref: target.ref, message };
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Write `bytes` through a temporary file and rename, so a reader never sees a partial file. */
export async function writeFileAtomically(path: string, bytes: Uint8Array): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, bytes);
  await rename(temporary, path);
}

/**
 * Resolve and prepare every face of the manifest into `job_dir`, reporting
 * each face that has no image. Never throws for a single face; only an
 * unusable job directory fails the whole call.
 */
export function resolvePrintImages(
  input: ResolvePrintImagesInput,
  deps: ImageSelectorDeps,
): Promise<PrintImageResolution> {
  return new Resolver(input, deps).run();
}
