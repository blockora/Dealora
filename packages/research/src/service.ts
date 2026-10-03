import { err, ok } from "@dealora/core";
import type { Result } from "@dealora/core";
import type {
  EntityId,
  ResearchFailureCode,
  ResearchFinding,
  ResearchRequest,
  ResearchRequestStatus,
} from "@dealora/db";

import {
  LIMITS,
  RESEARCH_REQUEST_STATUSES,
  canTransition,
  findingKey,
  normalizeCategories,
  normalizeProviderFindings,
  providerFailureMessage,
} from "./validation.js";
import type {
  Clock,
  ResearchError,
  ResearchProvider,
  ResearchProviderRegistry,
  ResearchQuery,
  ResearchRepository,
} from "./types.js";
import { researchError } from "./types.js";

export * from "./types.js";
export * from "./validation.js";
export {
  ACCOUNT_RECORD_PROVIDER_ID,
  AccountRecordProvider,
  StaticResearchProvider,
} from "./provider.js";

function fromStorage(code: string, fallback: string): ResearchError {
  switch (code) {
    case "NOT_FOUND":
      return researchError("NOT_FOUND", fallback);
    case "UNAUTHORIZED":
      return researchError("UNAUTHORIZED", "workspace access denied");
    case "CONFLICT":
      return researchError("CONFLICT", fallback);
    case "INVALID":
      return researchError("VALIDATION_ERROR", fallback);
    default:
      return researchError("UNAVAILABLE", "storage unavailable");
  }
}

/** Untrusted research input: every field may be absent or of any type. */
export interface CreateResearchRequestInput {
  provider?: unknown;
  categories?: unknown;
  idempotencyKey?: unknown;
}

/** What one run produced: the request as it now stands, plus its findings. */
export interface ResearchRunOutcome {
  request: ResearchRequest;
  findings: ResearchFinding[];
}

/**
 * The Research Engine application service.
 *
 * Responsibilities:
 * - Authorize every call against the server-side identity.
 * - Keep research inside the workspace that owns the account, so a research
 *   request's workspace can never differ from the account's.
 * - Select a **permitted** provider, or refuse: an unregistered provider is an
 *   error, never a silent fallback.
 * - Run the minimal lifecycle, rejecting illegal transitions.
 * - Validate provider output before anything is written, and keep a retry
 *   idempotent against findings an earlier attempt already recorded.
 *
 * It does not verify claims, score accounts, rank prospects, draft messages or
 * contact anyone. Findings leave this service as observations with provenance.
 */
export class ResearchService {
  constructor(
    private readonly repo: ResearchRepository,
    private readonly providers: ResearchProviderRegistry,
    private readonly clock: Clock = () => new Date(),
  ) {}

  /** Resolve the caller for a workspace using the server-side identity. */
  private guard(workspaceId: EntityId, userId: EntityId): Result<true, ResearchError> {
    if (!workspaceId || typeof workspaceId !== "string" || workspaceId.trim() === "") {
      return err(researchError("VALIDATION_ERROR", "workspace id is required"));
    }
    if (!userId || typeof userId !== "string") {
      return err(researchError("UNAUTHORIZED", "authentication required"));
    }
    const auth = this.repo.authorize(workspaceId, userId);
    if (!auth.ok) return err(fromStorage(auth.error.code, "workspace not found"));
    return ok(true);
  }

  /**
   * Load an account and prove it belongs to the caller's workspace.
   *
   * The lookup itself is authorized, so another tenant's account is simply
   * not found; the equality check is the belt to that braces.
   */
  private requireAccount(
    workspaceId: EntityId,
    userId: EntityId,
    accountId: EntityId,
  ): Result<{ id: EntityId; workspaceId: EntityId; status: string }, ResearchError> {
    if (!accountId || typeof accountId !== "string") {
      return err(
        researchError("VALIDATION_ERROR", "account id is required", [
          { field: "accountId", message: "accountId must be a string" },
        ]),
      );
    }
    const account = this.repo.getAccount(accountId, userId);
    if (!account.ok) {
      return err(
        researchError("NOT_FOUND", "account not found", [
          { field: "accountId", message: "the account does not exist in this workspace" },
        ]),
      );
    }
    if (account.value.workspaceId !== workspaceId) {
      return err(researchError("UNAUTHORIZED", "workspace access denied"));
    }
    if (account.value.status === "archived") {
      return err(
        researchError("CONFLICT", "an archived account cannot be researched", [
          { field: "accountId", message: "the account is archived" },
        ]),
      );
    }
    return ok({
      id: account.value.id,
      workspaceId: account.value.workspaceId,
      status: account.value.status,
    });
  }

