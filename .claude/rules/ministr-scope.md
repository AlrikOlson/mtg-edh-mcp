# ministr MCP — Codebase Navigation

ministr is the **preferred** tool for all codebase *exploration*. The
PreToolUse hooks steer you there; they do **not** restrict normal shell
work (pipelines, git, build/test output filtering all run unrestricted).

## Tool Rules

| Tool                              | Status         | Usage                                                                         |
| --------------------------------- | -------------- | ----------------------------------------------------------------------------- |
| `ministr_survey(query: "...")`       | **PRIMARY**    | Semantic search across docs and code. Start here.                             |
| `ministr_symbols(query: "...")`      | **PRIMARY**    | Find structs, functions, traits, enums by name/kind/module.                   |
| `ministr_definition(id: "...")`      | **PRIMARY**    | Get full source of a symbol by ID.                                            |
| `ministr_references(id: "...")`      | **PRIMARY**    | Find callers, implementors, importers of a symbol.                            |
| `ministr_read(id: "...")`            | **PRIMARY**    | Full content of a section by ID.                                              |
| `ministr_extract(id: "...")`         | **PRIMARY**    | Get atomic claims from a section, optionally filtered by query.               |
| `ministr_toc`                        | **PRIMARY**    | Structural overview of the indexed corpus.                                    |
| `ministr_bridge(query/kind/...)`     | **PRIMARY**    | Cross-language bridge links (Tauri, PyO3, NAPI, etc.).                        |
| `Grep` / `Glob` tools             | **DENIED**     | Frictionless redirect (no prompt): use `ministr_survey` / `ministr_symbols`.  |
| `Bash(grep/find/...)` leading     | **ALLOWED**    | Auto-allowed with an advisory hint. Never prompts.                            |
| `cmd \| grep`, `cmd \| tail`, …   | **ALLOWED**    | Pipelines / compound commands are never intercepted.                          |
| `Read(file)`                      | **RESTRICTED** | Use `Read` only immediately before `Edit`. Never for exploration.             |

## What is steered (and what is not)

Steered toward ministr (advisory only — nothing ever prompts you):

- The `Grep` / `Glob` tools — **denied** (silent redirect); use
  `ministr_survey` / `ministr_symbols`.
- A *leading* `grep`/`rg`/`ag`/`ack`/`egrep`/`fgrep` — **allowed** with a
  hint to prefer `ministr_survey`.
- A *leading* `find`/`fd` — **allowed** with a hint to prefer
  `ministr_toc` / `ministr_survey`.

Explicitly **not** steered at all (run normally):

- Any pipeline / compound command: `cargo test | grep`, `… | tail`,
  `… | wc`, `git log | grep`, `git grep …`.
- `find` as a filesystem operation: `find . -name '*.tmp' -delete`.

## Workflow

1. **`ministr_survey` first** — semantic search across docs and code.
2. **`ministr_symbols`** — find symbols by name, kind, or module.
3. **`ministr_definition` / `ministr_read`** — get full source.
4. **`ministr_references` before modifying shared code** — find callers.
5. **`ministr_bridge` before modifying any cross-language boundary**.
6. **`ministr_toc`** — structural overview / project layout.

## Shell execution (`ministr_run`) — optional exec-only mode

ministr also ships a recorded shell: `ministr_run(command)` executes via
the ministr daemon and returns the exit code plus a token-lean digest
(every error line preserved); the full log stays retrievable with
`ministr_run_logs(run_id)` (delta paging — never re-sends what you have
seen) and `query:` substring search. Long commands: `background: true`,
then `ministr_run_status` / `ministr_run_kill`.

When **exec-only mode** is on (`ministr init --exec-only`, marker file
`.claude/hooks/ministr-exec-only`), the PreToolUse hook denies the raw
Bash tool and steers here. Honest limits: this is *steering, not a
security boundary* — compound-command matcher gaps and the Task-subagent
bypass (claude-code GH#26923) are documented; the enforced boundary is
the daemon policy (runs only execute with a cwd inside an indexed corpus
root, and every run is audited in `~/.ministr/exec_runs.db`). Delete the
marker file to turn the mode off.

See `ministr-playbook.md` for detailed decision trees and chaining patterns.
