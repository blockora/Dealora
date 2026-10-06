/**
 * @dealora/experiment — the Experiment Engine (ROADMAP.md §29,
 * DEALORA_BLUEPRINT.md §27): declares controlled comparisons between
 * immutable drafts, attributes exposures and replies to the arm that sent
 * them, and derives sample size, conversion, confidence, cost and revenue
 * impact on read.
 *
 * The package is split along the declared/derived line:
 * - `types.ts` declares the views and the structural lookup,
 * - `rules.ts` is the published policy, declared once as data,
 * - `engine.ts` derives the comparison purely and deterministically,
 * - `service.ts` validates, authorizes and answers,
 * - `factory.ts` wires the service to storage.
 *
 * The critical rule — *do not claim a winning experiment when evidence is
 * insufficient* — is structural: a winner exists only inside a derived
 * decision, and only when the published evidence rule says so. No stored row
 * ever holds a verdict, and no request can supply one.
 */

export * from "./types.js";
export * from "./rules.js";
export * from "./engine.js";
export * from "./service.js";
export * from "./factory.js";
