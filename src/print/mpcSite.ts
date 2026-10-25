/**
 * MakePlayingCards site adapter (chunk print-mpc-filler).
 *
 * Everything the filler knows about the printer's web pages lives here and
 * nowhere else: URLs, element ids, the frame name, the page's own JavaScript
 * objects and how long each interaction may take. {@link MpcSite} is the
 * narrow vocabulary the fill orchestration ({@link fillProject}) speaks;
 * {@link PlaywrightMpcSite} implements it over one Playwright page. The
 * in-memory fake and the recorded fixture pages in the tests implement and
 * exercise the same interface, so site drift surfaces here, as a failing
 * selector with a name, and not as a wrong order.
 *
 * Page facts (observed on the live site on 2026-10-25, matching the MPC
 * Autofill desktop tool's behaviour):
 * - product page `design/custom-blank-card.html`: `select#dro_paper_type`
 *   (option text is the stock name, e.g. "(S30) Standard Smooth"),
 *   `select#dro_choosesize` (option value is the bracket, 18 ... 612),
 *   `select#dro_product_effect` ("" full colour, "EF_055" holographic front);
 *   `doPersonalize(url)` leaves for the designer with a fresh `ssid`;
 * - designer `products/playingcard/design/dn_playingcards_front_dynamic.aspx?ssid=`
 *   (and `_back_`): the mode frame `iframe[name=sysifm_loginFrame]` with
 *   `#txt_card_number` and `setMode('ImageText', 0 | 1)` (different | same);
 *   then `input#uploadId[type=file]`, `oDesignImage.UploadStatus`
 *   ("Uploading" -> "Complete"), `oDesignImage.dn_getImageList()` (";"-joined
 *   image ids, each the upper-case SHA-1 of the file bytes),
 *   `PageLayout.prototype.getElement3('dnImg', slot)` returning `img#dnImg<slot>_0_0`
 *   whose `pid` attribute names the placed image, and
 *   `PageLayout.prototype.applyDragPhoto(element, 0, pid)` to place one;
 *   `#txt_temporaryname` + `oDesign.setTemporarySave()` shows "Saved
 *   successfully" in `#div_temporarysavestatus`; `oDesign.setNextStep()` goes
 *   fronts -> `design/dn_texteditor_front.aspx` -> backs ->
 *   `design/dn_texteditor_back.aspx` -> `design/dn_preview_layout.aspx`;
 * - a `confirm()` about blank designs fires on next step and a `beforeunload`
 *   dialog on leaving the designer: both are accepted;
 * - signed in is `a[href*="logout.aspx"]`; saved projects are listed at
 *   `design/dn_temporary_designes.aspx` (redirects to `login.aspx` when
 *   signed out) and a project reopens at the designer URL with its `ssid`.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Frame, Page } from "playwright";
import type { PrintStock } from "./jobStore.js";

export const MPC_BASE_URL = "https://www.makeplayingcards.com";

export const MPC_PATHS = Object.freeze({
  product: "/design/custom-blank-card.html",
  personalize: "/products/pro_item_process_flow.aspx",
  frontDesigner: "/products/playingcard/design/dn_playingcards_front_dynamic.aspx",
  backDesigner: "/products/playingcard/design/dn_playingcards_back_dynamic.aspx",
  textFront: "/design/dn_texteditor_front.aspx",
  textBack: "/design/dn_texteditor_back.aspx",
  preview: "/design/dn_preview_layout.aspx",
  savedProjects: "/design/dn_temporary_designes.aspx",
  signIn: "/login.aspx",
  signOut: "/logout.aspx",
});

export const MPC_SELECTORS = Object.freeze({
  stock: "#dro_paper_type",
  bracket: "#dro_choosesize",
  effect: "#dro_product_effect",
  modeFrame: 'iframe[name="sysifm_loginFrame"]',
  cardNumber: "#txt_card_number",
  upload: "#uploadId",
  projectName: "#txt_temporaryname",
  saveStatus: "#div_temporarysavestatus",
  signedIn: 'a[href*="logout.aspx"]',
  savedProjectLink: 'a[href*="ssid="]',
});

/** The print effect the desktop tool selects for a foil order: holographic fronts. */
export const MPC_FOIL_EFFECT = "EF_055";
export const MPC_NO_EFFECT = "";
export const MPC_MODE_FRAME_NAME = "sysifm_loginFrame";
export const MPC_SAVED_TEXT = "Saved successfully";

