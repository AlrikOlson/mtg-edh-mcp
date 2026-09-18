// @generated from canonical mtg-worker/protocol/contract.json; do not edit.
pub const SCHEMA_SHA256: &str = "dd9da7e06c94e764d8e0b17a09cd86ac8bc2ef1c485b6fe1db1b27e7d0632e6d";
use serde::{Deserialize, Serialize};

fn required_nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error> where D: serde::Deserializer<'de>, T: Deserialize<'de> { Option::<T>::deserialize(deserializer) }

pub const PROTOCOL_VERSION: u32 = 5;

pub const ENGINE_VERSION: &str = "0.1.0";

pub const MAX_FRAME_BYTES: usize = 2_097_152;

pub const PREVIEW_FIXTURE_ID: &str = "forest-bears-internal-v1";

pub const PREVIEW_FIXTURE_VERSION: u32 = 1;

pub const PREVIEW_FIXTURE_DIGEST: &str = "7692ad4aa8565a65754eedad937af1908afcbd20b5a940a62f9b8e43051042e4";

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
if !(1..=2_097_152).contains(value) {
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
pub max_work: Positive,
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
let field = &value.max_work;
validate_positive(field).map_err(|e| format!("Limits.max_work: {e}"))?;
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
pub struct CommanderScenario {
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
pub fn validate_commander_scenario(value: &CommanderScenario) -> Result<(), String> {
let field = &value.scenario_id;
validate_id(field).map_err(|e| format!("CommanderScenario.scenario_id: {e}"))?;
let field = &value.engine_version;
validate_id(field).map_err(|e| format!("CommanderScenario.engine_version: {e}"))?;
let field = &value.snapshot_digest;
validate_digest(field).map_err(|e| format!("CommanderScenario.snapshot_digest: {e}"))?;
let field = &value.rules_digest;
validate_digest(field).map_err(|e| format!("CommanderScenario.rules_digest: {e}"))?;
let field = &value.seats;
if !(4..=4).contains(&field.len()) {
return Err("CommanderScenario.seats length outside contract bounds".to_owned());
}
for item in field {
validate_seat_input(item).map_err(|e| format!("CommanderScenario.seats: {e}"))?;
}
let field = &value.seed;
validate_seed(field).map_err(|e| format!("CommanderScenario.seed: {e}"))?;
let field = &value.limits;
validate_limits(field).map_err(|e| format!("CommanderScenario.limits: {e}"))?;
Ok(())
}

pub type PreviewSeat = u32;

/// Validate the generated wire constraints.
///
/// # Errors
/// Returns the violated constraint.
#[allow(clippy::trivially_copy_pass_by_ref, clippy::unnecessary_wraps)]
pub fn validate_preview_seat(value: &PreviewSeat) -> Result<(), String> {
if !(0..=3).contains(value) {
return Err("PreviewSeat outside contract bounds".to_owned());
}
Ok(())
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PreviewSeatInput {
pub seat: PreviewSeat,
pub deck_digest: Digest,
pub policy: Policy,
}

/// Validate the generated wire constraints.
///
/// # Errors
/// Returns the violated constraint.
#[allow(clippy::trivially_copy_pass_by_ref, clippy::unnecessary_wraps)]
pub fn validate_preview_seat_input(value: &PreviewSeatInput) -> Result<(), String> {
let field = &value.seat;
validate_preview_seat(field).map_err(|e| format!("PreviewSeatInput.seat: {e}"))?;
let field = &value.deck_digest;
validate_digest(field).map_err(|e| format!("PreviewSeatInput.deck_digest: {e}"))?;
let field = &value.policy;
validate_policy(field).map_err(|e| format!("PreviewSeatInput.policy: {e}"))?;
Ok(())
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PreviewScenario {
pub scenario_id: Id,
pub engine_version: Id,
pub snapshot_digest: Digest,
pub rules_digest: Digest,
pub seats: Vec<PreviewSeatInput>,
pub seed: Seed,
pub limits: Limits,
pub fixture_id: Id,
pub fixture_version: Positive,
pub fixture_digest: Digest,
}

/// Validate the generated wire constraints.
///
/// # Errors
/// Returns the violated constraint.
#[allow(clippy::trivially_copy_pass_by_ref, clippy::unnecessary_wraps)]
pub fn validate_preview_scenario(value: &PreviewScenario) -> Result<(), String> {
let field = &value.scenario_id;
validate_id(field).map_err(|e| format!("PreviewScenario.scenario_id: {e}"))?;
let field = &value.engine_version;
validate_id(field).map_err(|e| format!("PreviewScenario.engine_version: {e}"))?;
let field = &value.snapshot_digest;
validate_digest(field).map_err(|e| format!("PreviewScenario.snapshot_digest: {e}"))?;
let field = &value.rules_digest;
validate_digest(field).map_err(|e| format!("PreviewScenario.rules_digest: {e}"))?;
let field = &value.seats;
if !(2..=4).contains(&field.len()) {
return Err("PreviewScenario.seats length outside contract bounds".to_owned());
}
for item in field {
validate_preview_seat_input(item).map_err(|e| format!("PreviewScenario.seats: {e}"))?;
}
let field = &value.seed;
validate_seed(field).map_err(|e| format!("PreviewScenario.seed: {e}"))?;
let field = &value.limits;
validate_limits(field).map_err(|e| format!("PreviewScenario.limits: {e}"))?;
let field = &value.fixture_id;
validate_id(field).map_err(|e| format!("PreviewScenario.fixture_id: {e}"))?;
let field = &value.fixture_version;
validate_positive(field).map_err(|e| format!("PreviewScenario.fixture_version: {e}"))?;
let field = &value.fixture_digest;
validate_digest(field).map_err(|e| format!("PreviewScenario.fixture_digest: {e}"))?;
Ok(())
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(tag = "type", content = "data", deny_unknown_fields)]
pub enum Scenario {
#[serde(rename = "commander")]
Commander(CommanderScenario),
#[serde(rename = "preview_fixture")]
PreviewFixture(PreviewScenario),
}

/// Validate the generated wire constraints.
///
/// # Errors
/// Returns the violated constraint.
#[allow(clippy::trivially_copy_pass_by_ref, clippy::unnecessary_wraps)]
pub fn validate_scenario(value: &Scenario) -> Result<(), String> {
match value {
Scenario::Commander(data) => validate_commander_scenario(data),
Scenario::PreviewFixture(data) => validate_preview_scenario(data),
}
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

pub type CatalogText = String;

/// Validate the generated wire constraints.
///
/// # Errors
/// Returns the violated constraint.
#[allow(clippy::trivially_copy_pass_by_ref, clippy::unnecessary_wraps)]
pub fn validate_catalog_text(value: &str) -> Result<(), String> {
if !(0..=32_768).contains(&value.len()) {
return Err("CatalogText length outside contract bounds".to_owned());
}
Ok(())
}

pub type CatalogJson = String;

/// Validate the generated wire constraints.
///
/// # Errors
/// Returns the violated constraint.
#[allow(clippy::trivially_copy_pass_by_ref, clippy::unnecessary_wraps)]
pub fn validate_catalog_json(value: &str) -> Result<(), String> {
if !(2..=1_048_576).contains(&value.len()) {
return Err("CatalogJson length outside contract bounds".to_owned());
}
Ok(())
}

pub type ColorCode = String;

/// Validate the generated wire constraints.
///
/// # Errors
/// Returns the violated constraint.
#[allow(clippy::trivially_copy_pass_by_ref, clippy::unnecessary_wraps)]
pub fn validate_color_code(value: &str) -> Result<(), String> {
if !(1..=1).contains(&value.len()) {
return Err("ColorCode length outside contract bounds".to_owned());
}
if !value.bytes().all(|byte| b"WUBRG".contains(&byte)) {
return Err("ColorCode invalid ASCII alphabet".to_owned());
}
Ok(())
}

pub type ManaValue = f64;

/// Validate the generated wire constraints.
///
/// # Errors
/// Returns the violated constraint.
#[allow(clippy::trivially_copy_pass_by_ref, clippy::unnecessary_wraps)]
pub fn validate_mana_value(value: &ManaValue) -> Result<(), String> {
if !value.is_finite() || !(0.0..=1_000_000.0).contains(value) {
return Err("ManaValue outside contract bounds".to_owned());
}
Ok(())
}

pub type CatalogVersion = u32;

/// Validate the generated wire constraints.
///
/// # Errors
/// Returns the violated constraint.
#[allow(clippy::trivially_copy_pass_by_ref, clippy::unnecessary_wraps)]
pub fn validate_catalog_version(value: &CatalogVersion) -> Result<(), String> {
if !(1..=1).contains(value) {
return Err("CatalogVersion outside contract bounds".to_owned());
}
Ok(())
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]

pub enum FaceRelationship {
#[serde(rename = "single")]
Single,
#[serde(rename = "split")]
Split,
#[serde(rename = "adventure")]
Adventure,
#[serde(rename = "modal")]
Modal,
#[serde(rename = "transform")]
Transform,
#[serde(rename = "meld")]
Meld,
#[serde(rename = "unknown")]
Unknown,
#[serde(rename = "unsupported")]
Unsupported,
}

/// Validate the generated wire constraints.
///
/// # Errors
/// Returns the violated constraint.
#[allow(clippy::trivially_copy_pass_by_ref, clippy::unnecessary_wraps)]
pub fn validate_face_relationship(_value: &FaceRelationship) -> Result<(), String> {
Ok(())
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]

pub enum Playability {
#[serde(rename = "not_evaluated")]
NotEvaluated,
}

/// Validate the generated wire constraints.
///
/// # Errors
/// Returns the violated constraint.
#[allow(clippy::trivially_copy_pass_by_ref, clippy::unnecessary_wraps)]
pub fn validate_playability(_value: &Playability) -> Result<(), String> {
Ok(())
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Characteristics {
#[serde(deserialize_with = "required_nullable")]
pub name: Option<CatalogText>,
#[serde(deserialize_with = "required_nullable")]
pub mana_cost: Option<CatalogText>,
#[serde(deserialize_with = "required_nullable")]
pub type_line: Option<CatalogText>,
#[serde(deserialize_with = "required_nullable")]
pub oracle_text: Option<CatalogText>,
#[serde(deserialize_with = "required_nullable")]
pub power: Option<CatalogText>,
#[serde(deserialize_with = "required_nullable")]
pub toughness: Option<CatalogText>,
#[serde(deserialize_with = "required_nullable")]
pub loyalty: Option<CatalogText>,
#[serde(deserialize_with = "required_nullable")]
pub defense: Option<CatalogText>,
#[serde(deserialize_with = "required_nullable")]
pub printed_name: Option<CatalogText>,
#[serde(deserialize_with = "required_nullable")]
pub printed_text: Option<CatalogText>,
#[serde(deserialize_with = "required_nullable")]
pub printed_type_line: Option<CatalogText>,
#[serde(deserialize_with = "required_nullable")]
pub cmc: Option<ManaValue>,
#[serde(deserialize_with = "required_nullable")]
pub colors: Option<Vec<CatalogText>>,
#[serde(deserialize_with = "required_nullable")]
pub color_indicator: Option<Vec<CatalogText>>,
#[serde(deserialize_with = "required_nullable")]
pub keywords: Option<Vec<CatalogText>>,
#[serde(deserialize_with = "required_nullable")]
pub produced_mana: Option<Vec<CatalogText>>,
}

/// Validate the generated wire constraints.
///
/// # Errors
/// Returns the violated constraint.
#[allow(clippy::trivially_copy_pass_by_ref, clippy::unnecessary_wraps)]
pub fn validate_characteristics(value: &Characteristics) -> Result<(), String> {
if let Some(field) = &value.name {
validate_catalog_text(field).map_err(|e| format!("Characteristics.name: {e}"))?;
}
if let Some(field) = &value.mana_cost {
validate_catalog_text(field).map_err(|e| format!("Characteristics.mana_cost: {e}"))?;
}
if let Some(field) = &value.type_line {
validate_catalog_text(field).map_err(|e| format!("Characteristics.type_line: {e}"))?;
}
if let Some(field) = &value.oracle_text {
validate_catalog_text(field).map_err(|e| format!("Characteristics.oracle_text: {e}"))?;
}
if let Some(field) = &value.power {
validate_catalog_text(field).map_err(|e| format!("Characteristics.power: {e}"))?;
}
if let Some(field) = &value.toughness {
validate_catalog_text(field).map_err(|e| format!("Characteristics.toughness: {e}"))?;
}
if let Some(field) = &value.loyalty {
validate_catalog_text(field).map_err(|e| format!("Characteristics.loyalty: {e}"))?;
}
if let Some(field) = &value.defense {
validate_catalog_text(field).map_err(|e| format!("Characteristics.defense: {e}"))?;
}
if let Some(field) = &value.printed_name {
validate_catalog_text(field).map_err(|e| format!("Characteristics.printed_name: {e}"))?;
}
if let Some(field) = &value.printed_text {
validate_catalog_text(field).map_err(|e| format!("Characteristics.printed_text: {e}"))?;
}
if let Some(field) = &value.printed_type_line {
validate_catalog_text(field).map_err(|e| format!("Characteristics.printed_type_line: {e}"))?;
}
if let Some(field) = &value.cmc {
validate_mana_value(field).map_err(|e| format!("Characteristics.cmc: {e}"))?;
}
if let Some(field) = &value.colors {
if !(0..=256).contains(&field.len()) {
return Err("Characteristics.colors length outside contract bounds".to_owned());
}
for item in field {
validate_catalog_text(item).map_err(|e| format!("Characteristics.colors: {e}"))?;
}
}
if let Some(field) = &value.color_indicator {
if !(0..=256).contains(&field.len()) {
return Err("Characteristics.color_indicator length outside contract bounds".to_owned());
}
for item in field {
validate_catalog_text(item).map_err(|e| format!("Characteristics.color_indicator: {e}"))?;
}
}
if let Some(field) = &value.keywords {
if !(0..=256).contains(&field.len()) {
return Err("Characteristics.keywords length outside contract bounds".to_owned());
}
for item in field {
validate_catalog_text(item).map_err(|e| format!("Characteristics.keywords: {e}"))?;
}
}
if let Some(field) = &value.produced_mana {
if !(0..=256).contains(&field.len()) {
return Err("Characteristics.produced_mana length outside contract bounds".to_owned());
}
for item in field {
validate_catalog_text(item).map_err(|e| format!("Characteristics.produced_mana: {e}"))?;
}
}
Ok(())
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CatalogFace {
pub face_index: Count,
pub source_path: CatalogText,
#[serde(deserialize_with = "required_nullable")]
pub oracle_id: Option<Id>,
pub characteristics: Characteristics,
}

/// Validate the generated wire constraints.
///
/// # Errors
/// Returns the violated constraint.
#[allow(clippy::trivially_copy_pass_by_ref, clippy::unnecessary_wraps)]
pub fn validate_catalog_face(value: &CatalogFace) -> Result<(), String> {
let field = &value.face_index;
validate_count(field).map_err(|e| format!("CatalogFace.face_index: {e}"))?;
let field = &value.source_path;
validate_catalog_text(field).map_err(|e| format!("CatalogFace.source_path: {e}"))?;
if let Some(field) = &value.oracle_id {
validate_id(field).map_err(|e| format!("CatalogFace.oracle_id: {e}"))?;
}
let field = &value.characteristics;
validate_characteristics(field).map_err(|e| format!("CatalogFace.characteristics: {e}"))?;
Ok(())
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CatalogSource {
#[serde(deserialize_with = "required_nullable")]
pub scryfall_id: Option<Id>,
#[serde(deserialize_with = "required_nullable")]
pub oracle_id: Option<Id>,
}

/// Validate the generated wire constraints.
///
/// # Errors
/// Returns the violated constraint.
#[allow(clippy::trivially_copy_pass_by_ref, clippy::unnecessary_wraps)]
pub fn validate_catalog_source(value: &CatalogSource) -> Result<(), String> {
if let Some(field) = &value.scryfall_id {
validate_id(field).map_err(|e| format!("CatalogSource.scryfall_id: {e}"))?;
}
if let Some(field) = &value.oracle_id {
validate_id(field).map_err(|e| format!("CatalogSource.oracle_id: {e}"))?;
}
Ok(())
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RelatedCard {
pub id: Id,
pub component: CatalogText,
pub name: CatalogText,
pub type_line: CatalogText,
pub uri: CatalogText,
#[serde(default, skip_serializing_if = "Option::is_none")]
pub object: Option<CatalogText>,
}

/// Validate the generated wire constraints.
///
/// # Errors
/// Returns the violated constraint.
#[allow(clippy::trivially_copy_pass_by_ref, clippy::unnecessary_wraps)]
pub fn validate_related_card(value: &RelatedCard) -> Result<(), String> {
let field = &value.id;
validate_id(field).map_err(|e| format!("RelatedCard.id: {e}"))?;
let field = &value.component;
validate_catalog_text(field).map_err(|e| format!("RelatedCard.component: {e}"))?;
let field = &value.name;
validate_catalog_text(field).map_err(|e| format!("RelatedCard.name: {e}"))?;
let field = &value.type_line;
validate_catalog_text(field).map_err(|e| format!("RelatedCard.type_line: {e}"))?;
let field = &value.uri;
validate_catalog_text(field).map_err(|e| format!("RelatedCard.uri: {e}"))?;
if let Some(field) = &value.object {
validate_catalog_text(field).map_err(|e| format!("RelatedCard.object: {e}"))?;
}
Ok(())
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CatalogGameplay {
pub version: CatalogVersion,
pub source: CatalogSource,
#[serde(deserialize_with = "required_nullable")]
pub layout: Option<CatalogText>,
#[serde(deserialize_with = "required_nullable")]
pub color_identity: Option<Vec<ColorCode>>,
pub face_relationship: FaceRelationship,
pub playability: Playability,
pub characteristics: Characteristics,
#[serde(deserialize_with = "required_nullable")]
pub faces: Option<Vec<CatalogFace>>,
#[serde(deserialize_with = "required_nullable")]
pub related_cards: Option<Vec<RelatedCard>>,
}

/// Validate the generated wire constraints.
///
/// # Errors
/// Returns the violated constraint.
#[allow(clippy::trivially_copy_pass_by_ref, clippy::unnecessary_wraps)]
pub fn validate_catalog_gameplay(value: &CatalogGameplay) -> Result<(), String> {
let field = &value.version;
validate_catalog_version(field).map_err(|e| format!("CatalogGameplay.version: {e}"))?;
let field = &value.source;
validate_catalog_source(field).map_err(|e| format!("CatalogGameplay.source: {e}"))?;
if let Some(field) = &value.layout {
validate_catalog_text(field).map_err(|e| format!("CatalogGameplay.layout: {e}"))?;
}
if let Some(field) = &value.color_identity {
if !(0..=5).contains(&field.len()) {
return Err("CatalogGameplay.color_identity length outside contract bounds".to_owned());
}
for item in field {
validate_color_code(item).map_err(|e| format!("CatalogGameplay.color_identity: {e}"))?;
}
}
let field = &value.face_relationship;
validate_face_relationship(field).map_err(|e| format!("CatalogGameplay.face_relationship: {e}"))?;
let field = &value.playability;
validate_playability(field).map_err(|e| format!("CatalogGameplay.playability: {e}"))?;
let field = &value.characteristics;
validate_characteristics(field).map_err(|e| format!("CatalogGameplay.characteristics: {e}"))?;
if let Some(field) = &value.faces {
if !(1..=16).contains(&field.len()) {
return Err("CatalogGameplay.faces length outside contract bounds".to_owned());
}
for item in field {
validate_catalog_face(item).map_err(|e| format!("CatalogGameplay.faces: {e}"))?;
}
}
if let Some(field) = &value.related_cards {
if !(0..=256).contains(&field.len()) {
return Err("CatalogGameplay.related_cards length outside contract bounds".to_owned());
}
for item in field {
validate_related_card(item).map_err(|e| format!("CatalogGameplay.related_cards: {e}"))?;
}
}
Ok(())
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CatalogRecord {
pub oracle_id: Id,
pub gameplay: CatalogGameplay,
pub printing_ids: Vec<Id>,
}

/// Validate the generated wire constraints.
///
/// # Errors
/// Returns the violated constraint.
#[allow(clippy::trivially_copy_pass_by_ref, clippy::unnecessary_wraps)]
pub fn validate_catalog_record(value: &CatalogRecord) -> Result<(), String> {
let field = &value.oracle_id;
validate_id(field).map_err(|e| format!("CatalogRecord.oracle_id: {e}"))?;
let field = &value.gameplay;
validate_catalog_gameplay(field).map_err(|e| format!("CatalogRecord.gameplay: {e}"))?;
let field = &value.printing_ids;
if !(0..=4_096).contains(&field.len()) {
return Err("CatalogRecord.printing_ids length outside contract bounds".to_owned());
}
for item in field {
validate_id(item).map_err(|e| format!("CatalogRecord.printing_ids: {e}"))?;
}
Ok(())
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CatalogEntry {
pub oracle_id: Id,
pub qty: Positive,
#[serde(deserialize_with = "required_nullable")]
pub printing_id: Option<Id>,
}

/// Validate the generated wire constraints.
///
/// # Errors
/// Returns the violated constraint.
#[allow(clippy::trivially_copy_pass_by_ref, clippy::unnecessary_wraps)]
pub fn validate_catalog_entry(value: &CatalogEntry) -> Result<(), String> {
let field = &value.oracle_id;
validate_id(field).map_err(|e| format!("CatalogEntry.oracle_id: {e}"))?;
let field = &value.qty;
validate_positive(field).map_err(|e| format!("CatalogEntry.qty: {e}"))?;
if let Some(field) = &value.printing_id {
validate_id(field).map_err(|e| format!("CatalogEntry.printing_id: {e}"))?;
}
Ok(())
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]

pub enum DeckFormat {
#[serde(rename = "commander")]
Commander,
}

/// Validate the generated wire constraints.
///
/// # Errors
/// Returns the violated constraint.
#[allow(clippy::trivially_copy_pass_by_ref, clippy::unnecessary_wraps)]
pub fn validate_deck_format(_value: &DeckFormat) -> Result<(), String> {
Ok(())
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]

pub enum CommandZoneKind {
#[serde(rename = "single")]
Single,
#[serde(rename = "partner")]
Partner,
#[serde(rename = "background")]
Background,
#[serde(rename = "doctor_companion")]
DoctorCompanion,
}

/// Validate the generated wire constraints.
///
/// # Errors
/// Returns the violated constraint.
#[allow(clippy::trivially_copy_pass_by_ref, clippy::unnecessary_wraps)]
pub fn validate_command_zone_kind(_value: &CommandZoneKind) -> Result<(), String> {
Ok(())
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CapturedDeck {
pub deck_id: Id,
pub version: Positive,
pub data_snapshot: Id,
pub format: DeckFormat,
pub command_zone_kind: CommandZoneKind,
pub computed_color_identity: Vec<ColorCode>,
pub commanders: Vec<CatalogEntry>,
pub cards: Vec<CatalogEntry>,
#[serde(deserialize_with = "required_nullable")]
pub companion: Option<CatalogEntry>,
}

/// Validate the generated wire constraints.
///
/// # Errors
/// Returns the violated constraint.
#[allow(clippy::trivially_copy_pass_by_ref, clippy::unnecessary_wraps)]
pub fn validate_captured_deck(value: &CapturedDeck) -> Result<(), String> {
let field = &value.deck_id;
validate_id(field).map_err(|e| format!("CapturedDeck.deck_id: {e}"))?;
let field = &value.version;
validate_positive(field).map_err(|e| format!("CapturedDeck.version: {e}"))?;
let field = &value.data_snapshot;
validate_id(field).map_err(|e| format!("CapturedDeck.data_snapshot: {e}"))?;
let field = &value.format;
validate_deck_format(field).map_err(|e| format!("CapturedDeck.format: {e}"))?;
let field = &value.command_zone_kind;
validate_command_zone_kind(field).map_err(|e| format!("CapturedDeck.command_zone_kind: {e}"))?;
let field = &value.computed_color_identity;
if !(0..=5).contains(&field.len()) {
return Err("CapturedDeck.computed_color_identity length outside contract bounds".to_owned());
}
for item in field {
validate_color_code(item).map_err(|e| format!("CapturedDeck.computed_color_identity: {e}"))?;
}
let field = &value.commanders;
if !(1..=2).contains(&field.len()) {
return Err("CapturedDeck.commanders length outside contract bounds".to_owned());
}
for item in field {
validate_catalog_entry(item).map_err(|e| format!("CapturedDeck.commanders: {e}"))?;
}
let field = &value.cards;
if !(1..=1_000).contains(&field.len()) {
return Err("CapturedDeck.cards length outside contract bounds".to_owned());
}
for item in field {
validate_catalog_entry(item).map_err(|e| format!("CapturedDeck.cards: {e}"))?;
}
if let Some(field) = &value.companion {
validate_catalog_entry(field).map_err(|e| format!("CapturedDeck.companion: {e}"))?;
}
Ok(())
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CatalogPayload {
pub schema_version: CatalogVersion,
pub data_snapshot: Id,
pub index_revision: Digest,
pub deck: CapturedDeck,
pub records: Vec<CatalogRecord>,
}

/// Validate the generated wire constraints.
///
/// # Errors
/// Returns the violated constraint.
#[allow(clippy::trivially_copy_pass_by_ref, clippy::unnecessary_wraps)]
pub fn validate_catalog_payload(value: &CatalogPayload) -> Result<(), String> {
let field = &value.schema_version;
validate_catalog_version(field).map_err(|e| format!("CatalogPayload.schema_version: {e}"))?;
let field = &value.data_snapshot;
validate_id(field).map_err(|e| format!("CatalogPayload.data_snapshot: {e}"))?;
let field = &value.index_revision;
validate_digest(field).map_err(|e| format!("CatalogPayload.index_revision: {e}"))?;
let field = &value.deck;
validate_captured_deck(field).map_err(|e| format!("CatalogPayload.deck: {e}"))?;
let field = &value.records;
if !(1..=1_024).contains(&field.len()) {
return Err("CatalogPayload.records length outside contract bounds".to_owned());
}
for item in field {
validate_catalog_record(item).map_err(|e| format!("CatalogPayload.records: {e}"))?;
}
Ok(())
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CatalogEnvelope {
pub payload_json: CatalogJson,
pub payload_digest: Digest,
pub expected_index_revision: Digest,
pub expected_deck_id: Id,
pub expected_deck_version: Positive,
}

/// Validate the generated wire constraints.
///
/// # Errors
/// Returns the violated constraint.
#[allow(clippy::trivially_copy_pass_by_ref, clippy::unnecessary_wraps)]
pub fn validate_catalog_envelope(value: &CatalogEnvelope) -> Result<(), String> {
let field = &value.payload_json;
validate_catalog_json(field).map_err(|e| format!("CatalogEnvelope.payload_json: {e}"))?;
let field = &value.payload_digest;
validate_digest(field).map_err(|e| format!("CatalogEnvelope.payload_digest: {e}"))?;
let field = &value.expected_index_revision;
validate_digest(field).map_err(|e| format!("CatalogEnvelope.expected_index_revision: {e}"))?;
let field = &value.expected_deck_id;
validate_id(field).map_err(|e| format!("CatalogEnvelope.expected_deck_id: {e}"))?;
let field = &value.expected_deck_version;
validate_positive(field).map_err(|e| format!("CatalogEnvelope.expected_deck_version: {e}"))?;
Ok(())
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PreviewCatalogPayload {
pub schema_version: CatalogVersion,
pub data_snapshot: Id,
pub index_revision: Digest,
pub fixture_id: Id,
pub fixture_version: Positive,
pub fixture_digest: Digest,
pub cards: Vec<CatalogEntry>,
pub records: Vec<CatalogRecord>,
}

/// Validate the generated wire constraints.
///
/// # Errors
/// Returns the violated constraint.
#[allow(clippy::trivially_copy_pass_by_ref, clippy::unnecessary_wraps)]
pub fn validate_preview_catalog_payload(value: &PreviewCatalogPayload) -> Result<(), String> {
let field = &value.schema_version;
validate_catalog_version(field).map_err(|e| format!("PreviewCatalogPayload.schema_version: {e}"))?;
let field = &value.data_snapshot;
validate_id(field).map_err(|e| format!("PreviewCatalogPayload.data_snapshot: {e}"))?;
let field = &value.index_revision;
validate_digest(field).map_err(|e| format!("PreviewCatalogPayload.index_revision: {e}"))?;
let field = &value.fixture_id;
validate_id(field).map_err(|e| format!("PreviewCatalogPayload.fixture_id: {e}"))?;
let field = &value.fixture_version;
validate_positive(field).map_err(|e| format!("PreviewCatalogPayload.fixture_version: {e}"))?;
let field = &value.fixture_digest;
validate_digest(field).map_err(|e| format!("PreviewCatalogPayload.fixture_digest: {e}"))?;
let field = &value.cards;
if !(1..=16).contains(&field.len()) {
return Err("PreviewCatalogPayload.cards length outside contract bounds".to_owned());
}
for item in field {
validate_catalog_entry(item).map_err(|e| format!("PreviewCatalogPayload.cards: {e}"))?;
}
let field = &value.records;
if !(1..=16).contains(&field.len()) {
return Err("PreviewCatalogPayload.records length outside contract bounds".to_owned());
}
for item in field {
validate_catalog_record(item).map_err(|e| format!("PreviewCatalogPayload.records: {e}"))?;
}
Ok(())
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PreviewCatalogEnvelope {
pub payload_json: CatalogJson,
pub payload_digest: Digest,
pub expected_index_revision: Digest,
pub expected_fixture_id: Id,
pub expected_fixture_version: Positive,
}

/// Validate the generated wire constraints.
///
/// # Errors
/// Returns the violated constraint.
#[allow(clippy::trivially_copy_pass_by_ref, clippy::unnecessary_wraps)]
pub fn validate_preview_catalog_envelope(value: &PreviewCatalogEnvelope) -> Result<(), String> {
let field = &value.payload_json;
validate_catalog_json(field).map_err(|e| format!("PreviewCatalogEnvelope.payload_json: {e}"))?;
let field = &value.payload_digest;
validate_digest(field).map_err(|e| format!("PreviewCatalogEnvelope.payload_digest: {e}"))?;
let field = &value.expected_index_revision;
validate_digest(field).map_err(|e| format!("PreviewCatalogEnvelope.expected_index_revision: {e}"))?;
let field = &value.expected_fixture_id;
validate_id(field).map_err(|e| format!("PreviewCatalogEnvelope.expected_fixture_id: {e}"))?;
let field = &value.expected_fixture_version;
validate_positive(field).map_err(|e| format!("PreviewCatalogEnvelope.expected_fixture_version: {e}"))?;
Ok(())
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(tag = "type", content = "data", deny_unknown_fields)]
pub enum ProfileCatalog {
#[serde(rename = "commander")]
Commander(CatalogEnvelope),
#[serde(rename = "preview_fixture")]
PreviewFixture(PreviewCatalogEnvelope),
}

/// Validate the generated wire constraints.
///
/// # Errors
/// Returns the violated constraint.
#[allow(clippy::trivially_copy_pass_by_ref, clippy::unnecessary_wraps)]
pub fn validate_profile_catalog(value: &ProfileCatalog) -> Result<(), String> {
match value {
ProfileCatalog::Commander(data) => validate_catalog_envelope(data),
ProfileCatalog::PreviewFixture(data) => validate_preview_catalog_envelope(data),
}
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]

pub enum SupportProfile {
#[serde(rename = "commander")]
Commander,
#[serde(rename = "internal_fixture_v1")]
InternalFixtureV1,
}

/// Validate the generated wire constraints.
///
/// # Errors
/// Returns the violated constraint.
#[allow(clippy::trivially_copy_pass_by_ref, clippy::unnecessary_wraps)]
pub fn validate_support_profile(_value: &SupportProfile) -> Result<(), String> {
Ok(())
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SupportRequirement {
pub id: CatalogText,
pub path: CatalogText,
#[serde(deserialize_with = "required_nullable")]
pub face_index: Option<Count>,
#[serde(deserialize_with = "required_nullable")]
pub start: Option<Count>,
#[serde(deserialize_with = "required_nullable")]
pub end: Option<Count>,
pub qualified: Flag,
pub reason: CatalogText,
#[serde(deserialize_with = "required_nullable")]
pub implementation: Option<CatalogText>,
#[serde(deserialize_with = "required_nullable")]
pub evidence: Option<CatalogText>,
}

/// Validate the generated wire constraints.
///
/// # Errors
/// Returns the violated constraint.
#[allow(clippy::trivially_copy_pass_by_ref, clippy::unnecessary_wraps)]
pub fn validate_support_requirement(value: &SupportRequirement) -> Result<(), String> {
let field = &value.id;
validate_catalog_text(field).map_err(|e| format!("SupportRequirement.id: {e}"))?;
let field = &value.path;
validate_catalog_text(field).map_err(|e| format!("SupportRequirement.path: {e}"))?;
if let Some(field) = &value.face_index {
validate_count(field).map_err(|e| format!("SupportRequirement.face_index: {e}"))?;
}
if let Some(field) = &value.start {
validate_count(field).map_err(|e| format!("SupportRequirement.start: {e}"))?;
}
if let Some(field) = &value.end {
validate_count(field).map_err(|e| format!("SupportRequirement.end: {e}"))?;
}
let field = &value.qualified;
validate_flag(field).map_err(|e| format!("SupportRequirement.qualified: {e}"))?;
let field = &value.reason;
validate_catalog_text(field).map_err(|e| format!("SupportRequirement.reason: {e}"))?;
if let Some(field) = &value.implementation {
validate_catalog_text(field).map_err(|e| format!("SupportRequirement.implementation: {e}"))?;
}
if let Some(field) = &value.evidence {
validate_catalog_text(field).map_err(|e| format!("SupportRequirement.evidence: {e}"))?;
}
Ok(())
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SupportReport {
pub profile: SupportProfile,
pub oracle_id: Id,
pub source_digest: Digest,
pub oracle_text_digest: Digest,
pub face_digests: Vec<Digest>,
pub implementation_version: Id,
pub implementation_digest: Digest,
pub registry_digest: Digest,
pub corpus_digest: Digest,
pub source_matches: Flag,
pub supported: Flag,
pub owners: Vec<Id>,
pub expected_scenarios: Vec<CatalogText>,
pub requirements: Vec<SupportRequirement>,
}

/// Validate the generated wire constraints.
///
/// # Errors
/// Returns the violated constraint.
#[allow(clippy::trivially_copy_pass_by_ref, clippy::unnecessary_wraps)]
pub fn validate_support_report(value: &SupportReport) -> Result<(), String> {
let field = &value.profile;
validate_support_profile(field).map_err(|e| format!("SupportReport.profile: {e}"))?;
let field = &value.oracle_id;
validate_id(field).map_err(|e| format!("SupportReport.oracle_id: {e}"))?;
let field = &value.source_digest;
validate_digest(field).map_err(|e| format!("SupportReport.source_digest: {e}"))?;
let field = &value.oracle_text_digest;
validate_digest(field).map_err(|e| format!("SupportReport.oracle_text_digest: {e}"))?;
let field = &value.face_digests;
if !(0..=16).contains(&field.len()) {
return Err("SupportReport.face_digests length outside contract bounds".to_owned());
}
for item in field {
validate_digest(item).map_err(|e| format!("SupportReport.face_digests: {e}"))?;
}
let field = &value.implementation_version;
validate_id(field).map_err(|e| format!("SupportReport.implementation_version: {e}"))?;
let field = &value.implementation_digest;
validate_digest(field).map_err(|e| format!("SupportReport.implementation_digest: {e}"))?;
let field = &value.registry_digest;
validate_digest(field).map_err(|e| format!("SupportReport.registry_digest: {e}"))?;
let field = &value.corpus_digest;
validate_digest(field).map_err(|e| format!("SupportReport.corpus_digest: {e}"))?;
let field = &value.source_matches;
validate_flag(field).map_err(|e| format!("SupportReport.source_matches: {e}"))?;
let field = &value.supported;
validate_flag(field).map_err(|e| format!("SupportReport.supported: {e}"))?;
let field = &value.owners;
if !(0..=64).contains(&field.len()) {
return Err("SupportReport.owners length outside contract bounds".to_owned());
}
for item in field {
validate_id(item).map_err(|e| format!("SupportReport.owners: {e}"))?;
}
let field = &value.expected_scenarios;
if !(0..=256).contains(&field.len()) {
return Err("SupportReport.expected_scenarios length outside contract bounds".to_owned());
}
for item in field {
validate_catalog_text(item).map_err(|e| format!("SupportReport.expected_scenarios: {e}"))?;
}
let field = &value.requirements;
if !(0..=2_048).contains(&field.len()) {
return Err("SupportReport.requirements length outside contract bounds".to_owned());
}
for item in field {
validate_support_requirement(item).map_err(|e| format!("SupportReport.requirements: {e}"))?;
}
Ok(())
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SupportCheck {
pub catalog: ProfileCatalog,
pub oracle_id: Id,
pub expected_implementation_version: Id,
#[serde(deserialize_with = "required_nullable")]
pub expected_implementation_digest: Option<Digest>,
}

/// Validate the generated wire constraints.
///
/// # Errors
/// Returns the violated constraint.
#[allow(clippy::trivially_copy_pass_by_ref, clippy::unnecessary_wraps)]
pub fn validate_support_check(value: &SupportCheck) -> Result<(), String> {
let field = &value.catalog;
validate_profile_catalog(field).map_err(|e| format!("SupportCheck.catalog: {e}"))?;
let field = &value.oracle_id;
validate_id(field).map_err(|e| format!("SupportCheck.oracle_id: {e}"))?;
let field = &value.expected_implementation_version;
validate_id(field).map_err(|e| format!("SupportCheck.expected_implementation_version: {e}"))?;
if let Some(field) = &value.expected_implementation_digest {
validate_digest(field).map_err(|e| format!("SupportCheck.expected_implementation_digest: {e}"))?;
}
Ok(())
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ProfilePreflight {
pub scenario: Scenario,
pub catalog: ProfileCatalog,
pub expected_implementation_version: Id,
#[serde(deserialize_with = "required_nullable")]
pub expected_implementation_digest: Option<Digest>,
}

/// Validate the generated wire constraints.
///
/// # Errors
/// Returns the violated constraint.
#[allow(clippy::trivially_copy_pass_by_ref, clippy::unnecessary_wraps)]
pub fn validate_profile_preflight(value: &ProfilePreflight) -> Result<(), String> {
let field = &value.scenario;
validate_scenario(field).map_err(|e| format!("ProfilePreflight.scenario: {e}"))?;
let field = &value.catalog;
validate_profile_catalog(field).map_err(|e| format!("ProfilePreflight.catalog: {e}"))?;
let field = &value.expected_implementation_version;
validate_id(field).map_err(|e| format!("ProfilePreflight.expected_implementation_version: {e}"))?;
if let Some(field) = &value.expected_implementation_digest {
validate_digest(field).map_err(|e| format!("ProfilePreflight.expected_implementation_digest: {e}"))?;
}
Ok(())
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ProfilePreflightReport {
pub profile: SupportProfile,
pub fixture_id: Id,
pub fixture_version: Positive,
pub fixture_digest: Digest,
pub catalog_digest: Digest,
pub scenario_digest: Digest,
pub implementation_version: Id,
pub implementation_digest: Digest,
pub qualified: Flag,
pub reports: Vec<SupportReport>,
}

/// Validate the generated wire constraints.
///
/// # Errors
/// Returns the violated constraint.
#[allow(clippy::trivially_copy_pass_by_ref, clippy::unnecessary_wraps)]
pub fn validate_profile_preflight_report(value: &ProfilePreflightReport) -> Result<(), String> {
let field = &value.profile;
validate_support_profile(field).map_err(|e| format!("ProfilePreflightReport.profile: {e}"))?;
let field = &value.fixture_id;
validate_id(field).map_err(|e| format!("ProfilePreflightReport.fixture_id: {e}"))?;
let field = &value.fixture_version;
validate_positive(field).map_err(|e| format!("ProfilePreflightReport.fixture_version: {e}"))?;
let field = &value.fixture_digest;
validate_digest(field).map_err(|e| format!("ProfilePreflightReport.fixture_digest: {e}"))?;
let field = &value.catalog_digest;
validate_digest(field).map_err(|e| format!("ProfilePreflightReport.catalog_digest: {e}"))?;
let field = &value.scenario_digest;
validate_digest(field).map_err(|e| format!("ProfilePreflightReport.scenario_digest: {e}"))?;
let field = &value.implementation_version;
validate_id(field).map_err(|e| format!("ProfilePreflightReport.implementation_version: {e}"))?;
let field = &value.implementation_digest;
validate_digest(field).map_err(|e| format!("ProfilePreflightReport.implementation_digest: {e}"))?;
let field = &value.qualified;
validate_flag(field).map_err(|e| format!("ProfilePreflightReport.qualified: {e}"))?;
let field = &value.reports;
if !(1..=16).contains(&field.len()) {
return Err("ProfilePreflightReport.reports length outside contract bounds".to_owned());
}
for item in field {
validate_support_report(item).map_err(|e| format!("ProfilePreflightReport.reports: {e}"))?;
}
Ok(())
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Admission {
pub scenario: Scenario,
pub catalog: ProfileCatalog,
pub expected_implementation_version: Id,
#[serde(deserialize_with = "required_nullable")]
pub expected_implementation_digest: Option<Digest>,
}

/// Validate the generated wire constraints.
///
/// # Errors
/// Returns the violated constraint.
#[allow(clippy::trivially_copy_pass_by_ref, clippy::unnecessary_wraps)]
pub fn validate_admission(value: &Admission) -> Result<(), String> {
let field = &value.scenario;
validate_scenario(field).map_err(|e| format!("Admission.scenario: {e}"))?;
let field = &value.catalog;
validate_profile_catalog(field).map_err(|e| format!("Admission.catalog: {e}"))?;
let field = &value.expected_implementation_version;
validate_id(field).map_err(|e| format!("Admission.expected_implementation_version: {e}"))?;
if let Some(field) = &value.expected_implementation_digest {
validate_digest(field).map_err(|e| format!("Admission.expected_implementation_digest: {e}"))?;
}
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
Admit(Admission),
#[serde(rename = "run")]
Run(Run),
#[serde(rename = "decision")]
Decision(Decision),
#[serde(rename = "cancel")]
Cancel(Cancel),
#[serde(rename = "catalog_check")]
CatalogCheck(ProfileCatalog),
#[serde(rename = "support_check")]
SupportCheck(SupportCheck),
#[serde(rename = "profile_preflight")]
ProfilePreflight(ProfilePreflight),
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
RequestMessage::Admit(data) => validate_admission(data),
RequestMessage::Run(data) => validate_run(data),
RequestMessage::Decision(data) => validate_decision(data),
RequestMessage::Cancel(data) => validate_cancel(data),
RequestMessage::CatalogCheck(data) => validate_profile_catalog(data),
RequestMessage::SupportCheck(data) => validate_support_check(data),
RequestMessage::ProfilePreflight(data) => validate_profile_preflight(data),
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
pub reason: Text,
pub initial_state_hash: Digest,
pub final_state_hash: Digest,
pub turns: Count,
pub actions: Count,
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
let field = &value.reason;
validate_text(field).map_err(|e| format!("Completed.reason: {e}"))?;
let field = &value.initial_state_hash;
validate_digest(field).map_err(|e| format!("Completed.initial_state_hash: {e}"))?;
let field = &value.final_state_hash;
validate_digest(field).map_err(|e| format!("Completed.final_state_hash: {e}"))?;
let field = &value.turns;
validate_count(field).map_err(|e| format!("Completed.turns: {e}"))?;
let field = &value.actions;
validate_count(field).map_err(|e| format!("Completed.actions: {e}"))?;
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
pub catalog_digest: Digest,
pub initial_state_hash: Digest,
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
let field = &value.catalog_digest;
validate_digest(field).map_err(|e| format!("Admitted.catalog_digest: {e}"))?;
let field = &value.initial_state_hash;
validate_digest(field).map_err(|e| format!("Admitted.initial_state_hash: {e}"))?;
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
#[serde(rename = "catalog_checked")]
CatalogChecked(ProfileCatalog),
#[serde(rename = "support_checked")]
SupportChecked(SupportReport),
#[serde(rename = "profile_preflighted")]
ProfilePreflighted(ProfilePreflightReport),
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
ResponseMessage::CatalogChecked(data) => validate_profile_catalog(data),
ResponseMessage::SupportChecked(data) => validate_support_report(data),
ResponseMessage::ProfilePreflighted(data) => validate_profile_preflight_report(data),
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