  /** The provider a request named, or a refusal naming what is available. */
  private requireProvider(id: unknown): Result<ResearchProvider, ResearchError> {
    if (typeof id !== "string" || id.trim() === "") {
      return err(
        researchError("VALIDATION_ERROR", "provider is required", [
          { field: "provider", message: "provider must be a string" },
        ]),
      );
    }
    const provider = this.providers.get(id.trim());
    if (!provider) {
      return err(
        researchError("UNSUPPORTED_PROVIDER", "that research provider is not available", [
          {
            field: "provider",
            message: `no permitted provider named "${id}" is registered for this workspace`,
          },
        ]),
      );
    }
    return ok(provider);
  }

  // --- Requests ---------------------------------------------------------

  /**
   * Create a research request against an existing account.
   *
   * Two guards keep repeated calls from spawning uncontrolled duplicate work:
   *   - an optional `idempotencyKey` makes a replay return the original
   *     request instead of a second one;
   *   - a request that is still `pending` or `running` for the same account and
   *     provider is reported as a conflict, so there is at most one active
   *     research job per account and provider.
   */
  createResearchRequest(
    workspaceId: EntityId,
    userId: EntityId,
    accountId: EntityId,
    input: CreateResearchRequestInput,
  ): Result<ResearchRequest, ResearchError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;
    const account = this.requireAccount(workspaceId, userId, accountId);
    if (!account.ok) return account;

    const provider = this.requireProvider(input.provider);
    if (!provider.ok) return provider;

    const { categories, error: categoryError } = normalizeCategories(input.categories);
    if (categoryError) return err(categoryError);

    const idempotencyKey =
      input.idempotencyKey === undefined || input.idempotencyKey === null
        ? null
        : typeof input.idempotencyKey === "string"
          ? input.idempotencyKey.trim().slice(0, LIMITS.idempotencyKey)
          : null;
    if (input.idempotencyKey !== undefined && input.idempotencyKey !== null) {
      if (typeof input.idempotencyKey !== "string") {
        return err(
          researchError("VALIDATION_ERROR", "idempotencyKey must be a string", [
            { field: "idempotencyKey", message: "idempotencyKey must be a string" },
          ]),
        );
      }
      if (input.idempotencyKey.trim().length > LIMITS.idempotencyKey) {
        return err(
          researchError("VALIDATION_ERROR", "idempotencyKey is too long", [
            {
              field: "idempotencyKey",
              message: `idempotencyKey must be at most ${LIMITS.idempotencyKey} characters`,
            },
          ]),
        );
      }
    }

    if (idempotencyKey !== null && idempotencyKey !== "") {
      const replay = this.repo.findResearchRequestByIdempotencyKey(
        workspaceId,
        userId,
        idempotencyKey,
      );
      if (!replay.ok) {
        return err(fromStorage(replay.error.code, "research requests unavailable"));
      }
      // A replay returns the original request rather than starting new work.
      if (replay.value !== null) return ok(replay.value);
    }

    const active = this.repo.findActiveResearchRequest(
      workspaceId,
      userId,
      account.value.id,
      provider.value.id,
    );
    if (!active.ok) {
      return err(fromStorage(active.error.code, "research requests unavailable"));
    }
    if (active.value !== null) {
      return err(
        researchError("CONFLICT", "a research request for this account is already in progress", [
          {
            field: "provider",
            message: `request ${active.value.id} is ${active.value.status}; wait for it to finish or cancel it`,
          },
        ]),
      );
    }

