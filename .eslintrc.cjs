module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
    ecmaFeatures: { jsx: true },
  },
  env: {
    es2022: true,
    node: true,
    browser: true,
  },
  plugins: ["@typescript-eslint"],
  extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
  ignorePatterns: [
    "node_modules",
    ".next",
    ".turbo",
    "dist",
    "build",
    "coverage",
    "next-env.d.ts",
    "infra/terraform",
    "**/.terraform",
  ],
  overrides: [
    {
      // ESLint 8 only walks `.js` by default. These patterns are what make a bare
      // `eslint .` from the repo root descend into the TypeScript in apps/ and packages/.
      files: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"],
      parserOptions: { sourceType: "module" },
    },
    {
      files: ["**/*.cjs", "**/*.js"],
      parserOptions: { sourceType: "script" },
    },
  ],
};
