#!/usr/bin/env node
/**
 * Opt-in real MCP host evaluation, never run by npm test or CI.
 * Each invocation records one authenticated host/model against one source tree.
 * It never changes host settings, logs in, starts implementation, or overwrites evidence.
 */
import { build } from "esbuild";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, writeFile, access } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({
  options: {
    host: { type: "string" },
    model: { type: "string" },
    out: { type: "string" },
    "source-root": { type: "string", default: root },
    scenario: { type: "string", default: "all" },
    "timeout-seconds": { type: "string", default: "300" },
  },
});
if (!["claude", "codex"].includes(values.host) || !values.model || !values.out)
  throw new Error(
    "Required: --host claude|codex --model EXACT_MODEL --out NEW_DIRECTORY [--source-root CHECKOUT] [--scenario ID]",
  );
if (process.platform === "win32")
  throw new Error(
    "Real-host capture currently supports POSIX process-group cleanup only; Windows server acceptance runs separately in CI.",
  );
const sourceRoot = path.resolve(values["source-root"]);
const output = path.resolve(values.out);
const timeoutMs = Number(values["timeout-seconds"]) * 1000;
if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) throw new Error("Invalid timeout");
await mkdir(output); // Refuse to overwrite any prior run, including a failed run.
const workspace = await mkdtemp(path.join(tmpdir(), "mtg-host-eval-"));
const packageJson = JSON.parse(await readFile(path.join(sourceRoot, "package.json"), "utf8"));
const sdkPackage = packageJson.dependencies["@modelcontextprotocol/server"]
  ? "@modelcontextprotocol/server"
  : "@modelcontextprotocol/sdk";
