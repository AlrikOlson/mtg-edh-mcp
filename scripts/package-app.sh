#!/bin/bash
# Full .app packaging: engine SEA binary → dx bundle → inject the card-data
# snapshot into Resources (dx 0.7.9's [bundle].resources silently copies
# nothing for this layout — post-processing is the deterministic path) →
# ad-hoc re-sign. Output: the .app path on stdout's last line.
set -euo pipefail
cd "$(dirname "$0")/.."
./scripts/package-engine.sh
(cd gui/app && "$HOME/.cargo/bin/dx" bundle --platform desktop --package-types macos > /dev/null)
APP=gui/target/dx/mtg-edh-gui/bundle/macos/macos/MtgEdhGui.app
rm -rf "$APP/Contents/Resources/data"
cp -R build/data "$APP/Contents/Resources/data"
codesign --force --deep -s - "$APP"
echo "app: $APP ($(du -sh "$APP" | cut -f1))"
