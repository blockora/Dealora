/**
 * @dealora/integration — CRM Integrations (ROADMAP.md §30,
 * DEALORA_BLUEPRINT.md §23/§42/§44): a standardized adapter interface with
 * explicit permission scopes, a registry that never hard-codes a vendor, and
 * a Level 2 sync boundary that derives a change-set from stored rows, binds
 * a human decision to its digest, and executes only through an adapter
 * confirmation.
 *
 * The package is split along the declared/derived line the earlier phases
 * established:
 * - `types.ts` declares the adapter contract and the structural lookup,
 * - `rules.ts` is the published policy — systems, scopes, required scopes,
 *   limits and refusals — declared once as data,
 * - `engine.ts` derives the change-set purely and deterministically,
 * - `adapters.ts` ships the sandbox CRM adapter and the registry,
 * - `service.ts` validates, authorizes and answers,
 * - `factory.ts` wires the service to storage.
 *
 * The critical rule — *no Level 2 external action without an explicit human
 * approval* — is structural: `executed` exists only on the branch where a
 * stored decision's digest still matches, the connection is active, the
 * scopes are granted, and the adapter itself confirmed. No credential is
 * stored anywhere in this package, and no adapter shipped here performs
 * network I/O.
 */

export * from "./types.js";
export * from "./rules.js";
export * from "./engine.js";
export * from "./adapters.js";
export * from "./service.js";
export * from "./factory.js";
