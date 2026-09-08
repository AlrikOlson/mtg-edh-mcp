import { defineConfig } from "tsup";

export default defineConfig({
  // `index` is the library barrel; `main` is the server bin; `ingest` is the
  // one-shot data-ingestion CLI.
  entry: {
    index: "src/server/index.ts",
    main: "src/server/main.ts",
    ingest: "src/server/ingestMain.ts",
  },
  format: ["esm"],
  target: "node22",
  platform: "node",
  // Emit declarations for the library surface only; the bin uses Node host
  // globals that tsup's per-entry dts program doesn't resolve (and needs none).
  dts: { entry: { index: "src/server/index.ts" } },
  clean: true,
  sourcemap: true,
  // better-sqlite3 is a native addon — never bundle it.
  external: ["better-sqlite3"],
});
