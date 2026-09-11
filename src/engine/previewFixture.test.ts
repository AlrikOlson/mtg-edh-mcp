import { expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { capturePreviewFixture } from "./previewFixture.js";
import { captureCatalog } from "./catalog.js";
import { catalogFixture } from "./catalogFixture.test-support.js";
import {
  CatalogEnvelopeSchema,
  PreviewCatalogPayloadSchema,
  PREVIEW_FIXTURE_DIGEST,
} from "./protocol.generated.js";
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual: typeof fs = await importOriginal();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});
it("captures only the fixed six-card internal fixture as immutable generated data", async () => {
  const captured = await capturePreviewFixture();
  expect(captured.catalog.type).toBe("preview_fixture");
  const envelope = captured.catalog.data;
  const payload = PreviewCatalogPayloadSchema.parse(JSON.parse(envelope.payload_json));
  expect(payload.fixture_digest).toBe(PREVIEW_FIXTURE_DIGEST);
  expect(payload.cards.map(({ qty }) => qty)).toEqual([3, 3]);
  expect(payload.records.map(({ gameplay }) => gameplay.characteristics.name)).toEqual([
    "Forest",
    "Grizzly Bears",
  ]);
  expect(payload).not.toHaveProperty("deck");
  expect(payload).not.toHaveProperty("commanders");
  expect(envelope.payload_digest).toBe(
    createHash("sha256").update(envelope.payload_json).digest("hex"),
  );
  expect(Object.isFrozen(captured)).toBe(true);
  expect(Object.isFrozen(captured.catalog)).toBe(true);
  expect(Object.isFrozen(envelope)).toBe(true);
  expect(CatalogEnvelopeSchema.safeParse(envelope).success).toBe(false);
  expect(await capturePreviewFixture()).toEqual(captured);
});
it("rejects all caller inputs including fixture credentials and authored decks", async () => {
  for (const input of [
    { fixture_id: "forest-bears-internal-v1" },
    { deckId: "authored" },
    { permissive: true },
    null,
  ])
    await expect(Reflect.apply(capturePreviewFixture, undefined, [input])).rejects.toThrow(
      "preview_fixture_takes_no_inputs",
    );
});
it("rejects changed artifact bytes rather than issuing new fixture credentials", async () => {
  const file = await fs.readFile(
    new URL("../../engine/contract/preview-fixture.json", import.meta.url),
    "utf8",
  );
  const changed = JSON.parse(file);
  changed.cards[0].qty++;
  vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(changed));
  await expect(capturePreviewFixture()).rejects.toThrow("preview_fixture_digest_mismatch");
});
it("cannot turn an invalid authored Commander deck into a preview capture", async () => {
  const f = await catalogFixture();
  try {
    f.deck.cards[0]!.qty = 6;
    expect(
      captureCatalog({
        ...f.options(),
        ...{
          profile: "preview_fixture",
          fixture_digest: PREVIEW_FIXTURE_DIGEST,
        },
      }),
    ).toMatchObject({ ok: false, code: "invalid_construction" });
    await expect(Reflect.apply(capturePreviewFixture, undefined, [f.options()])).rejects.toThrow(
      "preview_fixture_takes_no_inputs",
    );
  } finally {
    await f.close();
  }
});
