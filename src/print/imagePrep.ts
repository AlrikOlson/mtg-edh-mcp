/**
 * Print image preparation (Proxy Order Helper, step 3a).
 *
 * Brings a card image to the MakePlayingCards poker template. The published
 * template (makeplayingcards.com/faq-photo.aspx, read 2026-10-25) is 822 x
 * 1122 pixels at 300 DPI: 36 px of bleed are cut from every side, leaving the
 * 750 x 1050 trimmed card (2.5 x 3.5 inches), and a further 36 px inside the
 * cut is the safe area for text. Scryfall's png face images are 745 x 1040
 * trimmed cards with transparent rounded corners and no bleed.
 *
 * A catalog image is therefore treated as a trimmed card: its transparent
 * corners are flattened onto the sampled border colour, it is resampled to
 * the trim, and the border is extended by 36 px per side so the printer's
 * cut lands on bleed rather than on the card frame. An image already exactly
 * the template size passes through unchanged. Dimension checks live here too
 * so every owner measures printability the same way.
 *
 * Image decoding, resampling and encoding use sharp (libvips); the dependency
 * decision and its footprint are recorded in
 * docs/architecture/print-order-helper.md.
 */
import sharp, { type Sharp } from "sharp";

/** MakePlayingCards poker template at 300 DPI. */
export const MPC_POKER_WIDTH_PX = 822;
export const MPC_POKER_HEIGHT_PX = 1122;
/** Cut from every side of the upload; the same width is the safe-area inset inside the cut. */
export const MPC_POKER_BLEED_PX = 36;
/** The trimmed card the cut leaves: 2.5 x 3.5 inches at 300 DPI. */
export const MPC_TRIM_WIDTH_PX = MPC_POKER_WIDTH_PX - 2 * MPC_POKER_BLEED_PX;
export const MPC_TRIM_HEIGHT_PX = MPC_POKER_HEIGHT_PX - 2 * MPC_POKER_BLEED_PX;

/** Scryfall's `png` image version (docs/api/images), a trimmed card without bleed. */
export const SCRYFALL_PNG_WIDTH_PX = 745;
export const SCRYFALL_PNG_HEIGHT_PX = 1040;

export interface ImageDimensions {
  width: number;
  height: number;
}

/** How a prepared image relates to its source. */
export type PreparedTreatment = "passthrough" | "bled";

export interface PreparedImage {
  /** PNG bytes at the template size. */
  bytes: Uint8Array;
  width: number;
  height: number;
  treatment: PreparedTreatment;
  /** The decoded source dimensions. */
  source: ImageDimensions;
}

/** The pixel dimensions of an encoded image; throws when the bytes are not an image sharp can read. */
export async function readImageDimensions(bytes: Uint8Array): Promise<ImageDimensions> {
  const metadata = await sharp(bytes).metadata();
  const { width, height } = metadata;
  if (!width || !height) throw new Error("The image has no readable dimensions.");
  // Rotated EXIF orientations swap the printed axes.
  const rotated = metadata.orientation !== undefined && metadata.orientation >= 5;
  return rotated ? { width: height, height: width } : { width, height };
}

/** True when the image is at least the poker template in both dimensions. */
export function meetsPokerTemplate(dimensions: ImageDimensions): boolean {
  return dimensions.width >= MPC_POKER_WIDTH_PX && dimensions.height >= MPC_POKER_HEIGHT_PX;
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

/**
 * The card's border colour: the most common opaque colour among samples
 * taken just inside each edge, away from the rounded corners. Falls back to
 * black, the border of nearly every printed card.
 */
async function sampleBorderColour(image: Sharp, dimensions: ImageDimensions): Promise<Rgb> {
  const { width, height } = dimensions;
  const { data, info } = await image
    .clone()
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const inset = Math.max(1, Math.round(Math.min(width, height) * 0.004));
  const points: Array<[number, number]> = [];
  for (const fraction of [0.3, 0.5, 0.7]) {
    const x = Math.floor(width * fraction);
    const y = Math.floor(height * fraction);
    points.push([x, inset], [x, height - 1 - inset], [inset, y], [width - 1 - inset, y]);
  }
  const counts = new Map<string, { colour: Rgb; count: number }>();
  for (const [x, y] of points) {
    const offset = (y * info.width + x) * info.channels;
    const alpha = data[offset + 3] ?? 255;
    if (alpha < 128) continue;
    const colour = { r: data[offset] ?? 0, g: data[offset + 1] ?? 0, b: data[offset + 2] ?? 0 };
    // Quantise so JPEG noise votes together.
    const key = [colour.r, colour.g, colour.b].map((v) => Math.round(v / 16)).join(",");
    const entry = counts.get(key) ?? { colour, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
  }
  let best: { colour: Rgb; count: number } | undefined;
  for (const entry of counts.values()) {
    if (!best || entry.count > best.count) best = entry;
  }
  return best?.colour ?? { r: 0, g: 0, b: 0 };
}

/**
 * Prepare a trimmed card image for the poker template: flatten, resample to
 * the trim and extend the border as bleed. An exact 822 x 1122 input is
 * returned as-is. Rejects bytes that are not a decodable image.
 */
export async function prepareCardImage(bytes: Uint8Array): Promise<PreparedImage> {
  const source = await readImageDimensions(bytes);
  if (source.width === MPC_POKER_WIDTH_PX && source.height === MPC_POKER_HEIGHT_PX) {
    return { bytes, width: source.width, height: source.height, treatment: "passthrough", source };
  }
  const image = sharp(bytes).rotate();
  const border = await sampleBorderColour(image, source);
  const prepared = await image
    .flatten({ background: border })
    .resize(MPC_TRIM_WIDTH_PX, MPC_TRIM_HEIGHT_PX, { fit: "fill", kernel: "lanczos3" })
    .extend({
      top: MPC_POKER_BLEED_PX,
      bottom: MPC_POKER_BLEED_PX,
      left: MPC_POKER_BLEED_PX,
      right: MPC_POKER_BLEED_PX,
      extendWith: "copy",
    })
    .png()
    .toBuffer();
  return {
    bytes: prepared,
    width: MPC_POKER_WIDTH_PX,
    height: MPC_POKER_HEIGHT_PX,
    treatment: "bled",
    source,
  };
}
