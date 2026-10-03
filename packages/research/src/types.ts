import type { Result } from "@dealora/core";
import type {
  Account,
  EntityId,
  ResearchCategory,
  ResearchFinding,
  ResearchRequest,
  ResearchRequestStatus,
  ResearchSourceKind,
} from "@dealora/db";

/**
 * @dealora/research — Research Engine (ROADMAP.md §13).
 *
 * Turns an existing Phase 5 account into **structured research findings** with
 * source attribution and timestamps.
 *
 * What this package is not, stated once so every consumer inherits it:
 *   - a research finding is **not** verified evidence. Verification, linking
 *     and audit are the Evidence System's job (ROADMAP.md §14, Phase 7);
 *   - it produces **no score**: no ICP fit, no need fit, no buying intent, no
 *     ranking, no priority. Qualification is Phase 8;
 *   - it personalizes nothing and contacts nobody: no message, no email, no
 *     CRM write, no outreach. Those are Phases 9-11;
 *   - it discovers nobody: research is always about an account the workspace
 *     already supplied.
 *
 * The only permitted inputs are the ones
 * DEALORA_BLUEPRINT.md §43 allows — user-provided data, authorized APIs,
 * permitted public/business information and approved integrations. There is
 * no code path here that bypasses authentication, robots/access controls, API
 * restrictions or rate limits.
 */

/** Domain error vocabulary, closed and safe to render. */
export type ResearchErrorCode =
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "UNAUTHORIZED"
  | "CONFLICT"
  | "UNSUPPORTED_PROVIDER"
  | "INVALID_TRANSITION"
  | "UNAVAILABLE";

export interface ResearchError {
  code: ResearchErrorCode;
  message: string;
  details?: { field: string; message: string }[];
}

export function researchError(
  code: ResearchErrorCode,
  message: string,
  details?: { field: string; message: string }[],
): ResearchError {
  return details ? { code, message, details } : { code, message };
}

export type {
  Account,
  EntityId,
  ResearchCategory,
  ResearchClaimKind,
  ResearchConfidence,
  ResearchFailureCode,
  ResearchFinding,
  ResearchFreshness,
  ResearchRelevance,
  ResearchRequest,
  ResearchRequestStatus,
  ResearchSourceKind,
} from "@dealora/db";

/**
 * Storage the Research domain depends on.
 *
 * Declared as an interface so the domain never touches the JSON store
 * directly and a different driver can replace it without editing a line of
 * research logic.
 */
export interface ResearchRepository {
  authorize(workspaceId: EntityId, userId: EntityId): Result<unknown, { code: string }>;

  /** Resolves through the caller's own authorization: a foreign account is not found. */
  getAccount(id: EntityId, userId: EntityId): Result<Account, { code: string }>;

  createResearchRequest(input: {
    workspaceId: EntityId;
    requestedBy: EntityId;
    accountId: EntityId;
    provider: string;
    categories: ResearchCategory[];
    idempotencyKey?: string | null;
  }): Result<ResearchRequest, { code: string }>;
  getResearchRequest(id: EntityId, userId: EntityId): Result<ResearchRequest, { code: string }>;
  listResearchRequests(
    workspaceId: EntityId,
    userId: EntityId,
    filter?: {
      accountId?: EntityId;
      status?: ResearchRequestStatus;
      provider?: string;
    },
  ): Result<ResearchRequest[], { code: string }>;
  findActiveResearchRequest(
    workspaceId: EntityId,
    userId: EntityId,
    accountId: EntityId,
    provider: string,
  ): Result<ResearchRequest | null, { code: string }>;
  findResearchRequestByIdempotencyKey(
    workspaceId: EntityId,
    userId: EntityId,
    idempotencyKey: string,
  ): Result<ResearchRequest | null, { code: string }>;
  updateResearchRequest(
    id: EntityId,
    input: {
      userId: EntityId;
      status: ResearchRequestStatus;
      startedAt?: string | null;
      completedAt?: string | null;
      failureCode?: ResearchRequest["failureCode"];
      failureMessage?: string | null;
      findingCount?: number;
    },
  ): Result<ResearchRequest, { code: string }>;

