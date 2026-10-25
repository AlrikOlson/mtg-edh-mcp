import { defineConfig } from "tsup";

export default defineConfig({
  // `index` is the library barrel; `main` is the server bin; `ingest` is the
  // one-shot data-ingestion CLI; `print-filler` is the supervised browser
  // worker the print helper spawns (the only bundle that loads Playwright).
  entry: {
    index: "src/server/index.ts",
    main: "src/server/main.ts",
    ingest: "src/server/ingestMain.ts",
    skills: "src/skills/main.ts",
    "print-filler": "src/print/fillerWorker.ts",
  },
  format: ["esm"],
  target: "node22",
  platform: "node",
  // Emit declarations for the library surface only; the bin uses Node host
  // globals that tsup's per-entry dts program doesn't resolve (and needs none).
  dts: { entry: { index: "src/server/index.ts" } },
  clean: true,
  sourcemap: true,
  // better-sqlite3 and sharp are native addons and playwright carries its own
  // browser driver assets — never bundle them.
  external: ["better-sqlite3", "sharp", "playwright"],
});
