/** Trusted immutable internal input only. Authored decks use captureCatalog. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { digestEvaluation } from "../evaluation/registration.js";
import {
  CatalogGameplaySchema,
  DigestSchema,
  IdSchema,
  PositiveSchema,
  PreviewCatalogEnvelopeSchema,
  PreviewCatalogPayloadSchema,
  PREVIEW_FIXTURE_ID,
  PREVIEW_FIXTURE_VERSION,
  PREVIEW_FIXTURE_DIGEST,
} from "./protocol.generated.js";

// This projects a checked build artifact, never caller-supplied source or a support certificate.
const fixtureProjection = z.object({
  fixture_id: IdSchema,
  fixture_version: PositiveSchema,
  data_snapshot: IdSchema,
  rules: z.object({ sha256: DigestSchema }),
  cards: z.array(
    z.object({
      oracle_id: IdSchema,
      qty: PositiveSchema,
      source: CatalogGameplaySchema,
    }),
  ),
});

/** No caller-selected path, catalog, profile, deck, credentials or overrides. */
export async function capturePreviewFixture(...unexpected: never[]) {
  if (unexpected.length) throw new TypeError("preview_fixture_takes_no_inputs");
  const raw: unknown = JSON.parse(
    await readFile(new URL("../../engine/contract/preview-fixture.json", import.meta.url), "utf8"),
  );
  if (digestEvaluation(raw) !== PREVIEW_FIXTURE_DIGEST)
    throw new Error("preview_fixture_digest_mismatch");
  const fixture = fixtureProjection.parse(raw);
  const payload = PreviewCatalogPayloadSchema.parse({
    schema_version: 1,
    data_snapshot: fixture.data_snapshot,
    index_revision: PREVIEW_FIXTURE_DIGEST,
    fixture_id: PREVIEW_FIXTURE_ID,
    fixture_version: PREVIEW_FIXTURE_VERSION,
    fixture_digest: PREVIEW_FIXTURE_DIGEST,
    cards: fixture.cards.map(({ oracle_id, qty, source }) => ({
      oracle_id,
      qty,
      printing_id: source.source.scryfall_id,
    })),
    records: fixture.cards.map(({ oracle_id, source: gameplay }) => ({
      oracle_id,
      gameplay,
      printing_ids: gameplay.source.scryfall_id ? [gameplay.source.scryfall_id] : [],
    })),
  });
  const payload_json = JSON.stringify(payload);
  const data = Object.freeze(
    PreviewCatalogEnvelopeSchema.parse({
      payload_json,
      payload_digest: createHash("sha256").update(payload_json, "utf8").digest("hex"),
      expected_index_revision: PREVIEW_FIXTURE_DIGEST,
      expected_fixture_id: PREVIEW_FIXTURE_ID,
      expected_fixture_version: PREVIEW_FIXTURE_VERSION,
    }),
  );
  return Object.freeze({
    catalog: Object.freeze({ type: "preview_fixture" as const, data }),
    rules_digest: fixture.rules.sha256,
    fixture_digest: PREVIEW_FIXTURE_DIGEST,
  });
}