  createResearchFinding(input: {
    researchRequestId: EntityId;
    createdBy: EntityId;
    finding: Omit<
      ResearchFinding,
      "id" | "workspaceId" | "accountId" | "researchRequestId" | "createdAt" | "updatedAt"
    >;
  }): Result<ResearchFinding, { code: string }>;
  listResearchFindings(
    workspaceId: EntityId,
    userId: EntityId,
    filter?: {
      researchRequestId?: EntityId;
      accountId?: EntityId;
      category?: ResearchCategory;
    },
  ): Result<ResearchFinding[], { code: string }>;
  countResearchFindings(
    researchRequestId: EntityId,
    userId: EntityId,
  ): Result<number, { code: string }>;
}

/**
 * Injected clock.
 *
 * Every timestamp in the domain comes from here, so normalization is pure and
 * freshness is reproducible under test. `Date.now()` is never called inside a
 * transformation.
 */
export type Clock = () => Date;

/**
 * What a provider is allowed to see.
 *
 * The account's own public-facing identity and nothing else: no workspace id,
 * no user id, no other accounts, no contacts, no plan, no Brain data. A
 * provider cannot widen its own access by being handed more.
 */
export interface ResearchQuery {
  accountId: EntityId;
  accountName: string;
  website: string | null;
  domain: string | null;
  industry: string | null;
  companySize: string | null;
  geography: string | null;
  description: string | null;
  /** The categories this request asked for, in the order the caller asked. */
  categories: ResearchCategory[];
}

/**
 * One provider observation, still untrusted.
 *
 * Every field is `unknown` on purpose. Provider output is external input: it
 * is validated field by field before anything is persisted, and a malformed
 * observation must be a type error at the boundary rather than a runtime
 * surprise in storage.
 *
 * `source` and `sourceName` are deliberately absent — attribution is stamped
 * from the provider that produced the finding, so a provider cannot attribute
 * its output to a source it does not actually hold.
 */
export interface RawProviderFinding {
  category?: unknown;
  field?: unknown;
  value?: unknown;
  claimKind?: unknown;
  sourceUrl?: unknown;
  sourceTitle?: unknown;
  observedAt?: unknown;
  confidence?: unknown;
  relevance?: unknown;
  note?: unknown;
}

/** Why a provider could not answer. */
export type ProviderFailureCode = "unavailable" | "failed" | "invalid_output";

/** A provider's answer: structured observations, or a refusal. */
export type ResearchProviderResult =
  | { ok: true; findings: RawProviderFinding[] }
  | { ok: false; code: ProviderFailureCode; message?: string };

/**
 * A permitted source of research.
 *
 * The domain knows nothing about how a provider fetches anything; it only
 * knows that the provider declares which permitted source kind it speaks for
 * and returns observations in the shape above.
 */
export interface ResearchProvider {
  /** Stable identifier callers use to select this provider. */
  readonly id: string;
  /** Which permitted source this provider is (DEALORA_BLUEPRINT.md §43). */
  readonly source: ResearchSourceKind;
  research(query: ResearchQuery): Promise<ResearchProviderResult> | ResearchProviderResult;
}

/**
 * The providers this deployment permits.
 *
 * A registry, not a global: an application supplies its permitted providers,
 * and anything absent cannot be selected. DEALORA ships with the
 * user-provided-record provider only; no external source is assumed.
 */
export type ResearchProviderRegistry = ReadonlyMap<string, ResearchProvider>;

/** Build a registry from providers. A later provider replaces an earlier same-id one. */
export function createProviderRegistry(
  providers: readonly ResearchProvider[] = [],
): ResearchProviderRegistry {
  const registry = new Map<string, ResearchProvider>();
  for (const provider of providers) registry.set(provider.id, provider);
  return registry;
}
