/**
 * A fake browser filler worker for the parent-side service tests. It speaks the
 * filler frame protocol over stdio exactly as the real worker does, but opens
 * no browser: each mode scripts one behaviour (a complete fill, a failed one,
 * a fill that only ends on cancel, a crash, a probe without browsers). The
 * supervisor spawns it as `node <file>`, so a test writes the source for one
 * mode to a file and passes that path as the worker entry.
 */
export type FakeFillerMode = "complete" | "fail" | "hang-until-cancel" | "crash" | "no-browser";

const SOURCE = String.raw`
const readline = require("node:readline");
const write = (request_id, message) => process.stdout.write(JSON.stringify({ request_id, message }) + "\n");
const probe = {
  protocol_version: 1,
  platform: process.platform,
  playwright_version: "fake",
  chromium: { available: MODE !== "no-browser", executable: MODE !== "no-browser" ? "/fake/chromium" : null },
  chrome: { available: false, executable: null },
  install_command: "npx playwright install chromium",
};
let live = null;
let released = false;
let seenJobDir = null;
const release = () => {
  if (!live || released) return;
  released = true;
  write(live, { type: "released", data: {} });
  live = null;
  setTimeout(() => process.exit(0), 10);
};
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return write(null, { type: "invalid", data: { message: "malformed" } }); }
  const { request_id, message } = request;
  switch (message.type) {
    case "probe":
      return write(request_id, { type: "probe_result", data: probe });
    case "cancel":
      if (live === message.data.run_request_id) {
        write(live, { type: "outcome", data: { type: "cancelled", data: { step: "place_front" } } });
        write(request_id, { type: "outcome", data: { type: "cancelled", data: { step: null } } });
        release();
      } else {
        write(request_id, { type: "invalid", data: { message: "cancel_late" } });
      }
      return;
    case "fill": {
      live = request_id;
      seenJobDir = message.data.job_dir;
      if (MODE === "crash") process.exit(3);
      write(request_id, { type: "event", data: { step: "upload_front", slots_filled: 0, slots_total: 6, message: "uploading " + message.data.job_dir + " with " + message.data.browser + " profile " + message.data.profile_dir } });
      write(request_id, { type: "event", data: { step: "place_front", slots_filled: 3, slots_total: 6, message: "placed slot 2" } });
      if (MODE === "hang-until-cancel") return;
      if (MODE === "fail") {
        write(request_id, { type: "outcome", data: { type: "failed", data: { step: "place_front", message: "dnImg3_0_0 is not a slot any more", screenshot: message.data.job_dir + "/failure-place_front.png", instructions: "Open the saved project and continue by hand." } } });
      } else {
        write(request_id, { type: "event", data: { step: "to_review", slots_filled: 6, slots_total: 6, message: "review" } });
        write(request_id, { type: "outcome", data: { type: "filled", data: { ssid: "FAKESSID", project_name: "mtg-edh-print-fake", slots_total: 6, review_url: null } } });
      }
      // Hold the (imaginary) browser open until the parent ends input or cancels.
      return;
    }
    default:
      return write(request_id, { type: "invalid", data: { message: "unknown" } });
  }
});
rl.on("close", () => { if (live) release(); else process.exit(0); });
process.on("SIGTERM", () => { release(); setTimeout(() => process.exit(0), 10); });
setInterval(() => {}, 1000);
`;

/** The worker's source for one mode; write it to a `.cjs` file and spawn it with node. */
export function fakeFillerWorkerSource(mode: FakeFillerMode): string {
  return `const MODE = ${JSON.stringify(mode)};\n${SOURCE}`;
}
