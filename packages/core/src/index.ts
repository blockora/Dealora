/**
 * `@dealora/core` — shared foundation for every DEALORA package.
 *
 * This package intentionally contains only cross-cutting building blocks.
 * Domain models (RevenueGoal, Evidence, Approval, …) belong to their own
 * packages as the roadmap phases introduce them.
 */

export { err, isErr, isOk, ok } from "./result.js";
export type { Err, Ok, Result } from "./result.js";
