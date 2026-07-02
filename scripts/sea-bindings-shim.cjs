// Replaces the `bindings` package inside the SEA bundle (esbuild --alias).
// SEA blobs cannot dlopen native addons from the embedded code; the documented
// pattern is createRequire against a REAL filesystem path. The .node file ships
// next to the executable (Contents/MacOS in the .app bundle).
"use strict";
const path = require("node:path");
const { createRequire } = require("node:module");

module.exports = function bindings(opts) {
  const name = typeof opts === "string" ? opts : (opts && opts.bindings) || "bindings.node";
  const file = name.endsWith(".node") ? name : `${name}.node`;
  const dir = process.env.MTG_EDH_NATIVE_DIR || path.dirname(process.execPath);
  const realRequire = createRequire(path.join(dir, "sea-anchor.js"));
  return realRequire(path.join(dir, file));
};
