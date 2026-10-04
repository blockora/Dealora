import type { EntityId, Offer } from "@dealora/db";

import { PersonalizationService } from "./service.js";
import type {
  PersonalizationOfferReader,
  PersonalizationOfferSnapshot,
  PersonalizationQualificationReader,
  PersonalizationQualificationSnapshot,
  PersonalizationRepository,
} from "./types.js";

/**
 * Convenience factory wiring the Personalization service to the concrete store.
 *
 * Application code may construct the service with any
 * {@link PersonalizationRepository} plus readers for qualifications and offers,
 * which keeps the domain decoupled from storage: the domain never learns that
 * any of them is a JSON document.
 *
 * The readers are deliberately narrow. Personalization reads whether an account
 * was qualified and by which evaluation, and which active offer's own words it
 * may quote. It never sees a whole qualification, a whole plan, or a whole
 * Business Brain.
 */
export function createPersonalizationService(
  repo: PersonalizationRepository,
  qualifications: PersonalizationQualificationReader,
  offers: PersonalizationOfferReader,
  clock?: () => Date,
): PersonalizationService {
  return new PersonalizationService(repo, qualifications, offers, clock);
}

/**
 * Narrow a stored qualification to what the renderer is allowed to know.
 *
 * Only the id, the tenant boundary, the account and the state are carried: a
 * draft never restates a score, a reason or a dimension breakdown, because
 * those live on the qualification record and belong to the reviewer, not to the
 * message.
 */
export function toQualificationSnapshot(input: {
  id: EntityId;
  workspaceId: EntityId;
  accountId: EntityId;
  state: PersonalizationQualificationSnapshot["state"];
}): PersonalizationQualificationSnapshot {
  return {
    id: input.id,
    workspaceId: input.workspaceId,
    accountId: input.accountId,
    state: input.state,
  };
}

/** Narrow a stored offer to the fields the renderer may quote. */
export function toOfferSnapshot(offer: Offer): PersonalizationOfferSnapshot {
  return {
    id: offer.id,
    name: offer.name,
    description: offer.description,
    outcome: offer.outcome,
    status: offer.status,
    // An offer with no pricing object has no approved pricing, so the renderer
    // records the warning rather than assuming pricing is cleared.
    pricingApproved: offer.pricing?.approved ?? false,
  };
}
