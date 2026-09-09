import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "coverage/**",
      "build/**",
      "scripts/**",
      ".workbench/**",
    ],
  },
  {
    files: ["engine/contract/*.mjs"],
    languageOptions: {
      globals: { URL: "readonly", structuredClone: "readonly" },
    },
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Keep formatting concerns to Prettier; disable conflicting stylistic rules.
  prettier,
);
