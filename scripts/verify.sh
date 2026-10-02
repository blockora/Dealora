#!/bin/sh
# Run every repository quality gate in CI order.
# Usage: sh ./scripts/verify.sh
set -eu

bun run lint
bun run format:check
bun run typecheck
bun run test
bun run build
