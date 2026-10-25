/**
 * Fill orchestration (chunk print-mpc-filler): the order of steps that places
 * one frozen print project into a MakePlayingCards project, written over the
 * {@link MpcSite} vocabulary so it runs the same against the printer, the
 * recorded fixture pages and the in-memory fake.
 *
 * Steps, each named so a failure says where it happened: wait for the user to
 * sign in (never typing credentials), look the project up by the job's name in
 * the account and reopen it, or define a new one (stock, bracket, foil); set
 * the card count and the per-card mode for the fronts; upload every front
 * image once and place it on each of its slots, skipping slots that already
 * carry it; save; move to the backs; choose one shared back or per-card backs;
 * place the card back and the double-faced backs; save; step to the review
 * screen and stop. Payment is never touched: the site vocabulary has no such
 * call.
 *
 * `fill-state.json` in the job directory records the ssid, uploaded image ids
 * and placed slots after every placement, so the next run knows what the last
 * one did; the printer's own slot contents stay authoritative for what to
 * place. A failure takes a screenshot into the job directory and returns the
 * step, the message and instructions for finishing by hand with the retained
 * `project.json` and `cards.xml`.
 */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { writeFileAtomically } from "./atomicWrite.js";
import {
  FillStepSchema,
  type FillStep,
  type FillerEvent,
  type FillerOutcome,
} from "./fillerProtocol.js";
import { MPC_BASE_URL, MPC_PATHS, type MpcDesignMode, type MpcSite } from "./mpcSite.js";
import {
  PRINT_CARDS_XML_FILENAME,
  PRINT_PROJECT_FILENAME,
  type PrintProject,
  type PrintProjectImage,
} from "./projectFile.js";

export const FILL_STATE_FILENAME = "fill-state.json";

export const FillStateSchema = z.strictObject({
  version: z.literal(1),
  project_name: z.string(),
  /** The printer project the fill created or reopened; null before either. */
  ssid: z.string().nullable(),
  /** The printer's image id per job-relative image path. */
  uploaded: z.record(z.string(), z.string()),
  /** Zero-based slots confirmed to carry their image, per face. */
  placed: z.strictObject({
    fronts: z.array(z.number().int().nonnegative()),
    backs: z.array(z.number().int().nonnegative()),
  }),
  last_step: FillStepSchema.nullable(),
  updated_at: z.iso.datetime(),
});
export type FillState = z.infer<typeof FillStateSchema>;

export interface FillProjectOptions {
  site: MpcSite;
  project: PrintProject;
  /** Absolute job directory; image paths in the project are relative to it. */
  jobDir: string;
  /** Cancels at the next step boundary. */
  signal?: AbortSignal;
  onEvent?: (event: FillerEvent) => void;
  /** How long to wait for the user to sign in; default fifteen minutes. */
  signInTimeoutMs?: number;
  signInPollMs?: number;
  /** Save the project to the account after this many placements; default ten. */
  saveEvery?: number;
  now?: () => Date;
}

const DEFAULT_SIGN_IN_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_SIGN_IN_POLL_MS = 2_000;
const DEFAULT_SAVE_EVERY = 10;

/** Thrown between steps when the parent asked to stop. */
class FillCancelled extends Error {
  override readonly name = "FillCancelled";
}

type Face = "front" | "back";

