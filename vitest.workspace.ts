import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    exclude: ["**/node_modules/**", "**/dist/**", "**/coverage/**", "**/.git/**"],
    alias: [
      {
        find: "@dealora/core",
        replacement: new URL("./packages/core/src/index.ts", import.meta.url).pathname,
      },
      {
        find: "@dealora/db",
        replacement: new URL("./packages/db/src/index.ts", import.meta.url).pathname,
      },
      {
        find: "@dealora/auth",
        replacement: new URL("./packages/auth/src/index.ts", import.meta.url).pathname,
      },
      {
        find: "@dealora/brain",
        replacement: new URL("./packages/brain/src/index.ts", import.meta.url).pathname,
      },
      {
        find: "@dealora/goal",
        replacement: new URL("./packages/goal/src/index.ts", import.meta.url).pathname,
      },
      {
        find: "@dealora/api",
        replacement: new URL("./packages/api/src/index.ts", import.meta.url).pathname,
      },
    ],
  },
});
