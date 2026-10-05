/**
 * @dealora/cost — the Cost Engine (ROADMAP.md §23,
 * DEALORA_BLUEPRINT.md §33): records what each run cost as immutable facts,
 * and derives every total and per-outcome metric from those facts on read.
 *
 * The package is split along the recorded/derived line:
 * - `types.ts` and `rules.ts` declare the vocabulary and the refusals,
 * - `money.ts` is the only place arithmetic touches a monetary value,
 * - `engine.ts` derives breakdowns and metrics purely,
 * - `service.ts` validates, authorizes and answers,
 * - `factory.ts` wires the service to storage.
 */

export * from "./types.js";
export * from "./rules.js";
export * from "./money.js";
export * from "./engine.js";
export * from "./service.js";
export * from "./factory.js";
