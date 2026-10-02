import { defineConfig } from "vitest/config";

// Repository-wide test runner.
//
// Tests are colocated with their source under `packages/<pkg>/src`
// (file pattern: `src` + `/**/*.test.ts`). Compiled copies in `dist/` — the
// build emits them because the typecheck also covers test files — must never
// be picked up as a second test suite.
export default defineConfig({
  test: {
    environment: "node",
    exclude: ["**/node_modules/**", "**/dist/**", "**/coverage/**", "**/.git/**"],
  },
});
