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
        find: "@dealora/plan",
        replacement: new URL("./packages/plan/src/index.ts", import.meta.url).pathname,
      },
      {
        find: "@dealora/account",
        replacement: new URL("./packages/account/src/index.ts", import.meta.url).pathname,
      },
      {
        find: "@dealora/research",
        replacement: new URL("./packages/research/src/index.ts", import.meta.url).pathname,
      },
      {
        find: "@dealora/evidence",
        replacement: new URL("./packages/evidence/src/index.ts", import.meta.url).pathname,
      },
      {
        find: "@dealora/qualification",
        replacement: new URL("./packages/qualification/src/index.ts", import.meta.url).pathname,
      },
      {
        find: "@dealora/personalization",
        replacement: new URL("./packages/personalization/src/index.ts", import.meta.url).pathname,
      },
      {
        find: "@dealora/approval",
        replacement: new URL("./packages/approval/src/index.ts", import.meta.url).pathname,
      },
      {
        find: "@dealora/outbound",
        replacement: new URL("./packages/outbound/src/index.ts", import.meta.url).pathname,
      },
      {
        find: "@dealora/conversation",
        replacement: new URL("./packages/conversation/src/index.ts", import.meta.url).pathname,
      },
      {
        find: "@dealora/api",
        replacement: new URL("./packages/api/src/index.ts", import.meta.url).pathname,
      },
    ],
  },
});
