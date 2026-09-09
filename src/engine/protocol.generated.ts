// @generated from canonical mtg-worker/protocol/contract.json; do not edit.
export const SCHEMA_SHA256 = "a2ad875393c2afaa91de9331f0574848117758c29038d83a8fa0371424e3569e";
import { z } from "zod";

const isWellFormed = (value: string): boolean => Array.from(value).every((character) => { const point = character.codePointAt(0) ?? 0; return point < 0xd800 || point > 0xdfff; });

export const PROTOCOL_VERSION = 3;

export const ENGINE_VERSION = "0.1.0";

export const MAX_FRAME_BYTES = 2097152;

export const IdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]*$(?![\s\S])/);
export type Id = z.infer<typeof IdSchema>;

export const DigestSchema = z.string().min(64).max(64).regex(/^[0-9a-f]*$(?![\s\S])/);
export type Digest = z.infer<typeof DigestSchema>;

export const SeedSchema = z.string().min(16).max(16).regex(/^[0-9a-f]*$(?![\s\S])/);
export type Seed = z.infer<typeof SeedSchema>;

export const TextSchema = z.string().min(1).max(1024).regex(/^[\x20-\x7e]*$(?![\s\S])/);
export type Text = z.infer<typeof TextSchema>;

export const CountSchema = z.number().int().min(0).max(4294967295);
export type Count = z.infer<typeof CountSchema>;

export const PositiveSchema = z.number().int().min(1).max(4294967295);
export type Positive = z.infer<typeof PositiveSchema>;

export const SeatSchema = z.number().int().min(0).max(3);
export type Seat = z.infer<typeof SeatSchema>;

export const FrameLimitSchema = z.number().int().min(1).max(2097152);
export type FrameLimit = z.infer<typeof FrameLimitSchema>;

export const FlagSchema = z.boolean();
export type Flag = z.infer<typeof FlagSchema>;

export const EmptySchema = z.strictObject({

});
export type Empty = z.infer<typeof EmptySchema>;

export const HelloSchema = z.strictObject({
"protocol_version": CountSchema,
"engine_version": IdSchema,
"schema_sha256": DigestSchema,
});
export type Hello = z.infer<typeof HelloSchema>;

export const CapabilitiesSchema = z.strictObject({
"protocol_version": CountSchema,
"engine_version": IdSchema,
"schema_sha256": DigestSchema,
"max_frame_bytes": FrameLimitSchema,
"admission": FlagSchema,
"execution": FlagSchema,
"decisions": FlagSchema,
"cancellation": FlagSchema,
});
export type Capabilities = z.infer<typeof CapabilitiesSchema>;

export const PolicySchema = z.strictObject({
"id": IdSchema,
"version": IdSchema,
"observation_version": IdSchema,
"search_nodes": PositiveSchema,
});
export type Policy = z.infer<typeof PolicySchema>;

export const CardInstanceSchema = z.strictObject({
"physical_id": IdSchema,
"oracle_id": IdSchema,
});
export type CardInstance = z.infer<typeof CardInstanceSchema>;

export const SeatInputSchema = z.strictObject({
"seat": SeatSchema,
"deck_digest": DigestSchema,
"policy": PolicySchema,
"commanders": z.array(IdSchema).min(1).max(2),
"cards": z.array(CardInstanceSchema).min(1).max(1000),
});
export type SeatInput = z.infer<typeof SeatInputSchema>;

export const LimitsSchema = z.strictObject({
"trials": PositiveSchema,
"concurrency": PositiveSchema,
"max_turns": PositiveSchema,
"max_actions": PositiveSchema,
"max_actions_per_turn": PositiveSchema,
"max_elapsed_ms": PositiveSchema,
"max_memory_bytes": PositiveSchema,
"max_output_bytes": PositiveSchema,
});
export type Limits = z.infer<typeof LimitsSchema>;

export const ScenarioSchema = z.strictObject({
"scenario_id": IdSchema,
"engine_version": IdSchema,
"snapshot_digest": DigestSchema,
"rules_digest": DigestSchema,
"seats": z.array(SeatInputSchema).min(4).max(4),
"seed": SeedSchema,
"limits": LimitsSchema,
});
export type Scenario = z.infer<typeof ScenarioSchema>;

