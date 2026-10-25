#!/usr/bin/env node
/**
 * The print helper's browser filler worker (chunk print-mpc-filler): the one
 * process that loads Playwright. The MCP server spawns it as `node
 * print-filler.js` through the shared supervisor and talks to it in the
 * frames of `fillerProtocol.ts` over stdio.
 *
 * `probe` reports which browsers can be launched: Playwright's bundled
 * Chromium at its expected path, or a system Google Chrome at a well-known
 * location. `fill` reads `project.json` from the job directory, opens a headed
 * browser on the persistent profile directory (so the printer login survives
 * runs; the worker never sees or types a password), runs the fill
 * orchestration and reports the outcome. The browser then stays open for the
 * user to review and pay; the worker exits when the user closes it, when the
 * parent cancels, or when the parent ends the input.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { chromium, type BrowserContext } from "playwright";
import {
  BROWSER_INSTALL_COMMAND,
  FILLER_PROTOCOL_VERSION,
  serveFillerFrames,
  type FillerFillRequest,
  type FillerHold,
  type FillerProbe,
} from "./fillerProtocol.js";
import { fillProject } from "./fillProject.js";
import { PlaywrightMpcSite } from "./mpcSite.js";
import { PRINT_PROJECT_FILENAME, PrintProjectSchema } from "./projectFile.js";

/** Where a system Google Chrome usually lives, per platform. */
export function chromeExecutableCandidates(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string[] {
  switch (platform) {
    case "darwin":
      return ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
    case "win32": {
      const roots = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter(
        (root): root is string => typeof root === "string" && root.length > 0,
      );
      return roots.map((root) => join(root, "Google", "Chrome", "Application", "chrome.exe"));
    }
    default:
      return [
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/opt/google/chrome/chrome",
        "/snap/bin/chromium",
      ];
  }
}

function playwrightVersion(): string {
  try {
    const manifest = createRequire(import.meta.url)("playwright/package.json") as {
      version?: unknown;
    };
    return typeof manifest.version === "string" ? manifest.version : "unknown";
  } catch {
    return "unknown";
  }
}

/** Which browsers this machine can launch, without launching any. */
export async function probeBrowsers(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Promise<FillerProbe> {
  const bundled = chromium.executablePath();
  const chrome =
    chromeExecutableCandidates(platform, env).find((candidate) => existsSync(candidate)) ?? null;
  return {
    protocol_version: FILLER_PROTOCOL_VERSION,
    platform,
    playwright_version: playwrightVersion(),
    chromium: { available: existsSync(bundled), executable: bundled },
    chrome: { available: chrome !== null, executable: chrome },
    install_command: BROWSER_INSTALL_COMMAND,
  };
}

class BrowserSession {
  private context: BrowserContext | null = null;
  private closed: Promise<void> = Promise.resolve();

  async fill(
    request: FillerFillRequest,
    emit: Parameters<typeof fillProject>[0]["onEvent"] & ((event: never) => void),
    hold: FillerHold,
  ) {
    const project = PrintProjectSchema.parse(
      JSON.parse(await readFile(join(request.job_dir, PRINT_PROJECT_FILENAME), "utf8")),
    );
    await mkdir(request.profile_dir, { recursive: true, mode: 0o700 });
    const context = await chromium.launchPersistentContext(request.profile_dir, {
      headless: request.headless,
      ...(request.browser === "chrome" ? { channel: "chrome" } : {}),
      // The window's own size rules a headed session; tests run headless.
      viewport: request.headless ? { width: 1280, height: 900 } : null,
      acceptDownloads: false,
    });
    this.context = context;
    this.closed = new Promise<void>((resolve) => context.once("close", () => resolve()));
    // A cancel closes the browser, which also interrupts any waiting page call.
    hold.signal.addEventListener("abort", () => void this.close(), { once: true });
    const page = context.pages()[0] ?? (await context.newPage());
    const site = new PlaywrightMpcSite(page, request.site_url ? { baseUrl: request.site_url } : {});
    return fillProject({
      site,
      project,
      jobDir: request.job_dir,
      signal: hold.signal,
      onEvent: emit,
    });
  }

  /** Resolves when the user closes the browser or the parent lets go; closes it either way. */
  async hold(hold: FillerHold): Promise<void> {
    await Promise.race([this.closed, hold.whenRequested]);
    await this.close();
  }

  private async close(): Promise<void> {
    const context = this.context;
    this.context = null;
    if (!context) return;
    try {
      await context.close();
    } catch {
      // Already gone: the user closed the window, or the browser crashed.
    }
  }
}

async function main(): Promise<void> {
  const session = new BrowserSession();
  await serveFillerFrames(process.stdin, process.stdout, {
    probe: () => probeBrowsers(),
    fill: (request, emit, hold) => session.fill(request, emit, hold),
    hold: (hold) => session.hold(hold),
  });
  // Let the last frame drain before the process ends.
  await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
  process.exit(0);
}

const invokedDirectly =
  typeof process.argv[1] === "string" &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly || process.argv[1]?.endsWith("print-filler.js")) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exit(1);
  });
}
