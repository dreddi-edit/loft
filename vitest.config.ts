import path from "node:path";
import { defineConfig } from "vitest/config";

const rootDir = __dirname;

const workspaceAlias = {
  "@hair-simo/ui": path.resolve(rootDir, "packages/ui/src/index.tsx"),
  "@hair-simo/core": path.resolve(rootDir, "packages/core/src/index.ts"),
  "@hair-simo/db": path.resolve(rootDir, "packages/db/src/index.ts"),
  "@hair-simo/ai": path.resolve(rootDir, "packages/ai/src/index.ts"),
  "@hair-simo/gcp": path.resolve(rootDir, "packages/gcp/src/index.ts"),
  "@hair-simo/i18n": path.resolve(rootDir, "packages/i18n/src/index.ts"),
};

const sharedExclude = [
  "**/node_modules/**",
  "**/dist/**",
  "**/.next/**",
  "**/.turbo/**",
  "**/coverage/**",
];

// jsdom is not installed anywhere in the workspace, so every project runs on the
// node environment. Component tests that need a DOM must add jsdom first.
function project(workspaceDir: string, name: string) {
  return {
    resolve: { alias: workspaceAlias },
    test: {
      name,
      root: rootDir,
      environment: "node",
      include: [`${workspaceDir}/${name}/**/*.test.ts`, `${workspaceDir}/${name}/**/*.test.tsx`],
      exclude: sharedExclude,
    },
  };
}

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      project("packages", "core"),
      project("packages", "gcp"),
      project("packages", "ai"),
      project("packages", "db"),
      project("packages", "i18n"),
      project("packages", "ui"),
      project("apps", "web"),
      project("apps", "admin"),
    ],
  },
});