export const RunSchema = z.strictObject({
"admission_id": IdSchema,
"scenario_digest": DigestSchema,
"trial_index": CountSchema,
"seed": SeedSchema,
});
export type Run = z.infer<typeof RunSchema>;

export const DecisionSchema = z.strictObject({
"decision_id": IdSchema,
"seat": SeatSchema,
"state_hash": DigestSchema,
"option_id": IdSchema,
});
export type Decision = z.infer<typeof DecisionSchema>;

export const CancelSchema = z.strictObject({
"run_request_id": IdSchema,
});
export type Cancel = z.infer<typeof CancelSchema>;

export const CatalogTextSchema = z.string().refine((value) => { const bytes = new TextEncoder().encode(value).length; return isWellFormed(value) && bytes >= 0 && bytes <= 32768; }, "Invalid Unicode or UTF-8 byte length");
export type CatalogText = z.infer<typeof CatalogTextSchema>;

export const CatalogJsonSchema = z.string().refine((value) => { const bytes = new TextEncoder().encode(value).length; return isWellFormed(value) && bytes >= 2 && bytes <= 1048576; }, "Invalid Unicode or UTF-8 byte length");
export type CatalogJson = z.infer<typeof CatalogJsonSchema>;

export const ColorCodeSchema = z.string().min(1).max(1).regex(/^[WUBRG]*$(?![\s\S])/);
export type ColorCode = z.infer<typeof ColorCodeSchema>;

export const ManaValueSchema = z.number().min(0).max(1000000);
export type ManaValue = z.infer<typeof ManaValueSchema>;

export const CatalogVersionSchema = z.number().int().min(1).max(1);
export type CatalogVersion = z.infer<typeof CatalogVersionSchema>;

export const FaceRelationshipSchema = z.enum(["single","split","adventure","modal","transform","meld","unknown","unsupported"]);
export type FaceRelationship = z.infer<typeof FaceRelationshipSchema>;

export const PlayabilitySchema = z.enum(["not_evaluated"]);
export type Playability = z.infer<typeof PlayabilitySchema>;

export const CharacteristicsSchema = z.strictObject({
"name": CatalogTextSchema.nullable(),
"mana_cost": CatalogTextSchema.nullable(),
"type_line": CatalogTextSchema.nullable(),
"oracle_text": CatalogTextSchema.nullable(),
"power": CatalogTextSchema.nullable(),
"toughness": CatalogTextSchema.nullable(),
"loyalty": CatalogTextSchema.nullable(),
"defense": CatalogTextSchema.nullable(),
"printed_name": CatalogTextSchema.nullable(),
"printed_text": CatalogTextSchema.nullable(),
"printed_type_line": CatalogTextSchema.nullable(),
"cmc": ManaValueSchema.nullable(),
"colors": z.array(CatalogTextSchema).min(0).max(256).nullable(),
"color_indicator": z.array(CatalogTextSchema).min(0).max(256).nullable(),
"keywords": z.array(CatalogTextSchema).min(0).max(256).nullable(),
"produced_mana": z.array(CatalogTextSchema).min(0).max(256).nullable(),
});
export type Characteristics = z.infer<typeof CharacteristicsSchema>;

export const CatalogFaceSchema = z.strictObject({
"face_index": CountSchema,
"source_path": CatalogTextSchema,
"oracle_id": IdSchema.nullable(),
"characteristics": CharacteristicsSchema,
});
export type CatalogFace = z.infer<typeof CatalogFaceSchema>;

export const CatalogSourceSchema = z.strictObject({
"scryfall_id": IdSchema.nullable(),
"oracle_id": IdSchema.nullable(),
});
export type CatalogSource = z.infer<typeof CatalogSourceSchema>;

export const RelatedCardSchema = z.strictObject({
"id": IdSchema,
"component": CatalogTextSchema,
"name": CatalogTextSchema,
"type_line": CatalogTextSchema,
"uri": CatalogTextSchema,
"object": CatalogTextSchema.nullable().optional(),
});
export type RelatedCard = z.infer<typeof RelatedCardSchema>;

export const CatalogGameplaySchema = z.strictObject({
"version": CatalogVersionSchema,
"source": CatalogSourceSchema,
"layout": CatalogTextSchema.nullable(),
"color_identity": z.array(ColorCodeSchema).min(0).max(5).nullable(),
"face_relationship": FaceRelationshipSchema,
"playability": PlayabilitySchema,
"characteristics": CharacteristicsSchema,
"faces": z.array(CatalogFaceSchema).min(1).max(16).nullable(),
"related_cards": z.array(RelatedCardSchema).min(0).max(256).nullable(),
});
export type CatalogGameplay = z.infer<typeof CatalogGameplaySchema>;

