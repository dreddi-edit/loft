import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  {
    test: {
      name: "core",
      include: ["packages/core/**/*.test.ts"],
    },
  },
  {
    test: {
      name: "gcp",
      include: ["packages/gcp/**/*.test.ts"],
    },
  },
  {
    test: {
      name: "ai",
      include: ["packages/ai/**/*.test.ts"],
    },
  },
]);
