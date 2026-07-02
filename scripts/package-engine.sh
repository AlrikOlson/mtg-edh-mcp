#!/bin/bash
# Build the engine as a Node SEA single binary + its native sqlite addon.
# Output: build/mtg-edh-engine (+ build/better_sqlite3.node — ship BOTH,
# side by side). Requires: npm run build (dist/), node >= 20, macOS codesign.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p build
npx -y esbuild dist/main.js --bundle --platform=node --format=cjs \
  --alias:bindings="$PWD/scripts/sea-bindings-shim.cjs" \
  --outfile=build/engine.cjs
cat > build/sea-config.json <<JSON
{ "main": "build/engine.cjs", "output": "build/sea-prep.blob", "disableExperimentalSEAWarning": true }
JSON
node --experimental-sea-config build/sea-config.json
cp "$(command -v node)" build/mtg-edh-engine
codesign --remove-signature build/mtg-edh-engine
npx -y postject build/mtg-edh-engine NODE_SEA_BLOB build/sea-prep.blob \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 \
  --macho-segment-name NODE_SEA
codesign -s - build/mtg-edh-engine
cp node_modules/better-sqlite3/build/Release/better_sqlite3.node build/

# Minimal runtime dataset for the bundle: current.json + the CURRENT version's
# index + manifest only (the raw Scryfall ingest dumps stay out of the .app).
CUR=$(python3 -c "import json;print(json.load(open('data/cards/current.json'))['version'])")
rm -rf build/data gui/app/bundle-data
mkdir -p "build/data/cards/versions/$CUR"
cp data/cards/current.json build/data/cards/
cp "data/cards/versions/$CUR/index.sqlite" "data/cards/versions/$CUR/manifest.json" \
  "build/data/cards/versions/$CUR/"
# dx bundle resources cannot reference paths outside the crate dir — stage a
# copy inside gui/app (gitignored).
cp -R build/data gui/app/bundle-data
# tauri sidecar convention: external_bin files need the target-triple suffix.
TRIPLE=$(rustc -vV | grep host | cut -d" " -f2)
cp build/mtg-edh-engine "build/mtg-edh-engine-$TRIPLE"
cp build/better_sqlite3.node "build/better_sqlite3.node-$TRIPLE"
echo "engine binary: build/mtg-edh-engine ($(du -h build/mtg-edh-engine | cut -f1)); data: $(du -sh build/data | cut -f1)"