export const CatalogRecordSchema = z.strictObject({
"oracle_id": IdSchema,
"gameplay": CatalogGameplaySchema,
"printing_ids": z.array(IdSchema).min(0).max(4096),
});
export type CatalogRecord = z.infer<typeof CatalogRecordSchema>;

export const CatalogEntrySchema = z.strictObject({
"oracle_id": IdSchema,
"qty": PositiveSchema,
"printing_id": IdSchema.nullable(),
});
export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;

export const DeckFormatSchema = z.enum(["commander"]);
export type DeckFormat = z.infer<typeof DeckFormatSchema>;

export const CommandZoneKindSchema = z.enum(["single","partner","background","doctor_companion"]);
export type CommandZoneKind = z.infer<typeof CommandZoneKindSchema>;

export const CapturedDeckSchema = z.strictObject({
"deck_id": IdSchema,
"version": PositiveSchema,
"data_snapshot": IdSchema,
"format": DeckFormatSchema,
"command_zone_kind": CommandZoneKindSchema,
"computed_color_identity": z.array(ColorCodeSchema).min(0).max(5),
"commanders": z.array(CatalogEntrySchema).min(1).max(2),
"cards": z.array(CatalogEntrySchema).min(1).max(1000),
"companion": CatalogEntrySchema.nullable(),
});
export type CapturedDeck = z.infer<typeof CapturedDeckSchema>;

export const CatalogPayloadSchema = z.strictObject({
"schema_version": CatalogVersionSchema,
"data_snapshot": IdSchema,
"index_revision": DigestSchema,
"deck": CapturedDeckSchema,
"records": z.array(CatalogRecordSchema).min(1).max(1024),
});
export type CatalogPayload = z.infer<typeof CatalogPayloadSchema>;

export const CatalogEnvelopeSchema = z.strictObject({
"payload_json": CatalogJsonSchema,
"payload_digest": DigestSchema,
"expected_index_revision": DigestSchema,
"expected_deck_id": IdSchema,
"expected_deck_version": PositiveSchema,
});
export type CatalogEnvelope = z.infer<typeof CatalogEnvelopeSchema>;

export const SupportRequirementSchema = z.strictObject({
"id": CatalogTextSchema,
"path": CatalogTextSchema,
"face_index": CountSchema.nullable(),
"start": CountSchema.nullable(),
"end": CountSchema.nullable(),
"qualified": FlagSchema,
"reason": CatalogTextSchema,
"implementation": CatalogTextSchema.nullable(),
"evidence": CatalogTextSchema.nullable(),
});
export type SupportRequirement = z.infer<typeof SupportRequirementSchema>;

export const SupportReportSchema = z.strictObject({
"oracle_id": IdSchema,
"source_digest": DigestSchema,
"oracle_text_digest": DigestSchema,
"face_digests": z.array(DigestSchema).min(0).max(16),
"implementation_version": IdSchema,
"implementation_digest": DigestSchema,
"registry_digest": DigestSchema,
"corpus_digest": DigestSchema,
"source_matches": FlagSchema,
"supported": FlagSchema,
"owners": z.array(IdSchema).min(0).max(64),
"expected_scenarios": z.array(CatalogTextSchema).min(0).max(256),
"requirements": z.array(SupportRequirementSchema).min(0).max(2048),
});
export type SupportReport = z.infer<typeof SupportReportSchema>;

export const SupportCheckSchema = z.strictObject({
"catalog": CatalogEnvelopeSchema,
"oracle_id": IdSchema,
"expected_implementation_version": IdSchema,
"expected_implementation_digest": DigestSchema.nullable(),
});
export type SupportCheck = z.infer<typeof SupportCheckSchema>;

export const RequestMessageSchema = z.discriminatedUnion("type", [
z.strictObject({type: z.literal("hello"), data: HelloSchema}),
z.strictObject({type: z.literal("capabilities"), data: EmptySchema}),
z.strictObject({type: z.literal("admit"), data: ScenarioSchema}),
z.strictObject({type: z.literal("run"), data: RunSchema}),
z.strictObject({type: z.literal("decision"), data: DecisionSchema}),
z.strictObject({type: z.literal("cancel"), data: CancelSchema}),
z.strictObject({type: z.literal("catalog_check"), data: CatalogEnvelopeSchema}),
z.strictObject({type: z.literal("support_check"), data: SupportCheckSchema}),
]);
export type RequestMessage = z.infer<typeof RequestMessageSchema>;

