# Contributing

Thanks for helping improve the Commander deckbuilding engine. Useful
contributions include reproducible rule bugs, MCP interoperability fixes,
better card queries, clearer tool responses, and installation improvements.

## Get started

Use Node.js 24 and npm, then run:

```sh
npm ci
npm run build
npm run typecheck
npm test
npm run lint
npm run test:package
```

The test suite uses small card fixtures and controlled upstream responses. A
full Scryfall download is not needed for the standard server checks. The
package smoke test builds a local tarball, installs it outside the checkout,
and checks native SQLite loading, CLI behavior, a real MCP stdio connection,
and persistence across restarts. It does not publish to npm.

For a real client connection, follow [Installation](./docs/INSTALL.md).

## Make a focused change

1. Start from the current `main` branch and create a branch for your change.
2. Describe the user-visible problem and the intended behavior. For a larger
   feature, open an issue first so we can agree on scope.
3. Add or update tests when changing rules, persistence, transport behavior,
   query evaluation, or a tool contract. Prefer regression cases that show
   a concrete failure.
4. Run build, typecheck, test, lint, and the package smoke test before opening
   a pull request. Include the commands and actual results in the PR description.

Use strict TypeScript, ESM imports, runtime validation at input boundaries,
and structured errors for expected failures. Keep companion tests alongside
source files. Format changed files with Prettier; `npm run format` formats the
whole repository, so review its diff before committing unrelated changes.

Avoid live network calls in the standard tests. Use injectable clients and
fixtures for external service behavior. Keep real API keys, local decks, card
exports, build artifacts, and machine-specific paths out of contributions.

## Find the right module

| Path                          | Responsibility                                                              |
| ----------------------------- | --------------------------------------------------------------------------- |
| `src/server/`                 | MCP transports, tool registry, prompts, resources, startup, and scheduling. |
| `src/ingest/`                 | Scryfall downloads and versioned data storage.                              |
| `src/index/` and `src/query/` | SQLite card index, parsing, and query evaluation.                           |
| `src/deck/`                   | Deck state, history, import/export, and persistence.                        |
| `src/validate/`               | Commander, companion, singleton, banlist, and identity checks.              |
| `src/analyze/`                | Mana, curve, roles, simulations, and budget calculations.                   |
| `src/meta/`                   | Cached EDHREC, Commander Spellbook, and bracket enrichment.                 |
| `src/collection/`             | Session-scoped owned-card membership.                                       |
| `gui/`                        | Optional Rust / Dioxus desktop application.                                 |

Tool descriptions follow a USE / NOT / FLOW / ARGS / RETURNS structure.
Conformance tests verify their workflow references against the registered
tool catalog. Update descriptions, schemas, tests, and the cookbook together
when changing a tool contract.

The desktop app has its own Rust toolchain and checks; server-only
contributions do not require building the app. For GUI changes, also run the
relevant `gui/` workspace checks and verify the changed interface.

## Report a problem

Include your OS, Node version, revision, MCP client and transport, exact tool
input, expected behavior, and the actual result. For card-data issues, include
the card names and `data_snapshot`. Redact personal data from logs.

For security issues, follow [SECURITY.md](./SECURITY.md). For ordinary bugs
and feature requests, use the [issue templates](https://github.com/AlrikOlson/mtg-edh-mcp/issues/new/choose).
