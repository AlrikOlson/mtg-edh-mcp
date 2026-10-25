import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  MPC_POKER_BLEED_PX,
  MPC_POKER_HEIGHT_PX,
  MPC_POKER_WIDTH_PX,
  MPC_TRIM_HEIGHT_PX,
  MPC_TRIM_WIDTH_PX,
  SCRYFALL_PNG_HEIGHT_PX,
  SCRYFALL_PNG_WIDTH_PX,
  meetsPokerTemplate,
  prepareCardImage,
  readImageDimensions,
} from "./imagePrep.js";

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 255 };
const RED: Rgba = { r: 255, g: 0, b: 0, a: 255 };
const CLEAR: Rgba = { r: 0, g: 0, b: 0, a: 0 };

/**
 * A card-like PNG: a solid border colour, an inset content rectangle, and
 * transparent rounded corners the way Scryfall's png version has them.
 */
async function cardLikePng(
  width: number,
  height: number,
  options: { border?: Rgba; content?: Rgba; inset?: number; cornerRadius?: number } = {},
): Promise<Buffer> {
  const border = options.border ?? BLACK;
  const content = options.content ?? RED;
  const inset = options.inset ?? 30;
  const radius = options.cornerRadius ?? 30;
  const raw = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const inside = x >= inset && x < width - inset && y >= inset && y < height - inset;
      let pixel = inside ? content : border;
      const cx = x < radius ? radius : x >= width - radius ? width - radius - 1 : x;
      const cy = y < radius ? radius : y >= height - radius ? height - radius - 1 : y;
      if ((cx !== x || cy !== y) && Math.hypot(x - cx, y - cy) > radius) pixel = CLEAR;
      const offset = (y * width + x) * 4;
      raw[offset] = pixel.r;
      raw[offset + 1] = pixel.g;
      raw[offset + 2] = pixel.b;
      raw[offset + 3] = pixel.a;
    }
  }
  return sharp(raw, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
}

async function pixelAt(bytes: Uint8Array, x: number, y: number): Promise<Rgba> {
  const { data } = await sharp(bytes)
    .ensureAlpha()
    .extract({ left: x, top: y, width: 1, height: 1 })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { r: data[0] ?? 0, g: data[1] ?? 0, b: data[2] ?? 0, a: data[3] ?? 0 };
}

function near(actual: Rgba, expected: Rgba, tolerance = 8): void {
  expect(Math.abs(actual.r - expected.r)).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(actual.g - expected.g)).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(actual.b - expected.b)).toBeLessThanOrEqual(tolerance);
  expect(actual.a).toBe(expected.a);
}

describe("MakePlayingCards poker template constants", () => {
  it("pins the published template: 822 x 1122 with 36 px of bleed per side around a 750 x 1050 trim", () => {
    expect([MPC_POKER_WIDTH_PX, MPC_POKER_HEIGHT_PX]).toEqual([822, 1122]);
    expect(MPC_POKER_BLEED_PX).toBe(36);
    expect(MPC_TRIM_WIDTH_PX).toBe(MPC_POKER_WIDTH_PX - 2 * MPC_POKER_BLEED_PX);
    expect(MPC_TRIM_HEIGHT_PX).toBe(MPC_POKER_HEIGHT_PX - 2 * MPC_POKER_BLEED_PX);
    expect([SCRYFALL_PNG_WIDTH_PX, SCRYFALL_PNG_HEIGHT_PX]).toEqual([745, 1040]);
  });

  it("accepts the template size and larger, and rejects anything smaller in either dimension", () => {
    expect(meetsPokerTemplate({ width: 822, height: 1122 })).toBe(true);
    expect(meetsPokerTemplate({ width: 1644, height: 2244 })).toBe(true);
    expect(meetsPokerTemplate({ width: 821, height: 1122 })).toBe(false);
    expect(meetsPokerTemplate({ width: 822, height: 1121 })).toBe(false);
    expect(meetsPokerTemplate({ width: 745, height: 1040 })).toBe(false);
  });
});