export const RequestSchema = z.strictObject({
"request_id": IdSchema,
"message": RequestMessageSchema,
});
export type Request = z.infer<typeof RequestSchema>;

export const DiagnosticSchema = z.strictObject({
"code": IdSchema,
"message": TextSchema,
"oracle_id": IdSchema.nullable().optional(),
"physical_id": IdSchema.nullable().optional(),
"behavior_id": IdSchema.nullable().optional(),
});
export type Diagnostic = z.infer<typeof DiagnosticSchema>;

export const UnsupportedSchema = z.strictObject({
"diagnostics": z.array(DiagnosticSchema).min(1).max(256),
});
export type Unsupported = z.infer<typeof UnsupportedSchema>;

export const CompletedSchema = z.strictObject({
"winner_seats": z.array(SeatSchema).min(0).max(4),
"final_state_hash": DigestSchema,
});
export type Completed = z.infer<typeof CompletedSchema>;

export const TruncatedSchema = z.strictObject({
"reason": TextSchema,
"turns": CountSchema,
"actions": CountSchema,
});
export type Truncated = z.infer<typeof TruncatedSchema>;

export const OutcomeSchema = z.discriminatedUnion("type", [
z.strictObject({type: z.literal("completed"), data: CompletedSchema}),
z.strictObject({type: z.literal("unsupported"), data: UnsupportedSchema}),
z.strictObject({type: z.literal("invalid"), data: DiagnosticSchema}),
z.strictObject({type: z.literal("truncated"), data: TruncatedSchema}),
z.strictObject({type: z.literal("cancelled"), data: EmptySchema}),
z.strictObject({type: z.literal("engine_error"), data: DiagnosticSchema}),
]);
export type Outcome = z.infer<typeof OutcomeSchema>;

export const AdmittedSchema = z.strictObject({
"admission_id": IdSchema,
"scenario_digest": DigestSchema,
});
export type Admitted = z.infer<typeof AdmittedSchema>;

export const ProgressSchema = z.strictObject({
"trial_index": CountSchema,
"turns": CountSchema,
"actions": CountSchema,
});
export type Progress = z.infer<typeof ProgressSchema>;

export const DecisionRequestSchema = z.strictObject({
"decision_id": IdSchema,
"seat": SeatSchema,
"state_hash": DigestSchema,
"observation_digest": DigestSchema,
"options": z.array(IdSchema).min(1).max(1024),
});
export type DecisionRequest = z.infer<typeof DecisionRequestSchema>;

export const EventDataSchema = z.discriminatedUnion("type", [
z.strictObject({type: z.literal("progress"), data: ProgressSchema}),
z.strictObject({type: z.literal("decision"), data: DecisionRequestSchema}),
z.strictObject({type: z.literal("outcome"), data: OutcomeSchema}),
]);
export type EventData = z.infer<typeof EventDataSchema>;

export const EventSchema = z.strictObject({
"event_id": IdSchema,
"sequence": CountSchema,
"data": EventDataSchema,
});
export type Event = z.infer<typeof EventSchema>;

export const ResponseMessageSchema = z.discriminatedUnion("type", [
z.strictObject({type: z.literal("hello"), data: CapabilitiesSchema}),
z.strictObject({type: z.literal("capabilities"), data: CapabilitiesSchema}),
z.strictObject({type: z.literal("admitted"), data: AdmittedSchema}),
z.strictObject({type: z.literal("event"), data: EventSchema}),
z.strictObject({type: z.literal("outcome"), data: OutcomeSchema}),
z.strictObject({type: z.literal("catalog_checked"), data: CatalogEnvelopeSchema}),
z.strictObject({type: z.literal("support_checked"), data: SupportReportSchema}),
]);
export type ResponseMessage = z.infer<typeof ResponseMessageSchema>;

export const ResponseSchema = z.strictObject({
"request_id": IdSchema.nullable().optional(),
"message": ResponseMessageSchema,
});
export type Response = z.infer<typeof ResponseSchema>;

