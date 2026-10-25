import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FILL_STATE_FILENAME, fillProject } from "./fillProject.js";
import {
  installMpcFixture,
  newFixtureProject,
  type FixtureOptions,
  type FixtureState,
} from "./mpcFixture.test-support.js";
import {
  MPC_BASE_URL,
  MPC_FOIL_EFFECT,
  MPC_PATHS,
  MPC_SELECTORS,
  PlaywrightMpcSite,
  imagePid,
} from "./mpcSite.js";
import {
  PRINT_CARDS_XML_FILENAME,
  PRINT_PROJECT_FILENAME,
  PrintProjectSchema,
} from "./projectFile.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const executable = chromium.executablePath();
const browserAvailable = existsSync(executable);
/**
 * The adapter is exercised in headless Chromium against the recorded pages.
 * Without the bundled browser (CI installs none) the scenarios are skipped,
 * not passed; `npx playwright install chromium` enables them.
 */
const withBrowser = it.skipIf(!browserAvailable);

let browser: Browser | null = null;
let context: BrowserContext;
let page: Page;
let jobDir: string;

beforeAll(async () => {
  if (browserAvailable) browser = await chromium.launch({ headless: true });
}, 60_000);
afterAll(async () => {
  await browser?.close();
});
beforeEach(async () => {
  jobDir = mkdtempSync(join(tmpdir(), "mpc-site-"));
  mkdirSync(join(jobDir, "images"));
  writeFileSync(join(jobDir, "images", "a.png"), "image:a");
  writeFileSync(join(jobDir, "images", "b.png"), "image:b");
  if (browser) {
    context = await browser.newContext();
    page = await context.newPage();
  }
});
afterEach(async () => {
  if (browser) await context.close();
  rmSync(jobDir, { recursive: true, force: true });
});

async function site(
  options: FixtureOptions = {},
): Promise<{ site: PlaywrightMpcSite; state: FixtureState }> {
  const state = await installMpcFixture(page, options);
  return { site: new PlaywrightMpcSite(page, { timeoutMs: 5_000 }), state };
}

describe("imagePid", () => {
  it("is the upper-case SHA-1 of the file bytes, as the printer's upload list reports it", () => {
    const bytes = Buffer.from("image:a");
    expect(imagePid(bytes)).toBe(createHash("sha1").update(bytes).digest("hex").toUpperCase());
    expect(imagePid(bytes)).toMatch(/^[0-9A-F]{40}$/);
  });
});

describe("mpc site constants", () => {
  it("name the recorded pages, selectors and the foil effect", () => {
    expect(MPC_BASE_URL).toBe("https://www.makeplayingcards.com");
    expect(MPC_PATHS.product).toBe("/design/custom-blank-card.html");
    expect(MPC_PATHS.frontDesigner).toBe(
      "/products/playingcard/design/dn_playingcards_front_dynamic.aspx",
    );
    expect(MPC_PATHS.savedProjects).toBe("/design/dn_temporary_designes.aspx");
    expect(MPC_PATHS.preview).toBe("/design/dn_preview_layout.aspx");
    expect(MPC_SELECTORS.stock).toBe("#dro_paper_type");
    expect(MPC_SELECTORS.bracket).toBe("#dro_choosesize");
    expect(MPC_SELECTORS.effect).toBe("#dro_product_effect");
    expect(MPC_SELECTORS.upload).toBe("#uploadId");
    expect(MPC_SELECTORS.signedIn).toBe('a[href*="logout.aspx"]');
    expect(MPC_FOIL_EFFECT).toBe("EF_055");
  });
});