const sourceRequire = createRequire(path.join(sourceRoot, "package.json"));
const currentRequire = createRequire(path.join(root, "package.json"));
// Fail before making any model request if this checkout's native addon was
// installed under a different Node ABI. Use the evaluator's exact executable.
execFileSync(
  process.execPath,
  [
    "-e",
    `const Database = require(${JSON.stringify(sourceRequire.resolve("better-sqlite3"))}); const db = new Database(":memory:"); db.close();`,
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);
const sdkVersion = JSON.parse(
  await readFile(path.join(sourceRoot, "node_modules", sdkPackage, "package.json"), "utf8"),
).version;
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const git = (args) => execFileSync("git", args, { cwd: sourceRoot, encoding: "utf8" }).trim();
const adapter = path.join(root, "src/server/hostEvaluation.fixture.ts");
const buildDir = path.join(workspace, "server");
await mkdir(buildDir);
await writeFile(
  path.join(buildDir, "package.json"),
  JSON.stringify({
    name: packageJson.name,
    version: packageJson.version,
    type: "module",
  }),
);
const bundled = await build({
  stdin: {
    contents: `import { startHostEvaluation } from ${JSON.stringify(adapter)};\nawait startHostEvaluation({ scenario: process.env.HOST_EVAL_SCENARIO, tracePath: process.env.HOST_EVAL_TRACE_PATH, statePath: process.env.HOST_EVAL_STATE_PATH });`,
    resolveDir: root,
    sourcefile: "host-evaluation-entry.ts",
  },
  outfile: path.join(buildDir, "server.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  metafile: true,
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
  plugins: [
    {
      name: "evaluated-source-tree",
      setup(builder) {
        builder.onResolve({ filter: /^better-sqlite3$/ }, () => ({
          path: pathToFileURL(sourceRequire.resolve("better-sqlite3")).href,
          external: true,
        }));
        builder.onResolve({ filter: /^@modelcontextprotocol\/server\/stdio$/ }, () => ({
          path: sourceRequire.resolve(
            sdkPackage === "@modelcontextprotocol/sdk"
              ? "@modelcontextprotocol/sdk/server/stdio.js"
              : "@modelcontextprotocol/server/stdio",
          ),
        }));
        builder.onResolve({ filter: /^\.\.?\// }, async (args) => {
          if (!args.importer.startsWith(path.join(root, "src")) || sourceRoot === root) return;
          const requested = path.resolve(path.dirname(args.importer), args.path);
          if (
            !requested.startsWith(path.join(root, "src")) ||
            path.basename(requested).startsWith("hostEvaluation")
          )
            return;
          const alternate = path
            .join(sourceRoot, path.relative(root, requested))
            .replace(/\.js$/, ".ts");
          await access(alternate);
          return { path: alternate };
        });
      },
    },
  ],
});
const inputDigests = [];
for (const file of Object.keys(bundled.metafile.inputs).sort()) {
  if (file.startsWith("<") || file === "host-evaluation-entry.ts") continue;
  const absolute = path.resolve(root, file);
  inputDigests.push({
    file: absolute.startsWith(sourceRoot + path.sep)
      ? path.relative(sourceRoot, absolute)
      : path.relative(root, absolute),
    sha256: sha256(await readFile(absolute)),
  });
}
await build({
  stdin: {
    contents: `export { gradeHostEvaluation } from ${JSON.stringify(adapter)}; export { summarizeCalls } from ${JSON.stringify(path.join(root, "src/server/workflowMetrics.ts"))};`,
    resolveDir: root,
    sourcefile: "host-evaluation-grade.ts",
  },
  outfile: path.join(buildDir, "grade.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
  plugins: [
    {
      name: "native",
      setup(builder) {
        builder.onResolve({ filter: /^better-sqlite3$/ }, () => ({
          path: pathToFileURL(currentRequire.resolve("better-sqlite3")).href,
          external: true,
        }));
      },
    },
  ],
});
const { gradeHostEvaluation, summarizeCalls } = await import(
  pathToFileURL(path.join(buildDir, "grade.mjs")).href
);
const originalPrompts = {
  "budget-build":
    "Build a legal 100-card Krenko deck for at most $100, using my owned Sol Ring and Goblin Matron.",
  "import-tune":
    "Import my Krenko list, replace the expensive mana rock, and show the exact change and export.",
  "acquisition-reduction":
    "Reduce the cost to acquire this Krenko deck while retaining my owned Goblin Matron and a legal 100 cards.",
  "error-recovery":
    "Use Krenko as commander; recover from an ambiguous name and unavailable EDHREC using local cards, then retry recommendations.",
};
const context = {
  "budget-build":
    "Choose Krenko, Mob Boss. Set the stated collection, use both owned cards in the deck, and include Skirk Prospector. Verify legality, the full 100-card price including commander, collection-aware acquisition cost, and export the library.",
  "import-tune":
    "Commander: Krenko, Mob Boss. The input library is:\n1 Sol Ring\n1 Goblin Matron\n97 Mountain\nImport it into a new deck, keep an original snapshot, replace Sol Ring with a cheaper mana-producing artifact, preserve all other cards, validate, show the snapshot diff and export.",
  "acquisition-reduction":
    "Commander: Krenko, Mob Boss. The input library is:\n1 Sol Ring\n1 Goblin Matron\n97 Mountain\nYour collection owns only Goblin Matron. Import the list, measure acquisition cost, replace Sol Ring with a cheaper mana-producing artifact while preserving every other card and collection membership, and verify the new acquisition cost is at most $20.",
  "error-recovery":
    "Start a deck with 98 Mountain. Attempt the supplied ambiguous commander name Krenko so we exercise recovery; choose Krenko, Mob Boss after ambiguity. The first EDHREC recommendation request is intentionally unavailable. After that failure, find and explicitly add Skirk Prospector from local cards, validate 100 cards, then retry recommendations successfully without changing the deck.",
};
const prefix =
  "This is an isolated Commander MCP evaluation, not a coding task. Use only the mtg MCP server. Do not read files, execute code/shell, browse, modify a repository, use skills, or delegate. All data and prices are synthetic pinned fixtures, not current market data. There are only seven fixture cards; padding with basic lands is intentional and authorized. Complete the requested deck task autonomously using the tools, then give the deck ID, evidence and any failures. Do not claim strategic deck quality.\n\n";
const scenarios = values.scenario === "all" ? Object.keys(originalPrompts) : [values.scenario];
if (scenarios.some((id) => !(id in originalPrompts))) throw new Error("Unknown scenario");
const provenance = {
  source_root_kind: sourceRoot === root ? "working_checkout" : "comparison_checkout",
  checkout_commit: git(["rev-parse", "HEAD"]),
  checkout_dirty: git(["status", "--porcelain"]).length > 0,
  package_version: packageJson.version,
  sdk_package: sdkPackage,
  sdk_version: sdkVersion,
  lockfile_sha256: sha256(await readFile(path.join(sourceRoot, "package-lock.json"))),
  bundled_input_sha256: sha256(JSON.stringify(inputDigests)),
  bundled_inputs: inputDigests,
  adapter_sha256: sha256(await readFile(adapter)),
  runner_sha256: sha256(await readFile(fileURLToPath(import.meta.url))),
  server_bundle_sha256: sha256(await readFile(path.join(buildDir, "server.mjs"))),
  grader_bundle_sha256: sha256(await readFile(path.join(buildDir, "grade.mjs"))),
  node: process.version,
  platform: process.platform,
  arch: process.arch,
};
const version = execFileSync(values.host, ["--version"], {
  encoding: "utf8",
}).trim();
const results = [];
for (const scenario of scenarios) {
  const runDir = path.join(output, scenario);
  await mkdir(runDir);
  const env = {
    HOST_EVAL_SCENARIO: scenario,
    HOST_EVAL_TRACE_PATH: path.join(runDir, "mcp.jsonl"),
    HOST_EVAL_STATE_PATH: path.join(runDir, "state.json"),
  };
  const prompt =
    prefix + originalPrompts[scenario] + "\n\nFixture task inputs: " + context[scenario];
  await writeFile(path.join(runDir, "prompt.txt"), prompt, { flag: "wx" });
  const config = {
    mcpServers: {
      mtg: {
        command: process.execPath,
        args: [path.join(buildDir, "server.mjs")],
        env,
      },
    },
  };
  const configPath = path.join(workspace, "mcp-" + scenario + ".json");
  await writeFile(configPath, JSON.stringify(config));
  const args =
    values.host === "claude"
      ? [
          "--print",
          "--model",
          values.model,
          "--output-format",
          "stream-json",
          "--verbose",
          "--no-session-persistence",
          "--restricted",
          "--disable-slash-commands",
          "--tools",
          "",
          "--setting-sources",
          "",
          "--strict-mcp-config",
          "--mcp-config",
          configPath,
          "--allowedTools",
          "mcp__mtg__*",
          "--permission-mode",
          "dontAsk",
          "--system-prompt",
          prefix,
          prompt,
        ]
      : [
          "exec",
          "--model",
          values.model,
          "--ignore-user-config",
          "--ephemeral",
          "--skip-git-repo-check",
          "--sandbox",
          "read-only",
          "--json",
          "-c",
          'approval_policy="never"',
          "-c",
          "project_doc_max_bytes=0",
          "-c",
          "features.shell_tool=false",
          "-c",
          "features.skip_host_skill_discovery=true",
          ...[
            "apps",
            "browser_use",
            "computer_use",
            "plugins",
            "hooks",
            "multi_agent",
            "skill_search",
            "image_generation",
          ].flatMap((feature) => ["-c", "features." + feature + "=false"]),
          "-c",
          'web_search="disabled"',
          "-c",
          "mcp_servers.mtg.command=" + JSON.stringify(process.execPath),
          "-c",
          "mcp_servers.mtg.args=" + JSON.stringify([path.join(buildDir, "server.mjs")]),
          "-c",
          "mcp_servers.mtg.required=true",
          "-c",
          'mcp_servers.mtg.default_tools_approval_mode="approve"',
          ...Object.entries(env).flatMap(([key, value]) => [
            "-c",
            "mcp_servers.mtg.env." + key + "=" + JSON.stringify(value),
          ]),
          prompt,
        ];
  const started = performance.now();
  let stdout = "",
    stderr = "",
    timedOut = false,
    spawnError = null;
  const stdoutPath = path.join(runDir, "host.jsonl");
  const stderrPath = path.join(runDir, "stderr.txt");
  await writeFile(stdoutPath, "", { flag: "wx" });
  await writeFile(stderrPath, "", { flag: "wx" });
  const child = spawn(values.host, args, {
    cwd: workspace,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  child.stdout.on("data", (data) => {
    stdout += data;
    appendFileSync(stdoutPath, data);
  });
  child.stderr.on("data", (data) => {
    stderr += data;
    appendFileSync(stderrPath, data);
  });
  const stop = () => {
    try {
      if (process.platform === "win32") child.kill("SIGKILL");
      else process.kill(-child.pid, "SIGKILL");
    } catch {}
  };
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, timeoutMs);
  const exit = await new Promise((resolve) => {
    child.on("error", (error) => {
      spawnError = error.message;
      resolve({ code: null, signal: null });
    });
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  stop(); // Clean up only this invocation's process group if the host left its fixture child alive.
  const elapsedMs = performance.now() - started;
  const jsonLines = (text) =>
    text
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  const hostEvents = jsonLines(stdout);
  let events = [],
    state = null;
  try {
    events = jsonLines(await readFile(env.HOST_EVAL_TRACE_PATH, "utf8"));
    state = JSON.parse(await readFile(env.HOST_EVAL_STATE_PATH, "utf8"));
  } catch {}
  const grade = state
    ? gradeHostEvaluation(scenario, state, events)
    : {
        passed: false,
        checks: [
          {
            id: "fixture_state_available",
            passed: false,
            detail: "No acknowledged fixture state was captured",
          },
        ],
      };
  const requests = new Map(
    events
      .filter(
        (event) => event.direction === "client_to_server" && event.message.method === "tools/call",
      )
      .map((event) => [event.message.id, event]),
  );
  const responses = new Map(
    events
      .filter((event) => event.direction === "server_to_client" && requests.has(event.message.id))
      .map((event) => [event.message.id, event]),
  );
  const calls = [...requests.values()].map((request) => {
    const event = responses.get(request.message.id);
    const body = event?.message.result?.structuredContent;
    return {
      name: request.message.params.name,
      arguments: request.message.params.arguments ?? {},
      result: event?.message.result ?? null,
      ...(event?.message.error
        ? {
            rpc_error: event.message.error.message,
            rpc_error_code: event.message.error.code,
          }
        : {}),
      elapsed_ms: event ? event.elapsed_ms - request.elapsed_ms : 0,
      expected_error:
        scenario === "error-recovery" &&
        ["AMBIGUOUS_NAME", "UPSTREAM_UNAVAILABLE"].includes(body?.code),
    };
  });
  const resultEvent = hostEvents.findLast((event) => event.type === "result");
  const usage =
    values.host === "claude"
      ? (resultEvent?.usage ?? null)
      : (hostEvents.findLast((event) => event.type === "turn.completed")?.usage ?? null);
  const observedModel =
    values.host === "claude"
      ? (hostEvents.find((event) => event.type === "system" && event.subtype === "init")?.model ??
        null)
      : null;
  const prohibited = hostEvents.filter((event) => {
    if (event.type === "item.completed") {
      const item = event.item;
      if (item?.type === "mcp_tool_call") return item.server !== "mtg";
      return !["agent_message", "reasoning", "plan", "todo_list", "error"].includes(item?.type);
    }
    return (
      event.type === "assistant" &&
      event.message?.content?.some(
        (item) => item.type === "tool_use" && !item.name.startsWith("mcp__mtg__"),
      )
    );
  });
  const complete =
    values.host === "claude"
      ? resultEvent?.is_error === false
      : hostEvents.some((event) => event.type === "turn.completed");
  const summary = summarizeCalls(calls);
  const metrics = {
    ...summary,
    tool_elapsed_ms: summary.elapsed_ms,
    unanswered_tool_calls: requests.size - responses.size,
    elapsed_ms: elapsedMs,
    token_counts: usage,
    token_source: usage ? "host_reported" : "unobserved",
  };
  const result = {
    scenario,
    original_prompt: originalPrompts[scenario],
    prompt_sha256: sha256(prompt),
    host: values.host,
    host_version: version,
    requested_model: values.model,
    observed_model: observedModel,
    model_identity_source:
      values.host === "claude"
        ? "host_init_event"
        : "explicit_CLI_selection_no_resolved_revision_event",
    exit,
    timed_out: timedOut,
    spawn_error: spawnError,
    host_completed: complete,
    protocol_version:
      events.find((event) => event.message?.result?.protocolVersion)?.message.result
        .protocolVersion ?? null,
    server_info:
      events.find((event) => event.message?.result?.serverInfo)?.message.result.serverInfo ?? null,
    workflow_version: state?.workflow_version ?? null,
    fixture_sha256: state?.fixture_sha256 ?? null,
    metrics,
    grade,
    prohibited_host_events: prohibited.length,
    agent_task_success:
      complete &&
      exit.code === 0 &&
      !timedOut &&
      prohibited.length === 0 &&
      requests.size === responses.size &&
      grade.passed,
  };
  await writeFile(path.join(runDir, "result.json"), JSON.stringify(result, null, 2) + "\n", {
    flag: "wx",
  });
  results.push(result);
  console.log(
    JSON.stringify({
      scenario,
      host: values.host,
      passed: result.agent_task_success,
      calls: calls.length,
      elapsed_ms: Math.round(elapsedMs),
      failures: grade.checks.filter((check) => !check.passed),
    }),
  );
}
const receipt = {
  format_version: 1,
  mode: "model_driven_host",
  captured_at: new Date().toISOString(),
  provenance,
  results,
  limitations: [
    "One observation per host/scenario/revision; no statistical performance or strategic quality claim.",
    "Same synthetic data and explicit fixture task context across revisions; no live upstream or real collection data.",
    "Model tokens are host-reported cumulative usage with host-specific cache semantics; bytes are not tokens.",
    "Temporary build and host working directory retained for diagnosis: " + workspace,
  ],
};
await writeFile(path.join(output, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n", {
  flag: "wx",
});
if (results.some((result) => !result.agent_task_success)) process.exitCode = 1;
