import eslintConfigPrettier from "eslint-config-prettier";

export default [
  {
    ignores: ["coverage/**", "dist/**", "node_modules/**"],
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        Buffer: "readonly",
        console: "readonly",
        fetch: "readonly",
        process: "readonly",
        URL: "readonly",
      },
    },
    rules: {
      "max-lines": ["error", { max: 700 }],
      "max-lines-per-function": ["error", { max: 100 }],
      "no-console": "off",
      "no-undef": "error",
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  eslintConfigPrettier,
];
