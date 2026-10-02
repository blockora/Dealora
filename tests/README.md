# tests/

Cross-package and integration tests for DEALORA.

- Unit tests live next to the code they cover, inside `packages/<pkg>/src/**\/*.test.ts`.
- Tests in this directory cover behavior that spans packages or exercises the
  repository end to end (Phase 1+).
- All tests run through the shared Vitest runner: `bun run test`.
