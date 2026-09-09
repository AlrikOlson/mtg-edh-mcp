// @generated from canonical mtg-worker/protocol/contract.json; do not edit.
export const SCHEMA_SHA256 = "c5e80398f5ba654d58c81d7263ab0e8a1563d03b71a9a48181992eda877697ec";
import { z } from "zod";

export const PROTOCOL_VERSION = 1;

export const ENGINE_VERSION = "0.1.0";

export const MAX_FRAME_BYTES = 65536;

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

export const FrameLimitSchema = z.number().int().min(1).max(65536);
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

export const RequestMessageSchema = z.discriminatedUnion("type", [
z.strictObject({type: z.literal("hello"), data: HelloSchema}),
z.strictObject({type: z.literal("capabilities"), data: EmptySchema}),
z.strictObject({type: z.literal("admit"), data: ScenarioSchema}),
z.strictObject({type: z.literal("run"), data: RunSchema}),
z.strictObject({type: z.literal("decision"), data: DecisionSchema}),
z.strictObject({type: z.literal("cancel"), data: CancelSchema}),
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
]);
export type ResponseMessage = z.infer<typeof ResponseMessageSchema>;

export const ResponseSchema = z.strictObject({
"request_id": IdSchema.nullable().optional(),
"message": ResponseMessageSchema,
});
export type Response = z.infer<typeof ResponseSchema>;