    const created = this.repo.createResearchRequest({
      workspaceId,
      requestedBy: userId,
      accountId: account.value.id,
      provider: provider.value.id,
      categories: categories ?? [],
      idempotencyKey: idempotencyKey === "" ? null : idempotencyKey,
    });
    if (!created.ok)
      return err(fromStorage(created.error.code, "research request creation failed"));
    return ok(created.value);
  }

  getResearchRequest(id: EntityId, userId: EntityId): Result<ResearchRequest, ResearchError> {
    if (!id || typeof id !== "string") {
      return err(researchError("VALIDATION_ERROR", "research request id is required"));
    }
    const request = this.repo.getResearchRequest(id, userId);
    if (!request.ok) return err(fromStorage(request.error.code, "research request not found"));
    return ok(request.value);
  }

  listResearchRequests(
    workspaceId: EntityId,
    userId: EntityId,
    filter?: { accountId?: EntityId; status?: ResearchRequestStatus; provider?: string },
  ): Result<ResearchRequest[], ResearchError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;
    if (filter?.status !== undefined && !RESEARCH_REQUEST_STATUSES.includes(filter.status)) {
      return err(
        researchError("VALIDATION_ERROR", "invalid status filter", [
          {
            field: "status",
            message: `status must be one of: ${RESEARCH_REQUEST_STATUSES.join(", ")}`,
          },
        ]),
      );
    }
    const listed = this.repo.listResearchRequests(workspaceId, userId, filter);
    if (!listed.ok) return err(fromStorage(listed.error.code, "research requests unavailable"));
    return ok(listed.value);
  }

  /** The findings recorded by one request. */
  listFindingsForRequest(
    researchRequestId: EntityId,
    userId: EntityId,
  ): Result<ResearchFinding[], ResearchError> {
    const request = this.getResearchRequest(researchRequestId, userId);
    if (!request.ok) return request;
    const findings = this.repo.listResearchFindings(request.value.workspaceId, userId, {
      researchRequestId: request.value.id,
    });
    if (!findings.ok) return err(fromStorage(findings.error.code, "research findings unavailable"));
    return ok(findings.value);
  }

  /** The findings recorded for one account across every request. */
  listFindingsForAccount(
    workspaceId: EntityId,
    userId: EntityId,
    accountId: EntityId,
  ): Result<ResearchFinding[], ResearchError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;
    const account = this.requireAccount(workspaceId, userId, accountId);
    if (!account.ok) return account;
    const findings = this.repo.listResearchFindings(workspaceId, userId, {
      accountId: account.value.id,
    });
    if (!findings.ok) return err(fromStorage(findings.error.code, "research findings unavailable"));
    return ok(findings.value);
  }

  /**
   * Run a research request.
   *
   * The failure path is as explicit as the success path: a provider that is
   * unavailable, that fails, or that answers with something unusable leaves the
   * request in `failed` state **with the reason recorded**, and is returned as
   * such rather than reported as a success with nothing in it.
   */
  async runResearchRequest(
    researchRequestId: EntityId,
    userId: EntityId,
  ): Promise<Result<ResearchRunOutcome, ResearchError>> {
    const found = this.getResearchRequest(researchRequestId, userId);
    if (!found.ok) return found;
    const request = found.value;

    if (!canTransition(request.status, "running")) {
      return err(
        researchError(
          "INVALID_TRANSITION",
          "this research request cannot be run from its current state",
          [
            {
              field: "status",
              message: `a ${request.status} request cannot be run; allowed next states: ${
                RESEARCH_REQUEST_STATUSES.filter((s) => canTransition(request.status, s)).join(
                  ", ",
                ) || "none"
              }`,
            },
          ],
        ),
      );
    }

    // Re-check ownership at run time: a request outlives the call that made it.
    const account = this.repo.getAccount(request.accountId, userId);
    if (!account.ok) {
      return err(
        researchError("NOT_FOUND", "account not found", [
          { field: "accountId", message: "the account no longer exists in this workspace" },
        ]),
      );
    }
    if (account.value.workspaceId !== request.workspaceId) {
      return err(researchError("UNAUTHORIZED", "workspace access denied"));
    }

    const startedAt = this.clock();
    const prior = this.repo.listResearchFindings(request.workspaceId, userId, {
      researchRequestId: request.id,
    });
    if (!prior.ok) return err(fromStorage(prior.error.code, "research findings unavailable"));
    const existingKeys = new Set(prior.value.map((f) => findingKey(f.category, f.field)));

    const running = this.repo.updateResearchRequest(request.id, {
      userId,
      status: "running",
      startedAt: startedAt.toISOString(),
      completedAt: null,
      failureCode: null,
      failureMessage: null,
      findingCount: prior.value.length,
    });
    if (!running.ok) return err(fromStorage(running.error.code, "research request update failed"));

    const provider = this.providers.get(request.provider);
    if (!provider) {
      return this.failRun(
        request.id,
        userId,
        "provider_unavailable",
        providerFailureMessage("unavailable"),
      );
    }

    const query: ResearchQuery = {
      accountId: account.value.id,
      accountName: account.value.name,
      website: account.value.website,
      domain: account.value.domain,
      industry: account.value.industry,
      companySize: account.value.companySize,
      geography: account.value.geography,
      description: account.value.description,
      categories: request.categories,
    };

    let answer;
    try {
      answer = await this.askProvider(provider, query);
    } catch {
      // A provider that throws is a provider that failed: caught, recorded,
      // never allowed to escape as an unhandled rejection.
      return this.failRun(request.id, userId, "provider_failed", providerFailureMessage("failed"));
    }

    if (!answer.ok) {
      return this.failRun(
        request.id,
        userId,
        this.failureCodeFor(answer.code),
        providerFailureMessage(answer.code),
      );
    }

    const normalized = normalizeProviderFindings(answer.findings, {
      provider,
      scope: request.categories,
      now: this.clock(),
    });
    if (normalized.error) {
      return this.failRun(
        request.id,
        userId,
        "invalid_provider_output",
        providerFailureMessage("invalid_output"),
      );
    }

    let recorded = prior.value.length;
    for (const finding of normalized.findings) {
      // Retry-safe: a finding an earlier attempt already recorded is not
      // recorded twice, so re-running converges instead of accumulating.
      const key = findingKey(finding.category, finding.field);
      if (existingKeys.has(key)) continue;
      const saved = this.repo.createResearchFinding({
        researchRequestId: request.id,
        createdBy: userId,
        finding: { ...finding },
      });
      if (!saved.ok) {
        const failed = await this.failRun(
          request.id,
          userId,
          "storage_failed",
          "the research findings could not be stored",
        );
        if (!failed.ok) return failed;
        return err(researchError("UNAVAILABLE", "research storage unavailable"));
      }
      existingKeys.add(key);
      recorded += 1;
    }

    const completed = this.repo.updateResearchRequest(request.id, {
      userId,
      status: "completed",
      completedAt: this.clock().toISOString(),
      failureCode: null,
      failureMessage: null,
      findingCount: recorded,
    });
    if (!completed.ok)
      return err(fromStorage(completed.error.code, "research request update failed"));

    const findings = this.repo.listResearchFindings(request.workspaceId, userId, {
      researchRequestId: request.id,
    });
    if (!findings.ok) return err(fromStorage(findings.error.code, "research findings unavailable"));
    return ok({ request: completed.value, findings: findings.value });
  }

  /** Cancel a request that has not finished. */
  cancelResearchRequest(
    researchRequestId: EntityId,
    userId: EntityId,
  ): Result<ResearchRequest, ResearchError> {
    const found = this.getResearchRequest(researchRequestId, userId);
    if (!found.ok) return found;
    const request = found.value;
    if (!canTransition(request.status, "cancelled")) {
      return err(
        researchError("INVALID_TRANSITION", "this research request cannot be cancelled", [
          { field: "status", message: `a ${request.status} request is already finished` },
        ]),
      );
    }
    const cancelled = this.repo.updateResearchRequest(request.id, {
      userId,
      status: "cancelled",
      completedAt: this.clock().toISOString(),
    });
    if (!cancelled.ok)
      return err(fromStorage(cancelled.error.code, "research request update failed"));
    return ok(cancelled.value);
  }

  /** Ask a provider, normalizing a promise and a plain result into one shape. */
  private async askProvider(
    provider: ResearchProvider,
    query: ResearchQuery,
  ): Promise<Awaited<ReturnType<ResearchProvider["research"]>>> {
    return await provider.research(query);
  }

  private failureCodeFor(code: string): ResearchFailureCode {
    if (code === "unavailable") return "provider_unavailable";
    if (code === "invalid_output") return "invalid_provider_output";
    return "provider_failed";
  }

  /**
   * Record a failed run and return it.
   *
   * The request keeps whatever findings an earlier attempt recorded; only the
   * reason and the completion timestamp change.
   */
  private failRun(
    researchRequestId: EntityId,
    userId: EntityId,
    failureCode: ResearchFailureCode,
    message: string,
  ): Result<ResearchRunOutcome, ResearchError> {
    const updated = this.repo.updateResearchRequest(researchRequestId, {
      userId,
      status: "failed",
      completedAt: this.clock().toISOString(),
      failureCode,
      failureMessage: message,
    });
    if (!updated.ok) return err(fromStorage(updated.error.code, "research request update failed"));
    const findings = this.repo.listResearchFindings(updated.value.workspaceId, userId, {
      researchRequestId: updated.value.id,
    });
    if (!findings.ok) return err(fromStorage(findings.error.code, "research findings unavailable"));
    return ok({ request: updated.value, findings: findings.value });
  }
}
