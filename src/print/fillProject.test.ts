import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeMpcSite, type FakeProject } from "./fakeMpcSite.test-support.js";
import type { FillerEvent } from "./fillerProtocol.js";
import {
  FILL_STATE_FILENAME,
  FillStateSchema,
  fillProject,
  type FillProjectOptions,
} from "./fillProject.js";
import { imagePid } from "./mpcSite.js";
import {
  PRINT_CARDS_XML_FILENAME,
  PRINT_PROJECT_FILENAME,
  PrintProjectSchema,
} from "./projectFile.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const GOLDEN = PrintProjectSchema.parse(
  JSON.parse(readFileSync(join(FIXTURES, "printProject.golden.json"), "utf8")),
);

let jobDir: string;
beforeEach(() => {
  jobDir = mkdtempSync(join(tmpdir(), "fill-project-"));
  mkdirSync(join(jobDir, "images"));
  // Distinct bytes per image so every image has its own pid.
  for (const image of [...GOLDEN.fronts, ...GOLDEN.backs]) {
    writeFileSync(join(jobDir, image.path), `image:${image.path}`);
  }
  if (GOLDEN.card_back) writeFileSync(join(jobDir, GOLDEN.card_back), "image:card-back");
  writeFileSync(join(jobDir, PRINT_PROJECT_FILENAME), JSON.stringify(GOLDEN));
  writeFileSync(join(jobDir, PRINT_CARDS_XML_FILENAME), "<order/>");
});
afterEach(() => rmSync(jobDir, { recursive: true, force: true }));

function pidOf(path: string): string {
  return imagePid(readFileSync(join(jobDir, path)));
}

function run(site: FakeMpcSite, overrides: Partial<FillProjectOptions> = {}) {
  const events: FillerEvent[] = [];
  const outcome = fillProject({
    site,
    project: GOLDEN,
    jobDir,
    onEvent: (event) => events.push(event),
    signInTimeoutMs: 500,
    signInPollMs: 10,
    ...overrides,
  });
  return { events, outcome };
}

