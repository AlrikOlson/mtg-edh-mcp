# Installing & running

Two ways to use this project: the **desktop app** (deckbuilding GUI with the
Oracle agent) or the **MCP server on its own** (plug the engine into Claude
Desktop or any MCP client).

> **Platform support: macOS only.** The app stores the Oracle API key in the
> macOS keychain (`security` CLI) and the packaged engine is a macOS Node SEA
> binary. The engine itself is portable Node ≥ 18, but only macOS is built,
> tested, and supported.

## Requirements

- macOS (Apple Silicon is what CI and development run on)
- Node.js ≥ 18 and npm
- For building the app from source: Rust (stable) and the Dioxus CLI
  (`cargo install dioxus-cli`)

## The desktop app

### From a release artifact

Download the `.dmg` from GitHub Releases, drag `MtgEdhGui.app` to
Applications, and launch it.

> Until 1.0 the app is not yet signed with a Developer ID, so Gatekeeper will
> refuse a double-click: right-click the app → Open → Open. 1.0 removes this
> step.

The app ships with a card-data snapshot from build time. On first launch you
land directly in a working Browse screen; if the app ever starts without card
data (or you want fresher data), it offers a one-time download of Scryfall's
bulk exports (~700 MB download, about 1 GB on disk) with progress shown
in-app. **Settings → Update card data** refreshes the snapshot any time; the
snapshot date is shown next to it.

### From source

```sh
git clone https://github.com/AlrikOlson/mtg-edh-mcp.git
cd mtg-edh-mcp
npm install
./scripts/package-app.sh   # builds engine + app; prints the .app and .dmg paths
```

For iterative development run the engine build once (`npm run build`), then:

```sh
cd gui/app
dx serve --platform desktop
```

The dev app spawns `dist/main.js` as its engine automatically (stdio).

## The MCP server on its own

The engine is a standard MCP server (stdio by default):

```sh
npm install && npm run build
npm run ingest        # one-time: download Scryfall bulk data + build the index
```

Claude Desktop config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "mtg-edh": {
      "command": "node",
      "args": ["/absolute/path/to/mtg-edh-mcp/dist/main.js"]
    }
  }
}
```

`MCP_DATA_DIR` overrides where card data and decks live (default
`data/cards` relative to the working directory — set it to an absolute path
when launching from an MCP client). `MCP_TRANSPORT=http` starts the
streamable-HTTP transport instead (see the security posture in the README
before exposing it anywhere).

## Where your data lives

- **Decks + snapshots** — `decks.json` under the data dir. Written through on
  every change; they survive app restarts and card-data updates.
- **Collection (owned cards)** — in-memory per app session by design; it
  resets on restart. Re-import it when you need it (cheap, membership-only).
- **Card database** — versioned snapshots under the data dir; updates are
  atomic (a failed download never corrupts the index you're using).
- **GUI session** (active deck pointer, snapshot list) — `~/.mtg-edh-gui.json`.
- **Oracle API key** (optional) — the macOS keychain, service
  `mtg-edh-oracle`. Never written to disk in plain text.

## First success checklist

1. Launch the app → Browse shows cards (bundled snapshot, or after onboarding).
2. Workbench → create a deck, set a commander, add cards — validation verdicts
   appear inline.
3. Quit and relaunch → the deck is still there.