describe("PlaywrightMpcSite against the recorded pages", () => {
  withBrowser(
    "defines a project with the stock by its visible text, the bracket by value and the foil effect, landing on the front designer",
    async () => {
      const { site: mpc, state } = await site();
      await mpc.open();
      expect(await mpc.stage()).toBe("product");
      const ssid = await mpc.defineProject({
        stock: "(S33) Superior Smooth",
        bracket: 36,
        foil: true,
      });
      expect(ssid).toMatch(/^FX\d+$/);
      expect(state.projects.get(ssid)).toMatchObject({
        stock: "PA_059",
        size: "36",
        effect: "EF_055",
      });
      expect(await mpc.stage()).toBe("front_designer");
      expect(await mpc.ssid()).toBe(ssid);
      expect(await mpc.needsDesignChoice()).toBe(true);

      const plain = await site();
      await plain.site.open();
      const plainSsid = await plain.site.defineProject({
        stock: "(S30) Standard Smooth",
        bracket: 18,
        foil: false,
      });
      expect(plain.state.projects.get(plainSsid)).toMatchObject({
        stock: "PA_014",
        size: "18",
        effect: "",
      });
    },
    30_000,
  );

  withBrowser(
    "answers the mode frame, uploads each image once, places images by slot and reads the slots back",
    async () => {
      const { site: mpc, state } = await site();
      await mpc.open();
      const ssid = await mpc.defineProject({
        stock: "(S30) Standard Smooth",
        bracket: 18,
        foil: false,
      });
      await mpc.chooseDesign(6, "different");
      expect(await mpc.needsDesignChoice()).toBe(false);
      expect(await mpc.slotCount()).toBe(6);
      expect(state.projects.get(ssid)).toMatchObject({
        quantity: 6,
        modes: { front: "different", back: null },
      });
      expect(await mpc.uploadedPids()).toEqual([]);

      const a = join(jobDir, "images", "a.png");
      const pid = await mpc.upload(a);
      expect(pid).toBe(imagePid(readFileSync(a)));
      expect(await mpc.uploadedPids()).toEqual([pid]);
      expect(await mpc.upload(a)).toBe(pid);
      expect(state.requests.filter((request) => request.includes("/fixture/upload"))).toHaveLength(
        1,
      );

      expect(await mpc.slotPid(2)).toBeNull();
      await mpc.placeImage(2, pid);
      expect(await mpc.slotPid(2)).toBe(pid);
      expect(await mpc.slotPid(3)).toBeNull();
      expect(state.projects.get(ssid)?.slots.front[2]).toBe(pid);
      await expect(mpc.slotPid(7)).rejects.toThrow(/slot 7/);
      await expect(mpc.placeImage(1, "NOTUPLOADED")).rejects.toThrow(/slot 1/);
    },
    30_000,
  );

  withBrowser(
    "saves the project under the job's name, finds it among the saved projects and reopens it with its slots intact",
    async () => {
      const { site: mpc, state } = await site();
      await mpc.open();
      const ssid = await mpc.defineProject({
        stock: "(S30) Standard Smooth",
        bracket: 18,
        foil: false,
      });
      await mpc.chooseDesign(3, "different");
      const pid = await mpc.upload(join(jobDir, "images", "a.png"));
      await mpc.placeImage(0, pid);
      await mpc.saveProject("mtg-edh-print-abcd1234");
      expect(state.projects.get(ssid)).toMatchObject({ name: "mtg-edh-print-abcd1234", saves: 1 });

      expect(await mpc.findSavedProject("mtg-edh-print-abcd1234")).toBe(ssid);
      expect(await mpc.stage()).toBe("saved_projects");
      expect(await mpc.findSavedProject("mtg-edh-print-other")).toBeNull();
      await mpc.openSavedProject(ssid);
      expect(await mpc.stage()).toBe("front_designer");
      expect(await mpc.needsDesignChoice()).toBe(false);
      expect(await mpc.slotCount()).toBe(3);
      expect(await mpc.slotPid(0)).toBe(pid);
      expect(await mpc.uploadedPids()).toEqual([pid]);
    },
    30_000,
  );

  withBrowser(
    "steps through the text editors to the back designer and the preview, accepting the blank-design confirm, and never past it",
    async () => {
      const { site: mpc } = await site();
      await mpc.open();
      await mpc.defineProject({ stock: "(S30) Standard Smooth", bracket: 18, foil: false });
      await mpc.chooseDesign(2, "different");
      await mpc.nextStep();
      expect(await mpc.stage()).toBe("text_front");
      await mpc.nextStep();
      expect(await mpc.stage()).toBe("back_designer");
      expect(await mpc.needsDesignChoice()).toBe(true);
      await mpc.chooseDesign(2, "same");
      expect(await mpc.slotCount()).toBe(1);
      await mpc.nextStep();
      expect(await mpc.stage()).toBe("text_back");
      await mpc.nextStep();
      expect(await mpc.stage()).toBe("preview");
      await expect(mpc.nextStep()).rejects.toThrow(/preview/);
    },
    30_000,
  );

  withBrowser(
    "reports the signed-out account, opens the sign-in page and sees the account once the user signs in there",
    async () => {
      const { site: mpc, state } = await site({ signedIn: false });
      await mpc.open();
      expect(await mpc.isSignedIn()).toBe(false);
      await expect(mpc.findSavedProject("anything")).rejects.toThrow(/sign/i);
      await mpc.openSignIn();
      expect(await mpc.stage()).toBe("sign_in");
      // The user types their own credentials into the printer's page; the filler never does.
      await page.fill("#txt_email", "someone@example.com");
      await page.fill("#txt_password", "their-secret");
      await page.click("#btn_submit");
      await page.waitForURL(/custom-blank-card/);
      expect(state.signedIn).toBe(true);
      expect(await mpc.isSignedIn()).toBe(true);
      expect(state.requests.some((request) => request.includes("their-secret"))).toBe(false);
    },
    30_000,
  );

  withBrowser(
    "fails loudly on site drift, naming the missing selector, and takes a screenshot",
    async () => {
      const { site: mpc } = await site({ drift: { missingStockSelect: true } });
      await mpc.open();
      await expect(
        mpc.defineProject({ stock: "(S30) Standard Smooth", bracket: 18, foil: false }),
      ).rejects.toThrow(/dro_paper_type/);
      const shot = join(jobDir, "failure-define_project.png");
      await mpc.screenshot(shot);
      expect(readFileSync(shot).subarray(1, 4).toString()).toBe("PNG");
    },
    30_000,
  );

  withBrowser(
    "fills the golden project end to end: one printer project, every slot, both faces, saved, ending on the preview",
    async () => {
      const golden = PrintProjectSchema.parse(
        JSON.parse(readFileSync(join(FIXTURES, "printProject.golden.json"), "utf8")),
      );
      for (const image of [...golden.fronts, ...golden.backs])
        writeFileSync(join(jobDir, image.path), `image:${image.path}`);
      if (golden.card_back) writeFileSync(join(jobDir, golden.card_back), "image:card-back");
      writeFileSync(join(jobDir, PRINT_PROJECT_FILENAME), JSON.stringify(golden));
      writeFileSync(join(jobDir, PRINT_CARDS_XML_FILENAME), "<order/>");
      const { site: mpc, state } = await site();
      const outcome = await fillProject({
        site: mpc,
        project: golden,
        jobDir,
        signInTimeoutMs: 1_000,
        signInPollMs: 50,
      });
      expect(outcome).toMatchObject({ type: "filled" });
      expect(state.projects.size).toBe(1);
      const [project] = [...state.projects.values()];
      const pid = (path: string) => imagePid(readFileSync(join(jobDir, path)));
      expect(project).toMatchObject({
        name: golden.project_name,
        stock: "PA_059",
        size: "18",
        effect: "EF_055",
        quantity: 6,
      });
      expect(project?.slots.front).toEqual([
        pid("images/slot-001-front.png"),
        pid("images/slot-002-front.png"),
        pid("images/slot-002-front.png"),
        pid("images/slot-002-front.png"),
        pid("images/slot-002-front.png"),
        pid("images/slot-006-front.png"),
      ]);
      const back = pid("images/card-back.png");
      expect(project?.slots.back).toEqual([
        back,
        back,
        back,
        back,
        back,
        pid("images/slot-006-back.png"),
      ]);
      expect(project?.uploads.front).toHaveLength(3);
      expect(project?.uploads.back).toHaveLength(2);
      expect(await mpc.stage()).toBe("preview");
      expect(existsSync(join(jobDir, FILL_STATE_FILENAME))).toBe(true);
      expect(state.requests.some((request) => /cart|checkout|payment/i.test(request))).toBe(false);
    },
    60_000,
  );

  withBrowser(
    "fails a stalled upload as site drift with the step name and a screenshot in the job directory",
    async () => {
      const golden = PrintProjectSchema.parse(
        JSON.parse(readFileSync(join(FIXTURES, "printProject.golden.json"), "utf8")),
      );
      for (const image of [...golden.fronts, ...golden.backs])
        writeFileSync(join(jobDir, image.path), `image:${image.path}`);
      if (golden.card_back) writeFileSync(join(jobDir, golden.card_back), "image:card-back");
      const state = await installMpcFixture(page, { drift: { uploadNeverCompletes: true } });
      const mpc = new PlaywrightMpcSite(page, { timeoutMs: 5_000, uploadTimeoutMs: 1_000 });
      const outcome = await fillProject({
        site: mpc,
        project: golden,
        jobDir,
        signInTimeoutMs: 1_000,
        signInPollMs: 50,
      });
      expect(outcome).toMatchObject({ type: "failed", data: { step: "upload_front" } });
      if (outcome.type !== "failed") throw new Error("expected failure");
      expect(outcome.data.screenshot).toBe(join(jobDir, "failure-upload_front.png"));
      expect(
        readFileSync(outcome.data.screenshot ?? "")
          .subarray(1, 4)
          .toString(),
      ).toBe("PNG");
      expect(outcome.data.instructions).toContain(`${MPC_BASE_URL}${MPC_PATHS.savedProjects}`);
      expect(state.projects.size).toBe(1);
    },
    60_000,
  );

  withBrowser(
    "resumes a saved project found by name and fills only the empty slots",
    async () => {
      const golden = PrintProjectSchema.parse(
        JSON.parse(readFileSync(join(FIXTURES, "printProject.golden.json"), "utf8")),
      );
      for (const image of [...golden.fronts, ...golden.backs])
        writeFileSync(join(jobDir, image.path), `image:${image.path}`);
      if (golden.card_back) writeFileSync(join(jobDir, golden.card_back), "image:card-back");
      const pid = (path: string) => imagePid(readFileSync(join(jobDir, path)));
      const saved = newFixtureProject("FXSAVED", {
        name: golden.project_name,
        stock: "PA_059",
        size: "18",
        effect: "EF_055",
        quantity: 6,
        modes: { front: "different", back: null },
        slots: {
          front: [
            pid("images/slot-001-front.png"),
            pid("images/slot-002-front.png"),
            null,
            null,
            null,
            null,
          ],
          back: [],
        },
        uploads: {
          front: [pid("images/slot-001-front.png"), pid("images/slot-002-front.png")],
          back: [],
        },
        saves: 1,
      });
      const { site: mpc, state } = await site({ projects: [saved] });
      const outcome = await fillProject({
        site: mpc,
        project: golden,
        jobDir,
        signInTimeoutMs: 1_000,
        signInPollMs: 50,
      });
      expect(outcome).toMatchObject({ type: "filled", data: { ssid: "FXSAVED" } });
      expect(state.projects.size).toBe(1);
      expect(state.requests.filter((request) => request.includes("pro_item_process_flow"))).toEqual(
        [],
      );
      const placements = state.requests.filter(
        (request) => request.includes("/fixture/place") && request.includes("face=front"),
      );
      expect(placements).toHaveLength(4);
      expect(saved.slots.front.every((slot) => slot !== null)).toBe(true);
    },
    60_000,
  );
});
