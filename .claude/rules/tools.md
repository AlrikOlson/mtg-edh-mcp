# Tool Guide

## Codebase Navigation (ministr)

| Tool | Purpose |
|------|---------|
| `ministr_survey` | Semantic search across docs and code. Start here. |
| `ministr_symbols` | Find structs, functions, traits, enums by name/kind/module. |
| `ministr_definition` | Get full source of a symbol by ID. |
| `ministr_references` | Find callers, implementors, importers of a symbol. |
| `ministr_read` | Full content of a section by ID. |
| `ministr_extract` | Get atomic claims from a section, optionally filtered by query. |
| `ministr_toc` | Structural overview of the indexed corpus. |
| `ministr_bridge` | Cross-language bridge links. **Use before changing any IPC/FFI boundary.** |

Recommended workflow: `ministr_survey` → `ministr_symbols` → `ministr_definition` / `ministr_read` → dig deeper with `ministr_references` / `ministr_bridge`.

See `ministr-playbook.md` for decision trees and chaining patterns.

## Tool Preferences

- Use `ministr_survey` for file/concept discovery (the `Glob` tool is denied).
- Use `ministr_symbols` for finding code symbols (the `Grep` tool is denied).
- Use ministr tools for *code exploration*; `Read` only immediately before `Edit`.
- The shell is unrestricted — pipelines, `git`, and build/test output
  filtering (`cargo test | grep`, `… | tail`) run normally. A *leading*
  `grep`/`find` is auto-allowed with a one-line hint to prefer ministr;
  nothing ever prompts you. See `ministr-scope.md`.
