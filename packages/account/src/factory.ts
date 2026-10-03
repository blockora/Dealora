import { store } from "@dealora/db";

import { AccountService } from "./service.js";
import type { AccountRepository, PlanLinkReader } from "./service.js";

/**
 * Bind the Account service to the default store.
 *
 * The plan link reader is injected rather than imported so the account domain
 * stays independent of plan execution: it only ever learns which workspace a
 * plan belongs to.
 */
export function createAccountService(
  repository: AccountRepository = store as unknown as AccountRepository,
  plans: PlanLinkReader = (revenuePlanId, userId) =>
    store.getRevenuePlan(revenuePlanId, userId) as ReturnType<PlanLinkReader>,
): AccountService {
  return new AccountService(repository, plans);
}
