import type { Result } from "@dealora/core";
import type {
  Account,
  AccountClaim,
  EntityId,
  Evidence,
  EvidenceStatus,
  ResearchCategory,
  ResearchClaimKind,
  ResearchFinding,
} from "@dealora/db";

/**
 * @dealora/evidence — Evidence System (DEALORA_BLUEPRINT.md §10,
 * ROADMAP.md §14).
 *
 * Turns Phase 6 research observations into a formal, traceable
 * evidence/claim layer: **evidence** is a source-backed support for a claim,
 * and an **account claim** is a structured assertion about an external
 * account. Phase 7's job is to make that chain inspectable and auditable.
 *
 * What this package is not, stated once so every consumer inherits it:
 *
 *   - evidence is **not** qualification. Nothing here decides whether an
 *     account fits the ICP, whether a need is real, whether there is a buying
 *     signal, or how an account ranks. `ROADMAP.md` §15 (Phase 8) does that,
 *     and it needs a decision this phase deliberately refuses to make;
 *   - there is **no score** of any kind. `confidence` describes the strength of
 *     a source's support and `relevance` describes how directly a record
 *     relates to the claim — neither is an ICP, need-fit, buying-intent or
 *     opportunity score, and neither may be summed or ranked;
 *   - it **personalizes nothing** and contacts nobody: no message, no email,
 *     no CRM write, no outreach;
 *   - it **resolves no contradiction automatically**. When two sources say
 *     different things about the same field, both records are preserved and
 *     both are marked. A newer source does not win; a model is not asked to
 *     adjudicate.
 *
 * The provenance chain, when evidence came from research:
 *
 *   Evidence → AccountClaim → ResearchFinding → ResearchRequest → Account
 *
 * When the workspace supplied the source directly there is no research
 * request, and none is invented: the record's `provenance` is
 * `user_supplied` and `researchFindingId` is `null`.
 */

/** Domain error vocabulary, closed and safe to render. */
export type EvidenceErrorCode =
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "UNAUTHORIZED"
  | "CONFLICT"
  | "INVALID_TRANSITION"
  | "UNSUPPORTED_SOURCE"
  | "UNAVAILABLE";

export interface EvidenceError {
  code: EvidenceErrorCode;
  message: string;
  details?: { field: string; message: string }[];
}

export function evidenceError(
  code: EvidenceErrorCode,
  message: string,
  details?: { field: string; message: string }[],
): EvidenceError {
  return details ? { code, message, details } : { code, message };
}

export type {
  Account,
  AccountClaim,
  EntityId,
  Evidence,
  EvidenceProvenance,
  EvidenceStatus,
  ResearchCategory,
  ResearchClaimKind,
  ResearchConfidence,
  ResearchFinding,
  ResearchFreshness,
  ResearchRelevance,
  ResearchSourceKind,
} from "@dealora/db";

/**
 * Storage the Evidence domain depends on.
 *
 * Declared as an interface so the domain never touches the JSON store
 * directly and a different driver can replace it without editing a line of
 * evidence logic. The Phase 6 finding read is here too, because converting a
 * finding into evidence is this phase's core controlled path.
 */
export interface EvidenceRepository {
  authorize(workspaceId: EntityId, userId: EntityId): Result<unknown, { code: string }>;

  /** Resolves through the caller's own authorization: a foreign account is not found. */
  getAccount(id: EntityId, userId: EntityId): Result<Account, { code: string }>;

  /**
   * A Phase 6 finding, resolved through the caller's own authorization.
   *
   * The evidence layer reads the finding rather than trusting a caller-supplied
   * account id, which is what makes "finding belongs to this workspace and
   * this account" a fact instead of a claim.
   */
  getResearchFinding(id: EntityId, userId: EntityId): Result<ResearchFinding, { code: string }>;

  createAccountClaim(input: {
    workspaceId: EntityId;
    createdBy: EntityId;
    accountId: EntityId;
    category: ResearchCategory;
    field: string;
    value: string;
    claimKind: ResearchClaimKind;
  }): Result<AccountClaim, { code: string }>;
  getAccountClaim(id: EntityId, userId: EntityId): Result<AccountClaim, { code: string }>;
  findAccountClaimByField(
    workspaceId: EntityId,
    userId: EntityId,
    accountId: EntityId,
    category: ResearchCategory,
    field: string,
  ): Result<AccountClaim | null, { code: string }>;
  listAccountClaims(
    workspaceId: EntityId,
    userId: EntityId,
    filter?: {
      accountId?: EntityId;
      category?: ResearchCategory;
      status?: AccountClaim["status"];
    },
  ): Result<AccountClaim[], { code: string }>;
  updateAccountClaim(
    id: EntityId,
    input: { userId: EntityId; status: AccountClaim["status"] },
  ): Result<AccountClaim, { code: string }>;

  createEvidence(input: {
    workspaceId: EntityId;
    accountClaimId: EntityId;
    evidence: Omit<
      Evidence,
      "id" | "workspaceId" | "accountId" | "accountClaimId" | "createdAt" | "updatedAt"
    >;
  }): Result<Evidence, { code: string }>;
  getEvidence(id: EntityId, userId: EntityId): Result<Evidence, { code: string }>;
  listEvidence(
    workspaceId: EntityId,
    userId: EntityId,
    filter?: {
      accountId?: EntityId;
      accountClaimId?: EntityId;
      researchFindingId?: EntityId;
      status?: EvidenceStatus;
    },
  ): Result<Evidence[], { code: string }>;
  updateEvidence(
    id: EntityId,
    input: { userId: EntityId; status: EvidenceStatus },
  ): Result<Evidence, { code: string }>;
}

/**
 * Injected clock.
 *
 * Every timestamp the domain produces comes from here, so freshness and
 * recorded times are reproducible under test. `Date.now()` is never called
 * inside a transformation.
 */
export type Clock = () => Date;
