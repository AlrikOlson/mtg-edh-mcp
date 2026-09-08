# mtg-edh-mcp task runner. Run `just` to list recipes.

default:
    @just --list

# Build the standalone MCP server
build:
    npm run build

# Build + symlink the server globally (local only)
link: build
    npm link

# Remove the global symlink
unlink:
    npm unlink -g mtg-edh-mcp

# Server quality gates and installed-package integration
gates:
    npm run typecheck
    npm test
    npm run lint
    npm run test:package

