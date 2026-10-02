/**
 * Structured result type.
 *
 * DEALORA's failure-handling rules (ROADMAP.md §45, "Agent Execution Rules",
 * Rule 14) require workflows to expose explicit failure paths instead of
 * throwing opaque errors or silently swallowing failures. Operations that can
 * fail in a controlled way return a `Result` so callers are forced to handle
 * both the success and the failure branch.
 *
 * Unexpected programmer errors still throw; `Result` is for expected,
 * domain-level failure outcomes.
 */

/** Successful branch of a {@link Result}. */
export interface Ok<out T> {
  readonly ok: true;
  readonly value: T;
}

/** Failed branch of a {@link Result}. */
export interface Err<out E> {
  readonly ok: false;
  readonly error: E;
}

/** The outcome of an operation that can succeed with `T` or fail with `E`. */
export type Result<T, E> = Ok<T> | Err<E>;

/** Creates a successful {@link Result} wrapping `value`. */
export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

/** Creates a failed {@link Result} wrapping a structured `error`. */
export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

/** Type guard: narrows a {@link Result} to its successful branch. */
export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok;
}

/** Type guard: narrows a {@link Result} to its failed branch. */
export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok;
}
