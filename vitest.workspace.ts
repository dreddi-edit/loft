import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  {
    test: {
      name: "core",
      include: ["packages/core/**/*.test.ts"],
    },
  },
]);
