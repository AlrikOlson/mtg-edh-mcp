// @generated from canonical mtg-worker/protocol/contract.json; do not edit.
pub const SCHEMA_SHA256: &str = "c5e80398f5ba654d58c81d7263ab0e8a1563d03b71a9a48181992eda877697ec";
use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u32 = 1;

pub const ENGINE_VERSION: &str = "0.1.0";

pub const MAX_FRAME_BYTES: usize = 65_536;

pub type Id = String;

/// Validate the generated wire constraints.
///
/// # Errors
/// Returns the violated constraint.
#[allow(clippy::trivially_copy_pass_by_ref, clippy::unnecessary_wraps)]
pub fn validate_id(value: &str) -> Result<(), String> {
if !(1..=128).contains(&value.len()) {
return Err("Id length outside contract bounds".to_owned());
}
if !value.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"_.:-".contains(&byte)) {
return Err("Id invalid ASCII alphabet".to_owned());
}
Ok(())
}

pub type Digest = String;

/// Validate the generated wire constraints.
///
/// # Errors
/// Returns the violated constraint.
#[allow(clippy::trivially_copy_pass_by_ref, clippy::unnecessary_wraps)]
pub fn validate_digest(value: &str) -> Result<(), String> {
if !(64..=64).contains(&value.len()) {
return Err("Digest length outside contract bounds".to_owned());
}
if !value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) {
return Err("Digest invalid ASCII alphabet".to_owned());
}
Ok(())
}

pub type Seed = String;

/// Validate the generated wire constraints.
///
/// # Errors
/// Returns the violated constraint.
#[allow(clippy::trivially_copy_pass_by_ref, clippy::unnecessary_wraps)]
pub fn validate_seed(value: &str) -> Result<(), String> {
if !(16..=16).contains(&value.len()) {
return Err("Seed length outside contract bounds".to_owned());
}
if !value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) {
return Err("Seed invalid ASCII alphabet".to_owned());
}
Ok(())
}

pub type Text = String;

/// Validate the generated wire constraints.
///
/// # Errors
/// Returns the violated constraint.
#[allow(clippy::trivially_copy_pass_by_ref, clippy::unnecessary_wraps)]
pub fn validate_text(value: &str) -> Result<(), String> {
if !(1..=1_024).contains(&value.len()) {
return Err("Text length outside contract bounds".to_owned());
}
if !value.bytes().all(|byte| (b' '..=b'~').contains(&byte)) {
return Err("Text invalid ASCII alphabet".to_owned());
}
Ok(())
}

pub type Count = u32;

/// Validate the generated wire constraints.
///
/// # Errors
/// Returns the violated constraint.
#[allow(clippy::trivially_copy_pass_by_ref, clippy::unnecessary_wraps)]
pub fn validate_count(_value: &Count) -> Result<(), String> {
Ok(())
}

pub type Positive = u32;

/// Validate the generated wire constraints.
///
/// # Errors
/// Returns the violated constraint.
#[allow(clippy::trivially_copy_pass_by_ref, clippy::unnecessary_wraps)]
pub fn validate_positive(value: &Positive) -> Result<(), String> {
if !(1..=4_294_967_295).contains(value) {
return Err("Positive outside contract bounds".to_owned());
}
Ok(())
}

pub type Seat = u32;

/// Validate the generated wire constraints.
///
/// # Errors
/// Returns the violated constraint.
#[allow(clippy::trivially_copy_pass_by_ref, clippy::unnecessary_wraps)]
pub fn validate_seat(value: &Seat) -> Result<(), String> {
if !(0..=3).contains(value) {
return Err("Seat outside contract bounds".to_owned());
}
Ok(())
}

pub type FrameLimit = u32;

/// Validate the generated wire constraints.
///
/// # Errors
/// Returns the violated constraint.
#[allow(clippy::trivially_copy_pass_by_ref, clippy::unnecessary_wraps)]
pub fn validate_frame_limit(value: &FrameLimit) -> Result<(), String> {
if !(1..=65_536).contains(value) {
return Err("FrameLimit outside contract bounds".to_owned());
}
Ok(())
}

pub type Flag = bool;

