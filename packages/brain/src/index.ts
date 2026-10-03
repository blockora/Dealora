/** @dealora/brain — the canonical Business Brain context layer. */
export { BusinessBrainService } from "./service.js";
export type { BrainRepository, PricingInput } from "./service.js";
export { CLAIM_STATUSES, CLAIM_CATEGORIES, OFFER_STATUSES, PRICING_MODELS } from "./service.js";

export { brainError } from "./types.js";
export type { BrainError, BrainErrorCode, BusinessContext } from "./types.js";

export {
  Issues,
  LIMITS,
  optionalAmount,
  optionalCurrency,
  optionalString,
  optionalUrl,
  requireEnum,
  requireString,
  requireStringList,
} from "./validation.js";
export type { ValidationIssue } from "./types.js";

/**
 * Convenience factory wiring the Business Brain service to the concrete
 * repository. Application code may construct the service with any
 * {@link BrainRepository} implementation, which keeps the domain decoupled
 * from storage.
 */
export { createBusinessBrainService } from "./factory.js";