describe("prepareCardImage", () => {
  it("brings a Scryfall-sized 745 x 1040 face to 822 x 1122 with the content inside the safe area and the border extended as bleed", async () => {
    const source = await cardLikePng(SCRYFALL_PNG_WIDTH_PX, SCRYFALL_PNG_HEIGHT_PX);
    const prepared = await prepareCardImage(source);

    expect(prepared.treatment).toBe("bled");
    expect(prepared.source).toEqual({ width: 745, height: 1040 });
    expect([prepared.width, prepared.height]).toEqual([822, 1122]);
    expect(await readImageDimensions(prepared.bytes)).toEqual({ width: 822, height: 1122 });

    // Bleed: the 36 px frame on every side carries the border colour.
    near(await pixelAt(prepared.bytes, 10, 561), BLACK);
    near(await pixelAt(prepared.bytes, 811, 561), BLACK);
    near(await pixelAt(prepared.bytes, 411, 10), BLACK);
    near(await pixelAt(prepared.bytes, 411, 1111), BLACK);
    // The transparent corners are flattened onto the border colour, never left clear.
    near(await pixelAt(prepared.bytes, 2, 2), BLACK);
    near(await pixelAt(prepared.bytes, 819, 1119), BLACK);
    // Safe area: the trimmed card starts at the bleed offset; its own border is still there.
    near(await pixelAt(prepared.bytes, MPC_POKER_BLEED_PX + 4, 561), BLACK);
    near(await pixelAt(prepared.bytes, 411, MPC_POKER_BLEED_PX + 4), BLACK);
    // The 30 px inset content lands just past the scaled inset (30 * 750 / 745).
    near(await pixelAt(prepared.bytes, MPC_POKER_BLEED_PX + 40, MPC_POKER_BLEED_PX + 40), RED);
    near(await pixelAt(prepared.bytes, 411, 561), RED);
    near(
      await pixelAt(prepared.bytes, 822 - MPC_POKER_BLEED_PX - 40, 1122 - MPC_POKER_BLEED_PX - 40),
      RED,
    );
  });

  it("passes an exact-fit 822 x 1122 image through unchanged", async () => {
    const source = await cardLikePng(MPC_POKER_WIDTH_PX, MPC_POKER_HEIGHT_PX, {
      border: { r: 20, g: 40, b: 60, a: 255 },
      cornerRadius: 0,
    });
    const prepared = await prepareCardImage(source);

    expect(prepared.treatment).toBe("passthrough");
    expect([prepared.width, prepared.height]).toEqual([822, 1122]);
    expect(Buffer.from(prepared.bytes).equals(source)).toBe(true);
  });

  it("samples a non-black border so a white-bordered card gets white bleed", async () => {
    const white: Rgba = { r: 255, g: 255, b: 255, a: 255 };
    const source = await cardLikePng(SCRYFALL_PNG_WIDTH_PX, SCRYFALL_PNG_HEIGHT_PX, {
      border: white,
      content: { r: 0, g: 0, b: 255, a: 255 },
    });
    const prepared = await prepareCardImage(source);
    near(await pixelAt(prepared.bytes, 10, 561), white);
    near(await pixelAt(prepared.bytes, 2, 2), white);
  });

  it("prepares a smaller or larger trimmed card by scaling it to the trim before adding bleed", async () => {
    const small = await prepareCardImage(await cardLikePng(488, 680));
    expect([small.width, small.height]).toEqual([822, 1122]);
    expect(small.treatment).toBe("bled");
    const large = await prepareCardImage(await cardLikePng(1500, 2100));
    expect([large.width, large.height]).toEqual([822, 1122]);
    near(await pixelAt(large.bytes, 411, 561), RED);
  });

  it("rejects bytes that are not an image", async () => {
    await expect(
      readImageDimensions(new TextEncoder().encode("<html>not an image</html>")),
    ).rejects.toThrow();
    await expect(prepareCardImage(new Uint8Array([1, 2, 3]))).rejects.toThrow();
  });
});