/// Validate the generated wire constraints.
///
/// # Errors
/// Returns the violated constraint.
#[allow(clippy::trivially_copy_pass_by_ref, clippy::unnecessary_wraps)]
pub fn validate_flag(_value: &Flag) -> Result<(), String> {
Ok(())
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Empty {
}

/// Validate the generated wire constraints.
///
/// # Errors
/// Returns the violated constraint.
#[allow(clippy::trivially_copy_pass_by_ref, clippy::unnecessary_wraps)]
pub fn validate_empty(_value: &Empty) -> Result<(), String> {
Ok(())
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Hello {
pub protocol_version: Count,
pub engine_version: Id,
pub schema_sha256: Digest,
}

/// Validate the generated wire constraints.
///
/// # Errors
/// Returns the violated constraint.
#[allow(clippy::trivially_copy_pass_by_ref, clippy::unnecessary_wraps)]
pub fn validate_hello(value: &Hello) -> Result<(), String> {
let field = &value.protocol_version;
validate_count(field).map_err(|e| format!("Hello.protocol_version: {e}"))?;
let field = &value.engine_version;
validate_id(field).map_err(|e| format!("Hello.engine_version: {e}"))?;
let field = &value.schema_sha256;
validate_digest(field).map_err(|e| format!("Hello.schema_sha256: {e}"))?;
Ok(())
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Capabilities {
pub protocol_version: Count,
pub engine_version: Id,
pub schema_sha256: Digest,
pub max_frame_bytes: FrameLimit,
pub admission: Flag,
pub execution: Flag,
pub decisions: Flag,
pub cancellation: Flag,
}

/// Validate the generated wire constraints.
///
/// # Errors
/// Returns the violated constraint.
#[allow(clippy::trivially_copy_pass_by_ref, clippy::unnecessary_wraps)]
pub fn validate_capabilities(value: &Capabilities) -> Result<(), String> {
let field = &value.protocol_version;
validate_count(field).map_err(|e| format!("Capabilities.protocol_version: {e}"))?;
let field = &value.engine_version;
validate_id(field).map_err(|e| format!("Capabilities.engine_version: {e}"))?;
let field = &value.schema_sha256;
validate_digest(field).map_err(|e| format!("Capabilities.schema_sha256: {e}"))?;
let field = &value.max_frame_bytes;
validate_frame_limit(field).map_err(|e| format!("Capabilities.max_frame_bytes: {e}"))?;
let field = &value.admission;
validate_flag(field).map_err(|e| format!("Capabilities.admission: {e}"))?;
let field = &value.execution;
validate_flag(field).map_err(|e| format!("Capabilities.execution: {e}"))?;
let field = &value.decisions;
validate_flag(field).map_err(|e| format!("Capabilities.decisions: {e}"))?;
let field = &value.cancellation;
validate_flag(field).map_err(|e| format!("Capabilities.cancellation: {e}"))?;
Ok(())
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Policy {
pub id: Id,
pub version: Id,
pub observation_version: Id,
pub search_nodes: Positive,
}

/// Validate the generated wire constraints.
///
/// # Errors
/// Returns the violated constraint.
#[allow(clippy::trivially_copy_pass_by_ref, clippy::unnecessary_wraps)]
pub fn validate_policy(value: &Policy) -> Result<(), String> {
let field = &value.id;
validate_id(field).map_err(|e| format!("Policy.id: {e}"))?;
let field = &value.version;
validate_id(field).map_err(|e| format!("Policy.version: {e}"))?;
let field = &value.observation_version;
validate_id(field).map_err(|e| format!("Policy.observation_version: {e}"))?;
let field = &value.search_nodes;
validate_positive(field).map_err(|e| format!("Policy.search_nodes: {e}"))?;
Ok(())
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CardInstance {
pub physical_id: Id,
pub oracle_id: Id,
}

/// Validate the generated wire constraints.
///
/// # Errors
/// Returns the violated constraint.
#[allow(clippy::trivially_copy_pass_by_ref, clippy::unnecessary_wraps)]
pub fn validate_card_instance(value: &CardInstance) -> Result<(), String> {
let field = &value.physical_id;
validate_id(field).map_err(|e| format!("CardInstance.physical_id: {e}"))?;
let field = &value.oracle_id;
validate_id(field).map_err(|e| format!("CardInstance.oracle_id: {e}"))?;
Ok(())
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SeatInput {
pub seat: Seat,
pub deck_digest: Digest,
pub policy: Policy,
pub commanders: Vec<Id>,
pub cards: Vec<CardInstance>,
}

/// Validate the generated wire constraints.
///
/// # Errors
/// Returns the violated constraint.
#[allow(clippy::trivially_copy_pass_by_ref, clippy::unnecessary_wraps)]
pub fn validate_seat_input(value: &SeatInput) -> Result<(), String> {
let field = &value.seat;
validate_seat(field).map_err(|e| format!("SeatInput.seat: {e}"))?;
let field = &value.deck_digest;
validate_digest(field).map_err(|e| format!("SeatInput.deck_digest: {e}"))?;
let field = &value.policy;
validate_policy(field).map_err(|e| format!("SeatInput.policy: {e}"))?;
let field = &value.commanders;
if !(1..=2).contains(&field.len()) {
return Err("SeatInput.commanders length outside contract bounds".to_owned());
}
for item in field {
validate_id(item).map_err(|e| format!("SeatInput.commanders: {e}"))?;
}
let field = &value.cards;
if !(1..=1_000).contains(&field.len()) {
return Err("SeatInput.cards length outside contract bounds".to_owned());
}
for item in field {
validate_card_instance(item).map_err(|e| format!("SeatInput.cards: {e}"))?;
}
Ok(())
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Limits {
pub trials: Positive,
pub concurrency: Positive,
pub max_turns: Positive,
pub max_actions: Positive,
pub max_actions_per_turn: Positive,
pub max_elapsed_ms: Positive,
pub max_memory_bytes: Positive,
pub max_output_bytes: Positive,
}

/// Validate the generated wire constraints.
///
/// # Errors
/// Returns the violated constraint.
#[allow(clippy::trivially_copy_pass_by_ref, clippy::unnecessary_wraps)]
pub fn validate_limits(value: &Limits) -> Result<(), String> {
let field = &value.trials;
validate_positive(field).map_err(|e| format!("Limits.trials: {e}"))?;
let field = &value.concurrency;
validate_positive(field).map_err(|e| format!("Limits.concurrency: {e}"))?;
let field = &value.max_turns;
validate_positive(field).map_err(|e| format!("Limits.max_turns: {e}"))?;
let field = &value.max_actions;
validate_positive(field).map_err(|e| format!("Limits.max_actions: {e}"))?;
let field = &value.max_actions_per_turn;
validate_positive(field).map_err(|e| format!("Limits.max_actions_per_turn: {e}"))?;
let field = &value.max_elapsed_ms;
validate_positive(field).map_err(|e| format!("Limits.max_elapsed_ms: {e}"))?;
let field = &value.max_memory_bytes;
validate_positive(field).map_err(|e| format!("Limits.max_memory_bytes: {e}"))?;
let field = &value.max_output_bytes;
validate_positive(field).map_err(|e| format!("Limits.max_output_bytes: {e}"))?;
Ok(())
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Scenario {
pub scenario_id: Id,
pub engine_version: Id,
pub snapshot_digest: Digest,
pub rules_digest: Digest,
pub seats: Vec<SeatInput>,
pub seed: Seed,
pub limits: Limits,
}

/// Validate the generated wire constraints.
///
/// # Errors
/// Returns the violated constraint.
#[allow(clippy::trivially_copy_pass_by_ref, clippy::unnecessary_wraps)]
pub fn validate_scenario(value: &Scenario) -> Result<(), String> {
let field = &value.scenario_id;
validate_id(field).map_err(|e| format!("Scenario.scenario_id: {e}"))?;
let field = &value.engine_version;
validate_id(field).map_err(|e| format!("Scenario.engine_version: {e}"))?;
let field = &value.snapshot_digest;
validate_digest(field).map_err(|e| format!("Scenario.snapshot_digest: {e}"))?;
let field = &value.rules_digest;
validate_digest(field).map_err(|e| format!("Scenario.rules_digest: {e}"))?;
let field = &value.seats;
if !(4..=4).contains(&field.len()) {
return Err("Scenario.seats length outside contract bounds".to_owned());
}
for item in field {
validate_seat_input(item).map_err(|e| format!("Scenario.seats: {e}"))?;
}
let field = &value.seed;
validate_seed(field).map_err(|e| format!("Scenario.seed: {e}"))?;
let field = &value.limits;
validate_limits(field).map_err(|e| format!("Scenario.limits: {e}"))?;
Ok(())
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Run {
pub admission_id: Id,
pub scenario_digest: Digest,
pub trial_index: Count,
pub seed: Seed,
}

/// Validate the generated wire constraints.
///
/// # Errors
/// Returns the violated constraint.
#[allow(clippy::trivially_copy_pass_by_ref, clippy::unnecessary_wraps)]
pub fn validate_run(value: &Run) -> Result<(), String> {
let field = &value.admission_id;
validate_id(field).map_err(|e| format!("Run.admission_id: {e}"))?;
let field = &value.scenario_digest;
validate_digest(field).map_err(|e| format!("Run.scenario_digest: {e}"))?;
let field = &value.trial_index;
validate_count(field).map_err(|e| format!("Run.trial_index: {e}"))?;
let field = &value.seed;
validate_seed(field).map_err(|e| format!("Run.seed: {e}"))?;
Ok(())
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Decision {
pub decision_id: Id,
pub seat: Seat,
pub state_hash: Digest,
pub option_id: Id,
}

/// Validate the generated wire constraints.
///
/// # Errors
/// Returns the violated constraint.
#[allow(clippy::trivially_copy_pass_by_ref, clippy::unnecessary_wraps)]
pub fn validate_decision(value: &Decision) -> Result<(), String> {
let field = &value.decision_id;
validate_id(field).map_err(|e| format!("Decision.decision_id: {e}"))?;
let field = &value.seat;
validate_seat(field).map_err(|e| format!("Decision.seat: {e}"))?;
let field = &value.state_hash;
validate_digest(field).map_err(|e| format!("Decision.state_hash: {e}"))?;
let field = &value.option_id;
validate_id(field).map_err(|e| format!("Decision.option_id: {e}"))?;
Ok(())
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Cancel {
pub run_request_id: Id,
}

/// Validate the generated wire constraints.
///
/// # Errors
/// Returns the violated constraint.
#[allow(clippy::trivially_copy_pass_by_ref, clippy::unnecessary_wraps)]
pub fn validate_cancel(value: &Cancel) -> Result<(), String> {
let field = &value.run_request_id;
validate_id(field).map_err(|e| format!("Cancel.run_request_id: {e}"))?;
Ok(())
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(tag = "type", content = "data", deny_unknown_fields)]
pub enum RequestMessage {
#[serde(rename = "hello")]
Hello(Hello),
#[serde(rename = "capabilities")]
Capabilities(Empty),
#[serde(rename = "admit")]
Admit(Scenario),
#[serde(rename = "run")]
Run(Run),
#[serde(rename = "decision")]
Decision(Decision),
#[serde(rename = "cancel")]
Cancel(Cancel),
}

/// Validate the generated wire constraints.
///
/// # Errors
/// Returns the violated constraint.
#[allow(clippy::trivially_copy_pass_by_ref, clippy::unnecessary_wraps)]
pub fn validate_request_message(value: &RequestMessage) -> Result<(), String> {
match value {
RequestMessage::Hello(data) => validate_hello(data),
RequestMessage::Capabilities(data) => validate_empty(data),
RequestMessage::Admit(data) => validate_scenario(data),
RequestMessage::Run(data) => validate_run(data),
RequestMessage::Decision(data) => validate_decision(data),
RequestMessage::Cancel(data) => validate_cancel(data),
}
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Request {
pub request_id: Id,
pub message: RequestMessage,
}

/// Validate the generated wire constraints.
///
/// # Errors
/// Returns the violated constraint.
#[allow(clippy::trivially_copy_pass_by_ref, clippy::unnecessary_wraps)]
pub fn validate_request(value: &Request) -> Result<(), String> {
let field = &value.request_id;
validate_id(field).map_err(|e| format!("Request.request_id: {e}"))?;
let field = &value.message;
validate_request_message(field).map_err(|e| format!("Request.message: {e}"))?;
Ok(())
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Diagnostic {
pub code: Id,
pub message: Text,
#[serde(default, skip_serializing_if = "Option::is_none")]
pub oracle_id: Option<Id>,
#[serde(default, skip_serializing_if = "Option::is_none")]
pub physical_id: Option<Id>,
#[serde(default, skip_serializing_if = "Option::is_none")]
pub behavior_id: Option<Id>,
}

/// Validate the generated wire constraints.
///
/// # Errors
/// Returns the violated constraint.
#[allow(clippy::trivially_copy_pass_by_ref, clippy::unnecessary_wraps)]
pub fn validate_diagnostic(value: &Diagnostic) -> Result<(), String> {
let field = &value.code;
validate_id(field).map_err(|e| format!("Diagnostic.code: {e}"))?;
let field = &value.message;
validate_text(field).map_err(|e| format!("Diagnostic.message: {e}"))?;
if let Some(field) = &value.oracle_id {
validate_id(field).map_err(|e| format!("Diagnostic.oracle_id: {e}"))?;
}
if let Some(field) = &value.physical_id {
validate_id(field).map_err(|e| format!("Diagnostic.physical_id: {e}"))?;
}
if let Some(field) = &value.behavior_id {
validate_id(field).map_err(|e| format!("Diagnostic.behavior_id: {e}"))?;
}
Ok(())
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Unsupported {
pub diagnostics: Vec<Diagnostic>,
}

/// Validate the generated wire constraints.
///
/// # Errors
/// Returns the violated constraint.
#[allow(clippy::trivially_copy_pass_by_ref, clippy::unnecessary_wraps)]
pub fn validate_unsupported(value: &Unsupported) -> Result<(), String> {
let field = &value.diagnostics;
if !(1..=256).contains(&field.len()) {
return Err("Unsupported.diagnostics length outside contract bounds".to_owned());
}
for item in field {
validate_diagnostic(item).map_err(|e| format!("Unsupported.diagnostics: {e}"))?;
}
Ok(())
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Completed {
pub winner_seats: Vec<Seat>,
pub final_state_hash: Digest,
}

/// Validate the generated wire constraints.
///
/// # Errors
/// Returns the violated constraint.
#[allow(clippy::trivially_copy_pass_by_ref, clippy::unnecessary_wraps)]
pub fn validate_completed(value: &Completed) -> Result<(), String> {
let field = &value.winner_seats;
if !(0..=4).contains(&field.len()) {
return Err("Completed.winner_seats length outside contract bounds".to_owned());
}
for item in field {
validate_seat(item).map_err(|e| format!("Completed.winner_seats: {e}"))?;
}
let field = &value.final_state_hash;
validate_digest(field).map_err(|e| format!("Completed.final_state_hash: {e}"))?;
Ok(())
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Truncated {
pub reason: Text,
pub turns: Count,
pub actions: Count,
}

/// Validate the generated wire constraints.
///
/// # Errors
/// Returns the violated constraint.
#[allow(clippy::trivially_copy_pass_by_ref, clippy::unnecessary_wraps)]
pub fn validate_truncated(value: &Truncated) -> Result<(), String> {
let field = &value.reason;
validate_text(field).map_err(|e| format!("Truncated.reason: {e}"))?;
let field = &value.turns;
validate_count(field).map_err(|e| format!("Truncated.turns: {e}"))?;
let field = &value.actions;
validate_count(field).map_err(|e| format!("Truncated.actions: {e}"))?;
Ok(())
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(tag = "type", content = "data", deny_unknown_fields)]
pub enum Outcome {
#[serde(rename = "completed")]
Completed(Completed),
#[serde(rename = "unsupported")]
Unsupported(Unsupported),
#[serde(rename = "invalid")]
Invalid(Diagnostic),
#[serde(rename = "truncated")]
Truncated(Truncated),
#[serde(rename = "cancelled")]
Cancelled(Empty),
#[serde(rename = "engine_error")]
EngineError(Diagnostic),
}

/// Validate the generated wire constraints.
///
/// # Errors
/// Returns the violated constraint.
#[allow(clippy::trivially_copy_pass_by_ref, clippy::unnecessary_wraps)]
pub fn validate_outcome(value: &Outcome) -> Result<(), String> {
match value {
Outcome::Completed(data) => validate_completed(data),
Outcome::Unsupported(data) => validate_unsupported(data),
Outcome::Invalid(data) | Outcome::EngineError(data) => validate_diagnostic(data),
Outcome::Truncated(data) => validate_truncated(data),
Outcome::Cancelled(data) => validate_empty(data),
}
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Admitted {
pub admission_id: Id,
pub scenario_digest: Digest,
}

/// Validate the generated wire constraints.
///
/// # Errors
/// Returns the violated constraint.
#[allow(clippy::trivially_copy_pass_by_ref, clippy::unnecessary_wraps)]
pub fn validate_admitted(value: &Admitted) -> Result<(), String> {
let field = &value.admission_id;
validate_id(field).map_err(|e| format!("Admitted.admission_id: {e}"))?;
let field = &value.scenario_digest;
validate_digest(field).map_err(|e| format!("Admitted.scenario_digest: {e}"))?;
Ok(())
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Progress {
pub trial_index: Count,
pub turns: Count,
pub actions: Count,
}

/// Validate the generated wire constraints.
///
/// # Errors
/// Returns the violated constraint.
#[allow(clippy::trivially_copy_pass_by_ref, clippy::unnecessary_wraps)]
pub fn validate_progress(value: &Progress) -> Result<(), String> {
let field = &value.trial_index;
validate_count(field).map_err(|e| format!("Progress.trial_index: {e}"))?;
let field = &value.turns;
validate_count(field).map_err(|e| format!("Progress.turns: {e}"))?;
let field = &value.actions;
validate_count(field).map_err(|e| format!("Progress.actions: {e}"))?;
Ok(())
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct DecisionRequest {
pub decision_id: Id,
pub seat: Seat,
pub state_hash: Digest,
pub observation_digest: Digest,
pub options: Vec<Id>,
}

/// Validate the generated wire constraints.
///
/// # Errors
/// Returns the violated constraint.
#[allow(clippy::trivially_copy_pass_by_ref, clippy::unnecessary_wraps)]
pub fn validate_decision_request(value: &DecisionRequest) -> Result<(), String> {
let field = &value.decision_id;
validate_id(field).map_err(|e| format!("DecisionRequest.decision_id: {e}"))?;
let field = &value.seat;
validate_seat(field).map_err(|e| format!("DecisionRequest.seat: {e}"))?;
let field = &value.state_hash;
validate_digest(field).map_err(|e| format!("DecisionRequest.state_hash: {e}"))?;
let field = &value.observation_digest;
validate_digest(field).map_err(|e| format!("DecisionRequest.observation_digest: {e}"))?;
let field = &value.options;
if !(1..=1_024).contains(&field.len()) {
return Err("DecisionRequest.options length outside contract bounds".to_owned());
}
for item in field {
validate_id(item).map_err(|e| format!("DecisionRequest.options: {e}"))?;
}
Ok(())
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(tag = "type", content = "data", deny_unknown_fields)]
pub enum EventData {
#[serde(rename = "progress")]
Progress(Progress),
#[serde(rename = "decision")]
Decision(DecisionRequest),
#[serde(rename = "outcome")]
Outcome(Outcome),
}

/// Validate the generated wire constraints.
///
/// # Errors
/// Returns the violated constraint.
#[allow(clippy::trivially_copy_pass_by_ref, clippy::unnecessary_wraps)]
pub fn validate_event_data(value: &EventData) -> Result<(), String> {
match value {
EventData::Progress(data) => validate_progress(data),
EventData::Decision(data) => validate_decision_request(data),
EventData::Outcome(data) => validate_outcome(data),
}
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Event {
pub event_id: Id,
pub sequence: Count,
pub data: EventData,
}

/// Validate the generated wire constraints.
///
/// # Errors
/// Returns the violated constraint.
#[allow(clippy::trivially_copy_pass_by_ref, clippy::unnecessary_wraps)]
pub fn validate_event(value: &Event) -> Result<(), String> {
let field = &value.event_id;
validate_id(field).map_err(|e| format!("Event.event_id: {e}"))?;
let field = &value.sequence;
validate_count(field).map_err(|e| format!("Event.sequence: {e}"))?;
let field = &value.data;
validate_event_data(field).map_err(|e| format!("Event.data: {e}"))?;
Ok(())
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(tag = "type", content = "data", deny_unknown_fields)]
pub enum ResponseMessage {
#[serde(rename = "hello")]
Hello(Capabilities),
#[serde(rename = "capabilities")]
Capabilities(Capabilities),
#[serde(rename = "admitted")]
Admitted(Admitted),
#[serde(rename = "event")]
Event(Event),
#[serde(rename = "outcome")]
Outcome(Outcome),
}

/// Validate the generated wire constraints.
///
/// # Errors
/// Returns the violated constraint.
#[allow(clippy::trivially_copy_pass_by_ref, clippy::unnecessary_wraps)]
pub fn validate_response_message(value: &ResponseMessage) -> Result<(), String> {
match value {
ResponseMessage::Hello(data) | ResponseMessage::Capabilities(data) => validate_capabilities(data),
ResponseMessage::Admitted(data) => validate_admitted(data),
ResponseMessage::Event(data) => validate_event(data),
ResponseMessage::Outcome(data) => validate_outcome(data),
}
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Response {
#[serde(default, skip_serializing_if = "Option::is_none")]
pub request_id: Option<Id>,
pub message: ResponseMessage,
}

/// Validate the generated wire constraints.
///
/// # Errors
/// Returns the violated constraint.
#[allow(clippy::trivially_copy_pass_by_ref, clippy::unnecessary_wraps)]
pub fn validate_response(value: &Response) -> Result<(), String> {
if let Some(field) = &value.request_id {
validate_id(field).map_err(|e| format!("Response.request_id: {e}"))?;
}
let field = &value.message;
validate_response_message(field).map_err(|e| format!("Response.message: {e}"))?;
Ok(())
}