export type MpcStage =
  | "product"
  | "front_designer"
  | "text_front"
  | "back_designer"
  | "text_back"
  | "preview"
  | "saved_projects"
  | "sign_in"
  | "other";

/** `same`: one design for every card of the face; `different`: one slot per card. */
export type MpcDesignMode = "same" | "different";

export interface MpcOrder {
  stock: PrintStock | string;
  bracket: number;
  foil: boolean;
}

/** What the fill orchestration asks of the printer's pages. Every method may throw on drift. */
export interface MpcSite {
  /** Load the site's start (the product page). */
  open(): Promise<void>;
  isSignedIn(): Promise<boolean>;
  openSignIn(): Promise<void>;
  /** The ssid of the saved project with exactly this name, or null. Throws when signed out. */
  findSavedProject(name: string): Promise<string | null>;
  /** Reopen a saved project in its front designer. */
  openSavedProject(ssid: string): Promise<void>;
  /** Start a new project with the order's stock, bracket and finish; resolves with its ssid on the front designer. */
  defineProject(order: MpcOrder): Promise<string>;
  /** True while the designer shows the mode frame (count and same/different not yet chosen). */
  needsDesignChoice(): Promise<boolean>;
  chooseDesign(quantity: number, mode: MpcDesignMode): Promise<void>;
  uploadedPids(): Promise<string[]>;
  /** Upload one file (skipped when its pid is already present) and resolve with its pid. */
  upload(path: string): Promise<string>;
  slotCount(): Promise<number>;
  /** The pid placed on a zero-based slot, or null when empty; throws for a slot the designer lacks. */
  slotPid(slot: number): Promise<string | null>;
  placeImage(slot: number, pid: string): Promise<void>;
  saveProject(name: string): Promise<void>;
  nextStep(): Promise<void>;
  stage(): Promise<MpcStage>;
  ssid(): Promise<string | null>;
  screenshot(path: string): Promise<void>;
}

/** The printer's image id for a file: the upper-case SHA-1 of its bytes. */
export function imagePid(bytes: Uint8Array): string {
  return createHash("sha1").update(bytes).digest("hex").toUpperCase();
}

/** The stage a site URL belongs to. */
export function stageOfUrl(url: string): MpcStage {
  let path: string;
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    return "other";
  }
  const is = (candidate: string) => path === candidate.toLowerCase();
  if (is(MPC_PATHS.product)) return "product";
  if (is(MPC_PATHS.frontDesigner)) return "front_designer";
  if (is(MPC_PATHS.backDesigner)) return "back_designer";
  if (is(MPC_PATHS.textFront)) return "text_front";
  if (is(MPC_PATHS.textBack)) return "text_back";
  if (is(MPC_PATHS.preview)) return "preview";
  if (is(MPC_PATHS.savedProjects)) return "saved_projects";
  if (is(MPC_PATHS.signIn) || path.endsWith("/login.aspx")) return "sign_in";
  return "other";
}

export function ssidOfUrl(url: string): string | null {
  try {
    return new URL(url).searchParams.get("ssid");
  } catch {
    return null;
  }
}

/**
 * The page's own objects as the adapter reads them from inside
 * `page.evaluate`. Declared here because the server is compiled without the
 * DOM library; the shapes are the ones observed on the live site.
 */
interface PageElement {
  getAttribute(name: string): string | null;
}
interface PageGlobals {
  doPersonalize?: (url: string) => void;
  setMode?: (mode: string, design: number) => void;
  oDesignImage?: { UploadStatus?: string; dn_getImageList?: () => string };
  oDesign?: { setTemporarySave?: () => void; setNextStep?: () => void };
  PageLayout?: {
    prototype?: {
      IndexObj?: Record<string, unknown> | null;
      getElement3?: (prefix: string, index: string) => PageElement | null;
      applyDragPhoto?: (element: PageElement, pid1: number, pid2: string) => void;
    };
  };
}

