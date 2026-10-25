/**
 * An in-memory MakePlayingCards for the fill orchestration tests: it keeps the
 * same project state the real site keeps (saved projects by name, uploaded
 * image ids, the image on each slot per face, the current page) and records
 * every call, so a test can assert what the filler did without a browser.
 * Faults are injected per method to stand in for site drift.
 */
import { readFile } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { imagePid, type MpcDesignMode, type MpcSite, type MpcStage } from "./mpcSite.js";

type Face = "front" | "back";

export interface FakeProject {
  ssid: string;
  name: string | null;
  stock: string;
  bracket: number;
  foil: boolean;
  quantity: number | null;
  /** The chosen mode per face; null until the mode frame is answered. */
  modes: Record<Face, MpcDesignMode | null>;
  slots: Record<Face, Array<string | null>>;
  uploads: Record<Face, string[]>;
  saves: number;
}

export interface FakeMpcSiteOptions {
  signedIn?: boolean;
  /** A method name whose next call throws this message (site drift). */
  faults?: Partial<Record<keyof MpcSite, string>>;
  /** Existing saved projects, keyed by ssid. */
  projects?: FakeProject[];
}

export class FakeMpcSite implements MpcSite {
  readonly calls: string[] = [];
  readonly projects = new Map<string, FakeProject>();
  readonly screenshots: string[] = [];
  signedIn: boolean;
  private readonly faults: Partial<Record<keyof MpcSite, string>>;
  private currentStage: MpcStage = "other";
  private current: FakeProject | null = null;
  private nextSsid = 1;

  constructor(options: FakeMpcSiteOptions = {}) {
    this.signedIn = options.signedIn ?? true;
    this.faults = { ...(options.faults ?? {}) };
    for (const project of options.projects ?? []) this.projects.set(project.ssid, project);
  }

  /** The project the site is currently showing. */
  get project(): FakeProject | null {
    return this.current;
  }

  private face(): Face {
    if (this.currentStage === "front_designer") return "front";
    if (this.currentStage === "back_designer") return "back";
    throw new Error(`not on a designer page (on ${this.currentStage})`);
  }

  private record(name: keyof MpcSite, detail = ""): void {
    this.calls.push(detail ? `${name}:${detail}` : name);
    const fault = this.faults[name];
    if (fault) {
      delete this.faults[name];
      throw new Error(fault);
    }
  }

  async open(): Promise<void> {
    this.record("open");
    this.currentStage = "product";
  }

  async isSignedIn(): Promise<boolean> {
    this.record("isSignedIn");
    return this.signedIn;
  }

  async openSignIn(): Promise<void> {
    this.record("openSignIn");
    this.currentStage = "sign_in";
  }

  async findSavedProject(name: string): Promise<string | null> {
    this.record("findSavedProject", name);
    if (!this.signedIn) throw new Error("the saved projects page redirected to sign-in");
    this.currentStage = "saved_projects";
    for (const project of this.projects.values()) if (project.name === name) return project.ssid;
    return null;
  }

  async openSavedProject(ssid: string): Promise<void> {
    this.record("openSavedProject", ssid);
    const project = this.projects.get(ssid);
    if (!project) throw new Error(`no saved project ${ssid}`);
    this.current = project;
    this.currentStage = "front_designer";
  }

  async defineProject(order: { stock: string; bracket: number; foil: boolean }): Promise<string> {
    this.record("defineProject", `${order.stock}|${order.bracket}|${order.foil}`);
    const ssid = `SSID${this.nextSsid++}`;
    const project: FakeProject = {
      ssid,
      name: null,
      stock: order.stock,
      bracket: order.bracket,
      foil: order.foil,
      quantity: null,
      modes: { front: null, back: null },
      slots: { front: [], back: [] },
      uploads: { front: [], back: [] },
      saves: 0,
    };
    this.projects.set(ssid, project);
    this.current = project;
    this.currentStage = "front_designer";
    return ssid;
  }

  async needsDesignChoice(): Promise<boolean> {
    this.record("needsDesignChoice");
    return this.current !== null && this.current.modes[this.face()] === null;
  }

  async chooseDesign(quantity: number, mode: MpcDesignMode): Promise<void> {
    this.record("chooseDesign", `${quantity}|${mode}`);
    const project = this.current;
    if (!project) throw new Error("no project");
    const face = this.face();
    if (project.quantity !== null && project.quantity !== quantity)
      throw new Error("the quantity cannot change after the fronts");
    project.quantity = quantity;
    project.modes[face] = mode;
    project.slots[face] = new Array<string | null>(mode === "same" ? 1 : quantity).fill(null);
  }

  async uploadedPids(): Promise<string[]> {
    this.record("uploadedPids");
    const project = this.current;
    if (!project) throw new Error("no project");
    return [...project.uploads[this.face()]];
  }

  async upload(path: string): Promise<string> {
    this.record("upload", path);
    const project = this.current;
    if (!project) throw new Error("no project");
    const pid = imagePid(await readFile(path));
    const uploads = project.uploads[this.face()];
    if (!uploads.includes(pid)) uploads.push(pid);
    return pid;
  }

  async slotCount(): Promise<number> {
    this.record("slotCount");
    const project = this.current;
    if (!project) throw new Error("no project");
    return project.slots[this.face()].length;
  }

  async slotPid(slot: number): Promise<string | null> {
    this.record("slotPid", String(slot));
    const project = this.current;
    if (!project) throw new Error("no project");
    const slots = project.slots[this.face()];
    if (slot < 0 || slot >= slots.length) throw new Error(`no slot ${slot}`);
    return slots[slot] ?? null;
  }

  async placeImage(slot: number, pid: string): Promise<void> {
    this.record("placeImage", `${slot}|${pid}`);
    const project = this.current;
    if (!project) throw new Error("no project");
    const face = this.face();
    if (!project.uploads[face].includes(pid)) throw new Error(`image ${pid} is not uploaded`);
    const slots = project.slots[face];
    if (slot < 0 || slot >= slots.length) throw new Error(`no slot ${slot}`);
    slots[slot] = pid;
  }

  async saveProject(name: string): Promise<void> {
    this.record("saveProject", name);
    const project = this.current;
    if (!project) throw new Error("no project");
    if (!this.signedIn) throw new Error("saving needs a signed-in account");
    project.name = name;
    project.saves += 1;
  }

  async nextStep(): Promise<void> {
    this.record("nextStep");
    const order: MpcStage[] = [
      "front_designer",
      "text_front",
      "back_designer",
      "text_back",
      "preview",
    ];
    const index = order.indexOf(this.currentStage);
    if (index < 0 || index === order.length - 1)
      throw new Error(`no next step from ${this.currentStage}`);
    this.currentStage = order[index + 1] ?? this.currentStage;
  }

  async stage(): Promise<MpcStage> {
    this.record("stage");
    return this.currentStage;
  }

  async ssid(): Promise<string | null> {
    this.record("ssid");
    return this.current?.ssid ?? null;
  }

  async screenshot(path: string): Promise<void> {
    this.record("screenshot", path);
    this.screenshots.push(path);
    await writeFile(path, Buffer.from("PNG"));
  }
}