/** Read the state file if present and valid; anything else starts fresh. */
export async function readFillState(jobDir: string): Promise<FillState | null> {
  try {
    const text = await readFile(join(jobDir, FILL_STATE_FILENAME), "utf8");
    const parsed = FillStateSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

class Fill {
  private readonly site: MpcSite;
  private readonly project: PrintProject;
  private readonly jobDir: string;
  private readonly signal: AbortSignal | undefined;
  private readonly onEvent: (event: FillerEvent) => void;
  private readonly signInTimeoutMs: number;
  private readonly signInPollMs: number;
  private readonly saveEvery: number;
  private readonly now: () => Date;
  private state: FillState;
  private step: FillStep | null = null;
  private frontsDone = new Set<number>();
  private placements = 0;

  constructor(options: FillProjectOptions, state: FillState | null) {
    this.site = options.site;
    this.project = options.project;
    this.jobDir = options.jobDir;
    this.signal = options.signal;
    this.onEvent = options.onEvent ?? (() => undefined);
    this.signInTimeoutMs = options.signInTimeoutMs ?? DEFAULT_SIGN_IN_TIMEOUT_MS;
    this.signInPollMs = options.signInPollMs ?? DEFAULT_SIGN_IN_POLL_MS;
    this.saveEvery = Math.max(1, options.saveEvery ?? DEFAULT_SAVE_EVERY);
    this.now = options.now ?? (() => new Date());
    this.state =
      state && state.project_name === options.project.project_name
        ? state
        : {
            version: 1,
            project_name: options.project.project_name,
            ssid: null,
            uploaded: {},
            placed: { fronts: [], backs: [] },
            last_step: null,
            updated_at: this.now().toISOString(),
          };
  }

  async run(): Promise<FillerOutcome> {
    const { project, site } = this;
    try {
      await this.at("sign_in", () => this.waitForSignIn());
      const existing = await this.at("find_saved_project", () =>
        site.findSavedProject(project.project_name),
      );
      if (existing !== null) {
        await this.at("reopen_project", async () => {
          await site.openSavedProject(existing);
          this.state.ssid = existing;
          if (await site.needsDesignChoice())
            await site.chooseDesign(project.quantity, "different");
          await this.requireSlots(project.quantity, "front");
        });
      } else {
        await this.at("define_project", async () => {
          this.state.ssid = await site.defineProject({
            stock: project.stock,
            bracket: project.bracket,
            foil: project.foil,
          });
        });
        await this.at("fronts_mode", async () => {
          await site.chooseDesign(project.quantity, "different");
          await this.requireSlots(project.quantity, "front");
        });
      }
      await this.persist();

      await this.fillFace("front", project.fronts);
      await this.at("save_project", () => site.saveProject(project.project_name));

      await this.at("to_backs", async () => {
        await site.nextStep();
        await site.nextStep();
        await this.requireStage("back_designer");
      });
      const backs = this.backImages();
      const mode: MpcDesignMode = project.backs.length > 0 ? "different" : "same";
      await this.at("backs_mode", async () => {
        if (await site.needsDesignChoice()) await site.chooseDesign(project.quantity, mode);
        await this.requireSlots(mode === "same" ? 1 : project.quantity, "back");
      });
      if (backs.length > 0) {
        await this.fillFace("back", backs);
        await this.at("save_project", () => site.saveProject(project.project_name));
      }

      await this.at("to_review", async () => {
        await site.nextStep();
        await site.nextStep();
        await this.requireStage("preview");
      });
      this.emit(
        "to_review",
        "The project is on the printer's review screen; finish the order in the browser.",
      );
      await this.persist();
      return {
        type: "filled",
        data: {
          ssid: this.state.ssid,
          project_name: project.project_name,
          slots_total: project.quantity,
          review_url: this.state.ssid
            ? `${MPC_BASE_URL}${MPC_PATHS.preview}?ssid=${this.state.ssid}`
            : null,
        },
      };
    } catch (error) {
      await this.persist().catch(() => undefined);
      if (error instanceof FillCancelled || this.signal?.aborted) {
        return { type: "cancelled", data: { step: this.step } };
      }
      const message = error instanceof Error ? error.message : String(error);
      const screenshot = await this.captureFailure();
      await this.saveAfterFailure();
      return {
        type: "failed",
        data: { step: this.step, message, screenshot, instructions: this.instructions() },
      };
    }
  }

  /** Run one named step, honouring a cancel before it starts. */
  private async at<T>(step: FillStep, body: () => Promise<T>): Promise<T> {
    if (this.signal?.aborted) throw new FillCancelled(`cancelled before ${step}`);
    this.step = step;
    this.state.last_step = step;
    return body();
  }

  private emit(step: FillStep, message: string): void {
    this.onEvent({
      step,
      slots_filled: this.frontsDone.size,
      slots_total: this.project.quantity,
      message,
    });
  }

  private async waitForSignIn(): Promise<void> {
    await this.site.open();
    if (await this.site.isSignedIn()) return;
    await this.site.openSignIn();
    this.emit(
      "sign_in",
      "Waiting for you to sign in to MakePlayingCards in the browser window (the filler never enters your password).",
    );
    const deadline = Date.now() + this.signInTimeoutMs;
    while (Date.now() < deadline) {
      if (this.signal?.aborted) throw new FillCancelled("cancelled while waiting for sign-in");
      await new Promise((resolve) => setTimeout(resolve, this.signInPollMs));
      if (await this.site.isSignedIn()) return;
    }
    throw new Error(
      `nobody signed in to MakePlayingCards within ${Math.round(this.signInTimeoutMs / 1000)} s; run print_start again once you are signed in`,
    );
  }

  private async requireSlots(expected: number, face: Face): Promise<void> {
    const count = await this.site.slotCount();
    if (count !== expected)
      throw new Error(
        `the ${face} designer shows ${count} slots but the order needs ${expected}; the printer project does not match project.json`,
      );
  }

  private async requireStage(expected: "back_designer" | "preview"): Promise<void> {
    const stage = await this.site.stage();
    if (stage !== expected)
      throw new Error(
        `expected the ${expected} page after stepping on, but the browser is on ${stage}`,
      );
  }

  /** The back images in placement order: the card back on every slot without its own back, then the per-card backs. */
  private backImages(): PrintProjectImage[] {
    const { project } = this;
    if (project.backs.length === 0) {
      return project.card_back === null
        ? []
        : [{ path: project.card_back, name: project.card_back, slots: [0] }];
    }
    const own = new Set(project.backs.flatMap((image) => image.slots));
    const shared: PrintProjectImage[] = [];
    if (project.card_back !== null) {
      const slots = project.slots.map((entry) => entry.slot).filter((slot) => !own.has(slot));
      if (slots.length > 0)
        shared.push({ path: project.card_back, name: project.card_back, slots });
    }
    return [...shared, ...project.backs];
  }

  private async fillFace(face: Face, images: readonly PrintProjectImage[]): Promise<void> {
    const uploadStep: FillStep = face === "front" ? "upload_front" : "upload_back";
    const placeStep: FillStep = face === "front" ? "place_front" : "place_back";
    const placedList = face === "front" ? this.state.placed.fronts : this.state.placed.backs;
    for (const image of images) {
      const pid = await this.at(uploadStep, async () => {
        this.emit(uploadStep, `Uploading ${image.name} for ${image.slots.length} ${face} slot(s)`);
        return this.site.upload(resolve(this.jobDir, image.path));
      });
      this.state.uploaded[image.path] = pid;
      for (const slot of image.slots) {
        const placed = await this.at(placeStep, async () => {
          if ((await this.site.slotPid(slot)) === pid) return false;
          await this.site.placeImage(slot, pid);
          return true;
        });
        if (!placedList.includes(slot)) placedList.push(slot);
        if (face === "front") this.frontsDone.add(slot);
        this.emit(
          placeStep,
          placed
            ? `Placed ${image.name} on ${face} slot ${slot}`
            : `${face} slot ${slot} already carries ${image.name}`,
        );
        await this.persist();
        if (placed) {
          this.placements += 1;
          if (this.placements % this.saveEvery === 0)
            await this.at("save_project", () => this.site.saveProject(this.project.project_name));
          this.step = placeStep;
        }
      }
    }
  }

  private async persist(): Promise<void> {
    this.state.updated_at = this.now().toISOString();
    this.state.placed.fronts.sort((a, b) => a - b);
    this.state.placed.backs.sort((a, b) => a - b);
    await writeFileAtomically(
      join(this.jobDir, FILL_STATE_FILENAME),
      new TextEncoder().encode(`${JSON.stringify(this.state, null, 2)}\n`),
    );
  }

  /** Keep what was placed: save the project when the failure left the browser on a designer page. */
  private async saveAfterFailure(): Promise<void> {
    if (this.state.ssid === null) return;
    try {
      const stage = await this.site.stage();
      if (stage !== "front_designer" && stage !== "back_designer") return;
      await this.site.saveProject(this.project.project_name);
    } catch {
      // The failure already has its evidence; the account keeps the last successful save.
    }
  }

  private async captureFailure(): Promise<string | null> {
    const path = join(this.jobDir, `failure-${this.step ?? "unknown"}.png`);
    try {
      await this.site.screenshot(path);
      return path;
    } catch {
      return null;
    }
  }

  private instructions(): string {
    const { project, jobDir, state } = this;
    const projectPath = join(jobDir, PRINT_PROJECT_FILENAME);
    const cardsXmlPath = join(jobDir, PRINT_CARDS_XML_FILENAME);
    const where = state.ssid
      ? `The printer project "${project.project_name}" (ssid ${state.ssid}) is saved in your MakePlayingCards account.`
      : `No printer project named "${project.project_name}" was created yet.`;
    return (
      `${where} Open ${MPC_BASE_URL}${MPC_PATHS.savedProjects} in the filler's browser window to continue by hand, ` +
      `or run print_start again to resume: slots already filled are kept. ` +
      `The order is retained at ${projectPath} and ${cardsXmlPath}; cards.xml can also be filled with the MPC Autofill desktop tool.`
    );
  }
}

/**
 * Place `project` into the printer's account through `site`, resuming the
 * saved project of the same name when there is one. Never throws: every
 * failure is an outcome with the step it happened in.
 */
export async function fillProject(options: FillProjectOptions): Promise<FillerOutcome> {
  const state = await readFillState(options.jobDir);
  return new Fill(options, state).run();
}