export interface PlaywrightMpcSiteOptions {
  /** The site's origin; a fixture site in tests. */
  baseUrl?: string;
  /** Default wait for a selector, a navigation or a page script. */
  timeoutMs?: number;
  /** Wait for one upload to finish; large scans take seconds each. */
  uploadTimeoutMs?: number;
  /** Wait for the "Saved successfully" confirmation. */
  saveTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_UPLOAD_TIMEOUT_MS = 120_000;
const DEFAULT_SAVE_TIMEOUT_MS = 60_000;

/** The printer's pages through one Playwright page. */
export class PlaywrightMpcSite implements MpcSite {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly uploadTimeoutMs: number;
  private readonly saveTimeoutMs: number;

  constructor(
    private readonly page: Page,
    options: PlaywrightMpcSiteOptions = {},
  ) {
    this.baseUrl = (options.baseUrl ?? MPC_BASE_URL).replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.uploadTimeoutMs = options.uploadTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS;
    this.saveTimeoutMs = options.saveTimeoutMs ?? DEFAULT_SAVE_TIMEOUT_MS;
    page.setDefaultTimeout(this.timeoutMs);
    // The site confirms leaving blanks behind and warns before unloading the
    // designer; both would otherwise block the automation for ever.
    page.on("dialog", (dialog) => {
      void dialog.accept().catch(() => undefined);
    });
  }

