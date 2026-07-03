# mtg-edh-mcp task runner. Run `just` to list recipes.

app_name := "MtgEdhGui"
dmg := "gui/target/dx/mtg-edh-gui/bundle/macos/macos/MtgEdhGui.dmg"
mount := "/tmp/mtg-edh-dmg-mount"

default:
    @just --list

# Build the release artifacts (.app + .dmg) exactly as a release would
package:
    ./scripts/package-app.sh

# Build + install to /Applications from the dmg, like a downloaded release
install: package
    #!/usr/bin/env bash
    set -euo pipefail
    hdiutil detach "{{mount}}" -quiet 2>/dev/null || true
    hdiutil attach "{{dmg}}" -nobrowse -mountpoint "{{mount}}" -quiet
    trap 'hdiutil detach "{{mount}}" -quiet' EXIT
    rm -rf "/Applications/{{app_name}}.app"
    cp -R "{{mount}}/{{app_name}}.app" /Applications/
    echo "installed /Applications/{{app_name}}.app ($(du -sh "/Applications/{{app_name}}.app" | cut -f1))"

# Launch the installed app
open:
    open "/Applications/{{app_name}}.app"

# Remove the installed app (your decks/session data live outside the bundle)
uninstall:
    rm -rf "/Applications/{{app_name}}.app"
    @echo "removed /Applications/{{app_name}}.app"

# Full verification gates (engine + gui + wire round-trips + web build)
gates:
    npm test && npm run typecheck && npm run lint
    cd gui && cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings
    cd gui && cargo test -p mtg-edh-mcp-client --test round_trip -- --ignored
    cd gui/app && dx build --platform web
