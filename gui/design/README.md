# Design import dropzone

This is a **dropzone** for whatever Claude Design (or any design tool) exports.
The export format is unknown ahead of time, so just drop the raw artifact here and
I'll extract from it into the real GUI token/component locations during the
`gui-design-tokens` roadmap chunk.

## How to use

1. Drop the export — **as-is, any format** — into [`inbox/`](./inbox/).
   - A single `.zip` / `.tar.gz` is fine; leave it compressed, I'll unpack it.
   - A folder is fine.
   - Loose files are fine (`.css`, `.rsx`, `.rs`, `.json`, `.svg`, `.png`, `.fig`, `.html`, `.md`, fonts…).
   - Multiple exports? Drop each in its own subfolder under `inbox/` (e.g. `inbox/2026-06-30-attempt-1/`).
2. Tell me it's there. I'll inspect, report what I found, and propose how to map it in.

You don't need to rename, unzip, or organize anything. Raw is best — I'd rather see
the untouched export than a pre-digested version.

## What I'll do with common formats

| If the export contains…                                  | I extract into…                                                        |
| -------------------------------------------------------- | --------------------------------------------------------------------- |
| Design tokens (CSS vars, JSON, `tokens.*`, style dicts)  | a tokens module the Dioxus app consumes (light + dark)                 |
| Component code (Dioxus RSX / Rust)                        | `gui/` crates, wired to the tokens                                     |
| Component code in HTML/React/other web                   | translated to **Dioxus 0.7 RSX** (the app is Rust/Dioxus, not web JS)  |
| Raw CSS / a stylesheet                                    | normalized into token vars + component styles                         |
| Figma (`.fig`) or Figma JSON                             | read for tokens/layout intent; rebuilt as Dioxus components            |
| Fonts / logos / SVG / images                             | `gui/app/assets/` (or wherever the app loads assets)                   |
| Screenshots / mockups (PNG/JPG)                          | reference only — I'll match them in code, not import them              |
| A written spec / notes (`.md`, `.txt`)                   | folded into the token/component design decisions                       |

> **Target reminder:** the GUI is a **Dioxus 0.7 desktop app in Rust** (RSX, not
> React/HTML/Tailwind). Whatever comes in, the output is Rust/Dioxus + a tokens form
> the app can read, with a light and a dark theme. See `../../docs/adr/0001-gui-architecture.md`.

## Note on git

`inbox/` is intended for **raw, possibly large/binary** exports. Nothing here is
load-bearing once I've extracted it — treat it as scratch input. If an export is huge
or binary-heavy and you don't want it in git history, say so and I'll keep it out
(extract, then drop the raw); otherwise I'll commit what's reasonable for provenance.
