# Agent Instructions

## Project prime directive

Read [docs/ENGINE-CHARTER.md](docs/ENGINE-CHARTER.md) before planning or changing this project. The prime directive is full-game simulation for any Commander-legal deck through MCP and the single canonical Rust engine. The fixture and Muldrotha milestones do not complete it. Maintain the native roadmap autonomously as evidence changes: add, split, merge, reorder and correct work within this directive; keep all planned unfinished work and discoveries pending, never in backlog. Before and after every substantial unit, record architecture, ownership, reuse, migration and independent acceptance evidence. Preserve native history, active work and user changes. This is project policy, not a `/goal` task; respect each invocation's implementation bounds.

## Project tools

Use **Magistr** for native roadmap, reasoning, execution records and quality gates. Use **workbench-mcp** for workspace exploration, search, navigation, reads and edits. Follow [Workbench routing](.agents/skills/workbench-routing/SKILL.md) for the exact APIs and error recovery.

Start with Workbench `map` for structure and `search` for concepts, symbols and references. Read the relevant definitions and both sides of shared interfaces before editing. Use verified edits with fresh content hashes, and review the resulting diff. Git remains a shell operation.

<!-- magistr:codex -->

## Magistr in Codex

Launch with `magistr codex-launch --project-root . --` or `./.codex/run`. The native launcher resolves dependencies and applies the documented Codex skill-discovery compatibility boundary. Use `magistr codex-launch --project-root . --diagnose` for read-only diagnostics.

Use the configured `magistr` MCP server for roadmap__, think__, ship__, signal__ and magistr_* tools. It embeds think-and-ship; do not start a standalone workflow server. Use Workbench map/search/read/edit/files/run/script/undo for workspace content; follow .agents/skills/workbench-routing/SKILL.md. A held Workbench lock belongs to its existing connection: do not kill the owner or launch a competing probe.

Use the nine project skills: $next, $next-loop, $validate, $roadmap, $roadmap-refresh, $signals, $craft, $init and $workbench-routing. They run in this Codex session. Read .magistr/project.json for commands and required custom gates and .claude/rules/conventions.md for shared project conventions. Claude hooks are additional enforcement only; Codex must explicitly run and record required gates.

The native roadmap is authoritative. Read .magistr/project.json before exporting a view: roadmap_exports=false forbids ROADMAP.md/ROADMAP.json and all file exports. Otherwise export only when the project requests a view.

Preserve existing objectives and worktree changes. Follow the requested scope; setup, review and planning do not authorize starting a roadmap chunk. $next implements one ready chunk; $next-loop is bounded. Recovery, acceptance, recorded checks and an atomic commit are required before completing work.
<!-- /magistr:codex -->
