import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["src/__test__/smoke-*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 15_000,
    globals: false,
  },
});
