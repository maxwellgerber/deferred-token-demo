import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules/**", ".wrangler/**"] },
  js.configs.recommended,
  {
    files: ["public/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: { ...globals.browser },
    },
  },
  {
    // Each scenario's app.js is loaded after shared.js in a plain <script> tag, sharing one
    // global scope — these are defined there, not locally.
    files: ["public/*/app.js"],
    languageOptions: {
      globals: {
        DTR: "readonly",
        appendLog: "readonly",
        escapeHtml: "readonly",
      },
    },
  },
];
