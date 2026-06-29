import { defineConfig } from "tsup";

export default defineConfig({
  // `index` is the library barrel; `main` is the executable bin.
  entry: { index: "src/server/index.ts", main: "src/server/main.ts" },
  format: ["esm"],
  target: "node18",
  platform: "node",
  // Emit declarations for the library surface only; the bin uses Node host
  // globals that tsup's per-entry dts program doesn't resolve (and needs none).
  dts: { entry: { index: "src/server/index.ts" } },
  clean: true,
  sourcemap: true,
  // better-sqlite3 is a native addon — never bundle it.
  external: ["better-sqlite3"],
});
