# ADR 0001 — GUI architecture: a Dioxus desktop client over the MCP engine

- Status: Accepted
- Date: 2026-06-30
- Context refs: think:113–116, roadmap chunk `gui-scaffold` (Phase G)

## Context

`mtg-edh-mcp` is a mature TypeScript/Node MCP server: the deep EDH engine
(`validate` / `analyze` / `meta`) plus deck + collection tools, exposed over two
transports from one core (`createServer`):

- **stdio** — for local MCP clients.
- **Streamable HTTP** — stateless (a fresh server per POST sharing one read-only
  card index + one deck store); the principal is read from the `x-mcp-principal`
  request header; `MCP_HTTP_PORT` defaults to `3000`.

The project is a **portfolio asset** (decided this session). The goal is now
craft: a AAA-quality **Rust + Dioxus** GUI that makes the engine shine. The
load-bearing question is how a Rust GUI integrates with a TypeScript backend.

## Decision

**The GUI is a Dioxus 0.7 desktop application acting as an MCP _client_ to the
existing TypeScript server over its Streamable HTTP transport.** The engine is
**not** rewritten or wrapped — the GUI consumes the exact tool/resource surface
the MCP server already ships, sending `x-mcp-principal` to scope its session.

The Rust MCP client uses **`rmcp`** (the official Rust MCP SDK; client +
streamable-HTTP transport). Wiring lands in `gui-mcp-client`.

### Two ship modes

1. **Dev** — run the node server (`mtg-edh-mcp`, HTTP on `:3000`); the GUI
   connects to it. Simplest; what the early GUI chunks target.
2. **Polished desktop** — the Dioxus app **spawns the node `bin` as a sidecar
   child process** and connects to it locally, yielding a single launchable app
   (Tauri-style). Bundling node into the `.app` is the riskiest unknown and is
   de-risked in `gui-app-shell`.

## Options considered

- **(A) Dioxus as an MCP client over HTTP — CHOSEN.** Zero backend change;
  reuses the deep engine as-is; official `rmcp` client exists.
- **(B) Sidecar / Tauri-style bundle.** Not a separate option so much as ship
  mode #2 of (A) — adopted for the polished build.
- **(C) A thin REST/JSON gateway over the engine — REJECTED.** Redundant: the
  MCP-over-HTTP surface already exists and `rmcp` consumes it directly. A gateway
  would add a second backend surface to build and keep in sync for no gain.

## Consequences

- **Honest cross-language cost.** This introduces a **second language + runtime**
  (Rust + Node) into one repo: two build systems (cargo + npm), two test stacks,
  and — for the polished build — bundling the node sidecar into the desktop app.
  This is a real, ongoing maintenance tax. The path _not_ taken (a TypeScript/web
  GUI reusing the engine in-process) would avoid it entirely; Rust + Dioxus was
  the explicit choice, accepted with eyes open.
- The TypeScript engine is **untouched**; its build/test/lint stay green
  independently of the GUI.

## Toolchain notes (a real gotcha)

- The compile gate for GUI chunks is **`cargo build`** (run inside `/gui`). A
  Dioxus desktop crate compiles and runs with plain cargo — `cargo run` launches
  the window.
- **`dx` (dioxus-cli)** is a dev convenience (`dx serve` hot-reload, `dx bundle`,
  and the **web target** used by `gui-scrutiny`'s Playwright pass). It is **not**
  required to compile. On this machine the `dx` on `PATH` is **Deno's `dx`**
  (`deno x`), a name collision — installing dioxus-cli (`cargo install
  dioxus-cli`) puts its `dx` in `~/.cargo/bin`; invoke it by full path or fix
  `PATH` order. Documented here so future chunks don't trip on it.

## Layout

- `/gui` — a self-contained cargo **workspace** (its own `Cargo.toml`) so cargo
  never scans the TS tree. Member crate `/gui/app` = the Dioxus desktop binary
  (`mtg-edh-gui`).
- `/gui/target` is gitignored.

## Repo: two toolchains

| Stack | Where | Build | Test | Lint |
|---|---|---|---|---|
| Engine (TS) | repo root | `npm run build` | `npm test` | `npm run lint` + `npm run typecheck` |
| GUI (Rust) | `/gui` | `cargo build` | `cargo test` | `cargo clippy` + `cargo fmt --check` |

CI should run both independently; neither gates the other.
