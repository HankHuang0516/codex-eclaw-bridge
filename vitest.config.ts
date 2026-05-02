import { defineConfig } from "vitest/config";

export default defineConfig({
  cacheDir: ".vite-cache",
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
  },
});
