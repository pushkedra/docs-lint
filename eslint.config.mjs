import js from "@eslint/js";
import stylistic from "@stylistic/eslint-plugin";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig([
  globalIgnores(["dist"]),
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  stylistic.configs.customize({
    indent: 2,
    quotes: "double",
    semi: true,
    commaDangle: "always-multiline",
    braceStyle: "1tbs",
    arrowParens: true,
  }),
  {
    languageOptions: {
      parserOptions: { projectService: { allowDefaultProject: ["eslint.config.mjs", ".markdownlint-cli2.mjs"] } },
    },
    rules: {
      // Node's test functions return a promise the runner itself awaits.
      "@stylistic/max-len": ["error", {
        code: 120,
        ignoreRegExpLiterals: true,
        ignoreStrings: true,
        ignoreTemplateLiterals: true,
        ignoreUrls: true,
      }],
      // A number in a message reads as itself; anything else has to be turned into text on purpose.
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      "@typescript-eslint/no-floating-promises": ["error", {
        allowForKnownSafeCalls: [{ from: "package", name: ["test", "describe"], package: "node:test" }],
      }],
    },
  },
]);