describe("fillProject", () => {
  it("creates one project and fills quantity, bracket, stock, foil, every front, the double-faced back and the card back, ending on the review screen", async () => {
    const site = new FakeMpcSite();
    const { events, outcome } = run(site);
    expect(await outcome).toEqual({
      type: "filled",
      data: {
        ssid: "SSID1",
        project_name: GOLDEN.project_name,
        slots_total: 6,
        review_url: "https://www.makeplayingcards.com/design/dn_preview_layout.aspx?ssid=SSID1",
      },
    });
    const project = site.projects.get("SSID1") as FakeProject;
    expect(project).toMatchObject({
      name: GOLDEN.project_name,
      stock: "(S33) Superior Smooth",
      bracket: 18,
      foil: true,
      quantity: 6,
      modes: { front: "different", back: "different" },
    });
    expect(project.slots.front).toEqual([
      pidOf("images/slot-001-front.png"),
      pidOf("images/slot-002-front.png"),
      pidOf("images/slot-002-front.png"),
      pidOf("images/slot-002-front.png"),
      pidOf("images/slot-002-front.png"),
      pidOf("images/slot-006-front.png"),
    ]);
    const cardBack = pidOf("images/card-back.png");
    expect(project.slots.back).toEqual([
      cardBack,
      cardBack,
      cardBack,
      cardBack,
      cardBack,
      pidOf("images/slot-006-back.png"),
    ]);
    // One upload per image, never one per slot.
    expect(site.calls.filter((call) => call.startsWith("upload:"))).toHaveLength(5);
    expect(project.saves).toBeGreaterThanOrEqual(2);
    expect(
      site.calls.filter((call) => call === "defineProject" || call.startsWith("defineProject:")),
    ).toHaveLength(1);
    expect(await site.stage()).toBe("preview");
    // Nothing after the review screen: the last site interaction is reaching it.
    const lastNext = site.calls.lastIndexOf("nextStep");
    expect(site.calls.slice(lastNext + 1).filter((call) => !call.startsWith("stage"))).toEqual([]);
    const filled = events.map((event) => event.slots_filled);
    expect(filled).toEqual([...filled].sort((a, b) => a - b));
    expect(events.at(-1)).toMatchObject({ step: "to_review", slots_filled: 6, slots_total: 6 });
    const state = FillStateSchema.parse(
      JSON.parse(readFileSync(join(jobDir, FILL_STATE_FILENAME), "utf8")),
    );
    expect(state).toMatchObject({
      version: 1,
      ssid: "SSID1",
      project_name: GOLDEN.project_name,
      placed: { fronts: [0, 1, 2, 3, 4, 5], backs: [0, 1, 2, 3, 4, 5] },
      last_step: "to_review",
    });
  });

  it("puts a shared card back on the single slot of the same-backs mode and skips backs entirely for the printer default", async () => {
    const shared = new FakeMpcSite();
    const sharedOutcome = await run(shared, { project: { ...GOLDEN, backs: [] } }).outcome;
    expect(sharedOutcome.type).toBe("filled");
    const sharedProject = shared.projects.get("SSID1") as FakeProject;
    expect(sharedProject.modes.back).toBe("same");
    expect(sharedProject.slots.back).toEqual([pidOf("images/card-back.png")]);

    const plain = new FakeMpcSite();
    const plainOutcome = await run(plain, { project: { ...GOLDEN, backs: [], card_back: null } })
      .outcome;
    expect(plainOutcome.type).toBe("filled");
    const plainProject = plain.projects.get("SSID1") as FakeProject;
    // Passing through the backs step with one shared, empty design is the printer's default back.
    expect(plainProject.modes.back).toBe("same");
    expect(plainProject.uploads.back).toEqual([]);
    expect(plainProject.slots.back).toEqual([null]);
    expect(await plain.stage()).toBe("preview");
  });

  it("resumes into the saved project with the job's name and places only the slots that are still empty", async () => {
    const alpha = pidOf("images/slot-001-front.png");
    const repeated = pidOf("images/slot-002-front.png");
    const saved: FakeProject = {
      ssid: "OLD1",
      name: GOLDEN.project_name,
      stock: "(S33) Superior Smooth",
      bracket: 18,
      foil: true,
      quantity: 6,
      modes: { front: "different", back: null },
      slots: { front: [alpha, repeated, null, null, null, null], back: [] },
      uploads: { front: [alpha, repeated], back: [] },
      saves: 1,
    };
    const site = new FakeMpcSite({ projects: [saved] });
    const { outcome } = run(site);
    expect(await outcome).toMatchObject({ type: "filled", data: { ssid: "OLD1" } });
    expect(site.calls).not.toContain(expect.stringMatching(/^defineProject/));
    expect(site.calls.filter((call) => call.startsWith("defineProject"))).toEqual([]);
    expect(site.calls).toContain(`findSavedProject:${GOLDEN.project_name}`);
    expect(site.calls).toContain("openSavedProject:OLD1");
    // The front mode was chosen in the earlier run; only the backs still need their mode.
    expect(site.calls.filter((call) => call.startsWith("chooseDesign:"))).toEqual([
      "chooseDesign:6|different",
    ]);
    expect(site.calls.indexOf("chooseDesign:6|different")).toBeGreaterThan(
      site.calls.indexOf("saveProject:" + GOLDEN.project_name),
    );
    // Fronts: the two placed slots stay untouched; the four empty ones are filled.
    const frontPlacements = site.calls.filter(
      (call) => call.startsWith("placeImage:") && call.endsWith(repeated),
    );
    expect(frontPlacements).toEqual([
      `placeImage:2|${repeated}`,
      `placeImage:3|${repeated}`,
      `placeImage:4|${repeated}`,
    ]);
    // Slot 0 (alpha) and slot 1 (the first repeated copy) already carried their fronts.
    expect(
      site.calls.filter((call) => call.startsWith("placeImage:") && call.endsWith(alpha)),
    ).toEqual([]);
    expect(site.calls).not.toContain(`placeImage:1|${repeated}`);
    expect(saved.slots.front).toEqual([
      alpha,
      repeated,
      repeated,
      repeated,
      repeated,
      pidOf("images/slot-006-front.png"),
    ]);
    expect(saved.slots.back).toHaveLength(6);
    expect(site.projects.size).toBe(1);
  });

  it("fails on site drift with the step name, a screenshot in the job directory, the retained files and continuation instructions", async () => {
    const site = new FakeMpcSite({ faults: { placeImage: "dnImg2_0_0 is not a slot any more" } });
    const { outcome } = run(site);
    const result = await outcome;
    expect(result.type).toBe("failed");
    if (result.type !== "failed") throw new Error("expected failure");
    expect(result.data.step).toBe("place_front");
    expect(result.data.message).toContain("dnImg2_0_0 is not a slot any more");
    expect(result.data.screenshot).toBe(join(jobDir, "failure-place_front.png"));
    expect(existsSync(result.data.screenshot ?? "")).toBe(true);
    expect(result.data.instructions).toContain(GOLDEN.project_name);
    expect(result.data.instructions).toContain(join(jobDir, PRINT_CARDS_XML_FILENAME));
    expect(result.data.instructions).toContain("makeplayingcards.com");
    expect(existsSync(join(jobDir, PRINT_PROJECT_FILENAME))).toBe(true);
    expect(existsSync(join(jobDir, PRINT_CARDS_XML_FILENAME))).toBe(true);
    const state = FillStateSchema.parse(
      JSON.parse(readFileSync(join(jobDir, FILL_STATE_FILENAME), "utf8")),
    );
    expect(state.ssid).toBe("SSID1");
    expect(state.last_step).toBe("place_front");
    // The project was saved before the failure so the account keeps the partial fill.
    expect((site.projects.get("SSID1") as FakeProject).saves).toBeGreaterThanOrEqual(1);
  });

  it("waits for the user to sign in, in the browser, and never receives a password", async () => {
    const site = new FakeMpcSite({ signedIn: false });
    let polls = 0;
    const originalIsSignedIn = site.isSignedIn.bind(site);
    site.isSignedIn = async () => {
      polls += 1;
      if (polls >= 3) site.signedIn = true;
      return originalIsSignedIn();
    };
    const { events, outcome } = run(site);
    expect((await outcome).type).toBe("filled");
    expect(site.calls).toContain("openSignIn");
    expect(events[0]).toMatchObject({ step: "sign_in", slots_filled: 0, slots_total: 6 });
    expect(events[0]?.message).toMatch(/sign in/i);
  });

  it("fails on the sign-in step when nobody signs in within the limit", async () => {
    const site = new FakeMpcSite({ signedIn: false });
    const result = await run(site, { signInTimeoutMs: 60, signInPollMs: 10 }).outcome;
    expect(result).toMatchObject({ type: "failed", data: { step: "sign_in" } });
    expect(site.calls.filter((call) => call.startsWith("defineProject"))).toEqual([]);
  });

  it("stops at the next step when cancelled and reports the step it was on", async () => {
    const site = new FakeMpcSite();
    const controller = new AbortController();
    const { outcome } = run(site, {
      signal: controller.signal,
      onEvent: (event) => {
        if (event.step === "place_front" && event.slots_filled === 2) controller.abort();
      },
    });
    const result = await outcome;
    expect(result.type).toBe("cancelled");
    const placements = site.calls.filter((call) => call.startsWith("placeImage:"));
    expect(placements.length).toBeLessThan(6);
    expect(await site.stage()).toBe("front_designer");
  });

  it("refuses a designer whose slot count does not match the order instead of guessing", async () => {
    const site = new FakeMpcSite();
    const original = site.chooseDesign.bind(site);
    site.chooseDesign = async (quantity, mode) => {
      await original(quantity, mode);
      (site.project as FakeProject).slots.front = [null, null];
    };
    const result = await run(site).outcome;
    expect(result).toMatchObject({ type: "failed", data: { step: "fronts_mode" } });
    if (result.type === "failed") expect(result.data.message).toMatch(/2 slots.*6/);
  });
});
