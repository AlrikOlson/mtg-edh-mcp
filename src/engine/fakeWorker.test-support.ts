/**
 * A protocol-6-shaped fake worker for supervisor and transport fault injection.
 *
 * It is plain JavaScript executed through `node -e`, so tests exercise the real
 * supervisor against a real child process without a shell and without any
 * build step. It never touches game state; every reply is a fixed shape that
 * satisfies the generated response schema so the parent's decoder accepts it.
 */
import {
  ENGINE_VERSION,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  SCHEMA_SHA256,
} from "./protocol.generated.js";

export type FakeWorkerMode =
  | "complete"
  | "hang"
  | "immortal"
  | "crash"
  | "malformed"
  | "flood"
  | "slow"
  | "ignore-cancel"
  | "immortal-ignore-cancel"
  | "unsupported"
  | "engine_error"
  | "stderr"
  | "rogue"
  | "quiet-exit"
  | "decision";

const SOURCE = String.raw`
const [mode, protocolVersion, engineVersion, schemaSha256, maxFrameBytes] = process.argv.slice(1);
const readline = require("node:readline");
const zeros = "0".repeat(64);
const write = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const outcome = (request_id, type, data) => write({ request_id, message: { type: "outcome", data: { type, data } } });
let sequence = 0, live = null, timer = null;
if (mode.startsWith("immortal")) { process.on("SIGTERM", () => {}); process.on("SIGINT", () => {}); }
// A hung worker must outlive its closed pipes; only a signal ends it.
if (mode === "hang" || mode.startsWith("immortal")) setInterval(() => {}, 1000);
const progress = (request_id, turns) => write({
  request_id,
  message: { type: "event", data: { event_id: "e" + sequence, sequence: sequence++, data: { type: "progress", data: { trial_index: 0, turns, actions: turns * 3 } } } },
});
const completed = (request_id, turns) => outcome(request_id, "completed", {
  winner_seats: [0], reason: "life_reached_zero", initial_state_hash: zeros, final_state_hash: "1".repeat(64), turns, actions: turns * 3,
});
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return outcome(undefined, "invalid", { code: "malformed_frame", message: "malformed" }); }
  const { request_id, message } = request;
  switch (message.type) {
    case "hello":
      return write({ request_id, message: { type: "hello", data: {
        protocol_version: Number(protocolVersion), engine_version: engineVersion, schema_sha256: schemaSha256,
        max_frame_bytes: Number(maxFrameBytes), admission: true, execution: true, decisions: true, cancellation: true } } });
    case "admit":
      return write({ request_id, message: { type: "admitted", data: {
        admission_id: "fake-admission", scenario_digest: "a".repeat(64), catalog_digest: "b".repeat(64), initial_state_hash: zeros } } });
    case "cancel":
      if (live && live.request_id === message.data.run_request_id && mode === "slow") {
        clearInterval(timer);
        outcome(live.request_id, "cancelled", {});
        live = null;
        return outcome(request_id, "cancelled", {});
      }
      if (mode === "ignore-cancel" || mode === "immortal-ignore-cancel") return;
      return outcome(request_id, "invalid", { code: "cancel_late", message: "late" });
    case "run":
      live = { request_id };
      switch (mode) {
        case "complete": progress(request_id, 1); progress(request_id, 2); live = null; return completed(request_id, 2);
        case "hang": case "immortal": return;
        case "crash": process.exit(3);
        case "malformed": return process.stdout.write("{not json\n");
        case "rogue": return progress("nobody-asked", 1);
        case "flood": {
          const chunk = Buffer.alloc(65536, "x");
          timer = setInterval(() => { for (let i = 0; i < 16; i++) process.stdout.write(chunk); }, 1);
          return;
        }
        case "slow": case "ignore-cancel": case "immortal-ignore-cancel": {
          let turns = 0;
          timer = setInterval(() => progress(request_id, ++turns), 15);
          return;
        }
        case "unsupported": live = null; return outcome(request_id, "unsupported", { diagnostics: [{ code: "policy_unknown", message: "fake" }] });
        case "engine_error": live = null; return outcome(request_id, "engine_error", { code: "canonical_failure", message: "fake" });
        case "stderr": process.stderr.write("y".repeat(70000)); return;
        case "quiet-exit": process.exit(0);
        case "decision": {
          // One relayed priority decision, then the run completes or ends as declined.
          const options = [
            { option_id: "opt-0", kind: "play_land", summary: "play a land" },
            { option_id: "opt-1", kind: "pass_priority", summary: "pass priority" },
          ];
          live.suspended = { decision_id: "dec-0", seat: 0, state_hash: zeros, options: options.map((o) => o.option_id) };
          return write({ request_id, message: { type: "event", data: { event_id: "e" + sequence, sequence: sequence++, data: { type: "decision", data: {
            decision_id: "dec-0", seat: 0, kind: "priority", state_hash: zeros, observation_digest: zeros, options } } } } });
        }
      }
      return;
    case "decision": {
      const suspended = live && live.suspended;
      const invalid = (code) => outcome(request_id, "invalid", { code, message: code });
      if (!suspended || suspended.decision_id !== message.data.decision_id) return invalid("decision_unknown");
      if (suspended.seat !== message.data.seat) return invalid("decision_seat_mismatch");
      if (suspended.state_hash !== message.data.state_hash) return invalid("decision_stale");
      const answer = message.data.answer;
      if (answer.type === "option" && !suspended.options.includes(answer.data.option_id)) return invalid("decision_option_unknown");
      live.suspended = null;
      const option_id = answer.type === "option" ? answer.data.option_id : null;
      write({ request_id, message: { type: "decided", data: { decision_id: suspended.decision_id, seat: suspended.seat, option_id } } });
      const runId = live.request_id;
      live = null;
      if (option_id === null)
        return outcome(runId, "unsupported", { diagnostics: [{ code: "decision_declined", message: "declined", behavior_id: "decision:priority" }] });
      progress(runId, 1); progress(runId, 2);
      return completed(runId, 2);
    }
    default:
      return outcome(request_id, "invalid", { code: "unsupported_request", message: message.type });
  }
});
rl.on("close", () => { if (mode !== "flood" && !mode.startsWith("immortal") && mode !== "hang") setTimeout(() => process.exit(0), 5); });
`;

/** Argument array for `process.execPath` that runs the fake worker in `mode`. */
export function fakeWorkerArgs(mode: FakeWorkerMode): string[] {
  return [
    "-e",
    SOURCE,
    mode,
    String(PROTOCOL_VERSION),
    ENGINE_VERSION,
    SCHEMA_SHA256,
    String(MAX_FRAME_BYTES),
  ];
}