  private url(path: string, query: Record<string, string> = {}): string {
    const url = new URL(path, `${this.baseUrl}/`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return url.toString();
  }

  private async goto(path: string, query: Record<string, string> = {}): Promise<void> {
    await this.page.goto(this.url(path, query), { waitUntil: "domcontentloaded" });
    await this.settle();
  }

  /** Wait for the page's loading overlay, when it is showing, to go away. */
  private async settle(): Promise<void> {
    await this.page.waitForLoadState("domcontentloaded");
    const overlay = this.page.locator("#sysdiv_wait");
    if ((await overlay.count()) > 0) {
      await overlay
        .first()
        .waitFor({ state: "hidden", timeout: this.timeoutMs })
        .catch(() => undefined);
    }
  }

  private async requireStage(expected: MpcStage, doing: string): Promise<void> {
    const stage = await this.stage();
    if (stage !== expected)
      throw new Error(
        `${doing}: expected the ${expected} page but the browser is on ${stage} (${this.page.url()})`,
      );
  }

  private modeFrame(): Frame | null {
    return this.page.frame({ name: MPC_MODE_FRAME_NAME });
  }

  async open(): Promise<void> {
    await this.goto(MPC_PATHS.product);
  }

  async isSignedIn(): Promise<boolean> {
    if ((await this.stage()) === "other") await this.open();
    return (await this.page.locator(MPC_SELECTORS.signedIn).count()) > 0;
  }

  async openSignIn(): Promise<void> {
    await this.goto(MPC_PATHS.signIn);
  }

  async findSavedProject(name: string): Promise<string | null> {
    await this.goto(MPC_PATHS.savedProjects);
    const stage = await this.stage();
    if (stage === "sign_in")
      throw new Error("the saved projects page asked to sign in; the account is signed out");
    if (stage !== "saved_projects")
      throw new Error(`the saved projects page did not open (on ${stage})`);
    // The project's name as the exact text of one element; its row carries the edit link.
    const cell = this.page.getByText(name, { exact: true });
    if ((await cell.count()) === 0) return null;
    const row = cell
      .first()
      .locator("xpath=ancestor-or-self::*[.//a[contains(@href, 'ssid=')]][1]");
    const link = row.locator(MPC_SELECTORS.savedProjectLink).first();
    if ((await link.count()) === 0)
      throw new Error(
        `the saved project "${name}" is listed but its row has no link carrying an ssid`,
      );
    const href = await link.getAttribute("href");
    const ssid = href ? ssidOfUrl(new URL(href, this.baseUrl).toString()) : null;
    if (!ssid) throw new Error(`the saved project "${name}" has no ssid in its link ${href ?? ""}`);
    return ssid;
  }

  async openSavedProject(ssid: string): Promise<void> {
    await this.goto(MPC_PATHS.frontDesigner, { ssid });
    await this.requireStage("front_designer", "reopening the saved project");
    await this.waitForDesigner();
  }

  async defineProject(order: MpcOrder): Promise<string> {
    // A new project always starts from the product page, wherever the lookup left the browser.
    if ((await this.stage()) !== "product") await this.open();
    await this.requireStage("product", "defining the project");
    const stock = this.page.locator(MPC_SELECTORS.stock);
    if ((await stock.count()) === 0)
      throw new Error(`the product page has no stock select ${MPC_SELECTORS.stock}`);
    await stock.selectOption({ label: order.stock });
    await this.page.locator(MPC_SELECTORS.bracket).selectOption(String(order.bracket));
    await this.page
      .locator(MPC_SELECTORS.effect)
      .selectOption(order.foil ? MPC_FOIL_EFFECT : MPC_NO_EFFECT);
    const personalize = this.url(MPC_PATHS.personalize);
    await Promise.all([
      this.page.waitForURL((url) => stageOfUrl(url.toString()) === "front_designer", {
        timeout: this.timeoutMs,
      }),
      this.page.evaluate((url) => {
        const fn = (globalThis as unknown as PageGlobals).doPersonalize;
        if (typeof fn !== "function")
          throw new Error("doPersonalize is not defined on the product page");
        fn(url);
      }, personalize),
    ]);
    await this.settle();
    const ssid = await this.ssid();
    if (!ssid) throw new Error(`the designer opened without an ssid (${this.page.url()})`);
    return ssid;
  }

  async needsDesignChoice(): Promise<boolean> {
    const frame = this.page.locator(MPC_SELECTORS.modeFrame);
    return (await frame.count()) > 0 && (await frame.first().isVisible());
  }

  async chooseDesign(quantity: number, mode: MpcDesignMode): Promise<void> {
    const frameElement = this.page.locator(MPC_SELECTORS.modeFrame);
    await frameElement.waitFor({ state: "visible", timeout: this.timeoutMs });
    const frame = this.modeFrame();
    if (!frame) throw new Error(`the mode frame ${MPC_MODE_FRAME_NAME} is not attached`);
    const count = frame.locator(MPC_SELECTORS.cardNumber);
    await count.waitFor({ state: "attached", timeout: this.timeoutMs });
    await count.fill(String(quantity));
    await frame.waitForFunction(
      () => typeof (globalThis as unknown as PageGlobals).setMode === "function",
      null,
      { timeout: this.timeoutMs },
    );
    await Promise.all([
      this.page.waitForLoadState("domcontentloaded"),
      frame.evaluate(
        (design) => {
          const setMode = (globalThis as unknown as PageGlobals).setMode;
          if (typeof setMode !== "function")
            throw new Error("setMode is not defined in the mode frame");
          setMode("ImageText", design);
        },
        mode === "same" ? 1 : 0,
      ),
    ]);
    await this.waitForDesigner();
    const present = await this.needsDesignChoice();
    if (present) throw new Error("the mode frame is still showing after choosing the design count");
  }

  /** The designer is usable once its upload input and layout index are present. */
  private async waitForDesigner(): Promise<void> {
    await this.settle();
    if (await this.needsDesignChoice()) return;
    await this.page
      .locator(MPC_SELECTORS.upload)
      .waitFor({ state: "attached", timeout: this.timeoutMs });
    await this.page.waitForFunction(
      () => (globalThis as unknown as PageGlobals).PageLayout?.prototype?.IndexObj != null,
      null,
      { timeout: this.timeoutMs },
    );
  }

  async uploadedPids(): Promise<string[]> {
    const list = await this.page.evaluate(() => {
      const images = (globalThis as unknown as PageGlobals).oDesignImage;
      if (!images || typeof images.dn_getImageList !== "function")
        throw new Error("oDesignImage.dn_getImageList is not available on this page");
      return images.dn_getImageList() ?? "";
    });
    // Repeated uploads of one image are keyed `<pid>_<n>`; the pid is what matters.
    return list
      .split(";")
      .map((entry) => entry.trim().split("_")[0] ?? "")
      .filter((pid) => pid.length > 0);
  }

  async upload(path: string): Promise<string> {
    const pid = imagePid(await readFile(path));
    if ((await this.uploadedPids()).includes(pid)) return pid;
    const input = this.page.locator(MPC_SELECTORS.upload);
    if ((await input.count()) === 0)
      throw new Error(`the designer has no upload input ${MPC_SELECTORS.upload}`);
    await input.setInputFiles(path);
    const uploading = () =>
      this.page.evaluate(() => (globalThis as unknown as PageGlobals).oDesignImage?.UploadStatus);
    // The status flips to "Uploading" almost at once and back when the server has the file.
    const deadline = Date.now() + this.uploadTimeoutMs;
    while (Date.now() < deadline) {
      const status = await uploading();
      if (status !== "Uploading" && (await this.uploadedPids()).includes(pid)) return pid;
      await this.page.waitForTimeout(250);
    }
    throw new Error(
      `the upload of ${path} (${pid}) did not finish within ${this.uploadTimeoutMs} ms (UploadStatus ${String(await uploading())})`,
    );
  }

  async slotCount(): Promise<number> {
    return this.page.evaluate(() => {
      const index = (globalThis as unknown as PageGlobals).PageLayout?.prototype?.IndexObj;
      if (!index)
        throw new Error(
          "PageLayout.prototype.IndexObj is not available: the designer has not rendered its slots",
        );
      return Object.keys(index).length;
    });
  }

  async slotPid(slot: number): Promise<string | null> {
    return this.page.evaluate((index) => {
      const getElement3 = (globalThis as unknown as PageGlobals).PageLayout?.prototype?.getElement3;
      if (typeof getElement3 !== "function")
        throw new Error("PageLayout.prototype.getElement3 is not available");
      const element = getElement3("dnImg", String(index));
      if (!element) throw new Error(`the designer has no slot ${index}`);
      return element.getAttribute("pid");
    }, slot);
  }

  async placeImage(slot: number, pid: string): Promise<void> {
    await this.page.evaluate(
      ({ index, pid: imageId }) => {
        const proto = (globalThis as unknown as PageGlobals).PageLayout?.prototype;
        if (typeof proto?.getElement3 !== "function" || typeof proto.applyDragPhoto !== "function")
          throw new Error("PageLayout.prototype.applyDragPhoto is not available");
        const element = proto.getElement3("dnImg", String(index));
        if (!element) throw new Error(`the designer has no slot ${index}`);
        proto.applyDragPhoto(element, 0, imageId);
      },
      { index: slot, pid },
    );
    try {
      await this.page.waitForFunction(
        ({ index, pid: imageId }) => {
          const element = (
            globalThis as unknown as PageGlobals
          ).PageLayout?.prototype?.getElement3?.("dnImg", String(index));
          return element?.getAttribute("pid") === imageId;
        },
        { index: slot, pid },
        { timeout: this.timeoutMs },
      );
    } catch (error) {
      throw new Error(
        `slot ${slot} did not take image ${pid} within ${this.timeoutMs} ms: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  async saveProject(name: string): Promise<void> {
    const field = this.page.locator(MPC_SELECTORS.projectName);
    if ((await field.count()) === 0)
      throw new Error(`the designer has no project name field ${MPC_SELECTORS.projectName}`);
    await field.fill(name);
    await this.page.evaluate(() => {
      const design = (globalThis as unknown as PageGlobals).oDesign;
      if (!design || typeof design.setTemporarySave !== "function")
        throw new Error("oDesign.setTemporarySave is not available on this page");
      design.setTemporarySave();
    });
    try {
      await this.page
        .locator(MPC_SELECTORS.saveStatus)
        .filter({ hasText: MPC_SAVED_TEXT })
        .waitFor({ state: "visible", timeout: this.saveTimeoutMs });
    } catch (error) {
      throw new Error(
        `the project was not confirmed saved within ${this.saveTimeoutMs} ms (${MPC_SELECTORS.saveStatus} never read "${MPC_SAVED_TEXT}"): ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  async nextStep(): Promise<void> {
    const before = this.page.url();
    const stage = stageOfUrl(before);
    if (stage === "preview")
      throw new Error(
        "the preview is the last page the filler visits; it never proceeds to the cart",
      );
    await Promise.all([
      this.page.waitForURL((url) => url.toString() !== before, { timeout: this.timeoutMs }),
      this.page.evaluate(() => {
        const design = (globalThis as unknown as PageGlobals).oDesign;
        if (!design || typeof design.setNextStep !== "function")
          throw new Error("oDesign.setNextStep is not available on this page");
        design.setNextStep();
      }),
    ]);
    await this.settle();
    const after = await this.stage();
    if (after === "front_designer" || after === "back_designer") await this.waitForDesigner();
  }

  async stage(): Promise<MpcStage> {
    return stageOfUrl(this.page.url());
  }

  async ssid(): Promise<string | null> {
    return ssidOfUrl(this.page.url());
  }

  async screenshot(path: string): Promise<void> {
    await this.page.screenshot({ path, fullPage: false });
  }
}
