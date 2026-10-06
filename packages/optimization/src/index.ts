/** @dealora/optimization — Phase 21 Optimization Engine public surface.

 * `ROADMAP.md` §28 asks this phase to compare the eight roadmap dimensions
 * (audiences, messages, signals, channels, timing, qualification rules,
 * follow-up sequences, offers) and answer the five questions (what worked,
 * what failed, where conversion is dropping, what should be tested, what is
 * the likely impact), while being measurable, reversible and auditable.
 *
 * This package does **not** execute agents, send external actions, schedule
 * meetings, contact people, evaluate agents, or write cost rows. It reads the
 * workspace's existing rows and gives back defensible optimization observations.
 *
 * The eighteen facets are declared once in `rules.ts`. The derivation is
 * deterministic: given the same read surface, two calls produce byte-identical
 * results. No randomness, no clock inside the derivation, no external call, no
 * action surface of any kind.
 */

export { createOptimizationService } from "./factory.js";
export type { OptimizationRepository, OptimizationResult } from "./types.js";
export {
  OPTIMIZATION_FACETS,
  OPTIMIZATION_ANSWERS,
  OPTIMIZATION_DIMENSIONS,
  OPTIMIZATION_RULE_VERSION,
  OPTIMIZATION_ASPECTS,
} from "./rules.js";
export type { OptAnswer, OptFacetId, OptimizationDimension } from "./rules.js";
export type {
  OptSource,
  OptFacet,
  OptObservation,
  OptLearning,
  OptQuestion,
  OptHypothesis,
  OptHeadline,
} from "./types.js";
