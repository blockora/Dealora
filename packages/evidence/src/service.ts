import { err, ok } from "@dealora/core";
import type { Result } from "@dealora/core";
import type {
  AccountClaim,
  AccountClaimStatus,
  EntityId,
  Evidence,
  EvidenceStatus,
  ResearchFinding,
} from "@dealora/db";

import {
  ACCOUNT_CLAIM_STATUSES,
  EVIDENCE_STATUSES,
  canTransitionClaim,
  canTransitionEvidence,
  claimKey,
  freshnessFor,
  isContradiction,
  isSelfAttributableSource,
  isPermittedSourceKind,
  normalizeUserEvidence,
} from "./validation.js";
import type { UserEvidenceInput } from "./validation.js";
import type { Clock, EvidenceError, EvidenceRepository } from "./types.js";
import { evidenceError } from "./types.js";

export * from "./types.js";
export * from "./validation.js";

function fromStorage(code: string, fallback: string): EvidenceError {
  switch (code) {
    case "NOT_FOUND":
      return evidenceError("NOT_FOUND", fallback);
    case "UNAUTHORIZED":
      return evidenceError("UNAUTHORIZED", "workspace access denied");
    case "CONFLICT":
      return evidenceError("CONFLICT", fallback);
    case "INVALID":
      return evidenceError("VALIDATION_ERROR", fallback);
    default:
      return evidenceError("UNAVAILABLE", "storage unavailable");
  }
}

/** The source kind a directly-supplied record is always attributed to. */
const USER_SUPPLIED_SOURCE = "account_record" as const;

/** What one conversion produced: the evidence and the claim it supports. */
export interface EvidenceOutcome {
  evidence: Evidence;
  claim: AccountClaim;
  /**
   * Records this conversion contradicted, if any.
   *
   * They are returned rather than mutated silently so the caller can see that
   * a conflict was recorded — the contradiction is a fact about the data, not
   * a side effect worth hiding.
   */
  contradicted: Evidence[];
}

/**
 * The Evidence System application service.
 *
 * Responsibilities:
 * - Authorize every call against the server-side identity.
 * - Keep evidence inside the workspace that owns the account, so an
 *   evidence record's workspace can never differ from the claim's or the
 *   account's.
 * - Convert a research finding into evidence through a controlled path: the
 *   finding is read from storage, not described by the caller, so evidence can
 *   never cite another account's finding.
 * - Record contradictions explicitly and preserve both sides.
 * - Change status only. A record's source, value and timestamps are what the
 *   source said, and this service never rewrites them.
 *
 * It makes no qualification decision, computes no score, ranks nothing,
 * personalizes nothing and contacts nobody.
 */
export class EvidenceService {
  constructor(
    private readonly repo: EvidenceRepository,
    private readonly clock: Clock = () => new Date(),
  ) {}

  /** Resolve the caller for a workspace using the server-side identity. */
  private guard(workspaceId: EntityId, userId: EntityId): Result<true, EvidenceError> {
    if (!workspaceId || typeof workspaceId !== "string" || workspaceId.trim() === "") {
      return err(evidenceError("VALIDATION_ERROR", "workspace id is required"));
    }
    if (!userId || typeof userId !== "string") {
      return err(evidenceError("UNAUTHORIZED", "authentication required"));
    }
    const auth = this.repo.authorize(workspaceId, userId);
    if (!auth.ok) return err(fromStorage(auth.error.code, "workspace not found"));
    return ok(true);
  }

  /**
   * Load an account and prove it belongs to the caller's workspace.
   *
   * The lookup itself is authorized, so another tenant's account is simply not
   * found; the equality check is the belt to those braces.
   */
  private requireAccount(
    workspaceId: EntityId,
    userId: EntityId,
    accountId: EntityId,
  ): Result<{ id: EntityId }, EvidenceError> {
    if (!accountId || typeof accountId !== "string") {
      return err(
        evidenceError("VALIDATION_ERROR", "account id is required", [
          { field: "accountId", message: "accountId must be a string" },
        ]),
      );
    }
    const account = this.repo.getAccount(accountId, userId);
    if (!account.ok) {
      return err(
        evidenceError("NOT_FOUND", "account not found", [
          { field: "accountId", message: "the account does not exist in this workspace" },
        ]),
      );
    }
    if (account.value.workspaceId !== workspaceId) {
      return err(evidenceError("UNAUTHORIZED", "workspace access denied"));
    }
    return ok({ id: account.value.id });
  }

  /**
   * Resolve the claim for one account field, creating it when absent.
   *
   * One field per category per account always resolves to one claim, so a
   * second research run adds evidence to the same assertion instead of
   * creating a rival one.
   */
  private resolveClaim(
    workspaceId: EntityId,
    userId: EntityId,
    accountId: EntityId,
    input: {
      category: AccountClaim["category"];
      field: string;
      value: string;
      claimKind: AccountClaim["claimKind"];
    },
  ): Result<{ claim: AccountClaim; created: boolean }, EvidenceError> {
    const found = this.repo.findAccountClaimByField(
      workspaceId,
      userId,
      accountId,
      input.category,
      input.field,
    );
    if (!found.ok) return err(fromStorage(found.error.code, "claims unavailable"));
    if (found.value !== null) return ok({ claim: found.value, created: false });

    const created = this.repo.createAccountClaim({
      workspaceId,
      createdBy: userId,
      accountId,
      category: input.category,
      field: input.field,
      value: input.value,
      claimKind: input.claimKind,
    });
    if (!created.ok) return err(fromStorage(created.error.code, "claim creation failed"));
    return ok({ claim: created.value, created: true });
  }

  /**
   * Mark competing records as contradicted, and say so on the claim.
   *
   * Detection only: same account, same category, same field, different value.
   * No timestamp is consulted, so "the newer source wins" is never applied.
   * Every side is preserved and every side is marked.
   */
  private markContradiction(
    workspaceId: EntityId,
    userId: EntityId,
    claim: AccountClaim,
    candidateValue: string,
  ): Result<Evidence[], EvidenceError> {
    const existing = this.repo.listEvidence(workspaceId, userId, {
      accountClaimId: claim.id,
    });
    if (!existing.ok) return err(fromStorage(existing.error.code, "evidence unavailable"));

    // Agreement is not a contradiction: a second source saying the same thing
    // simply adds support and every record stays `recorded`.
    if (!isContradiction(claim, candidateValue)) return ok([]);

    const conflicting = existing.value.filter((e) => e.status === "recorded");
    if (conflicting.length === 0) return ok([]);

    const marked: Evidence[] = [];
    for (const record of conflicting) {
      const updated = this.repo.updateEvidence(record.id, { userId, status: "contradicted" });
      if (!updated.ok) return err(fromStorage(updated.error.code, "evidence update failed"));
      marked.push(updated.value);
    }
    return ok(marked);
  }

  /**
   * Flag the claim as contested once a contradiction is on record.
   *
   * A claim that is already `retracted` is left alone: a withdrawn claim is not
   * revived by a new observation, and un-retracting would be a silent truth
   * resolution in the other direction.
   */
  private markClaimContested(
    claim: AccountClaim,
    userId: EntityId,
  ): Result<AccountClaim, EvidenceError> {
    if (claim.status === "contested" || claim.status === "retracted") {
      return ok(claim);
    }
    if (!canTransitionClaim(claim.status, "contested")) {
      return err(
        evidenceError("INVALID_TRANSITION", "this claim cannot be marked contested", [
          { field: "status", message: `a ${claim.status} claim cannot be contested` },
        ]),
      );
    }
    const updated = this.repo.updateAccountClaim(claim.id, { userId, status: "contested" });
    if (!updated.ok) return err(fromStorage(updated.error.code, "claim update failed"));
    return ok(updated.value);
  }

  // --- Evidence ---------------------------------------------------------

  /**
   * Convert a research finding into evidence for its claim.
   *
   * The controlled path, and the only way research output becomes evidence:
   *
   * 1. the finding is loaded from storage under the caller's identity, so its
   *    workspace and account are facts rather than request-body claims;
   * 2. the account is re-authorized, so a finding can never be used to write
   *    evidence into another tenant;
   * 3. the source metadata, timestamps, confidence and freshness are copied
   *    from the finding verbatim — a citation the finding lacks stays absent
   *    rather than being reconstructed;
   * 4. a value that disagrees with the claim's existing value marks both sides
   *    contradicted and flags the claim contested.
   */
  createEvidenceFromFinding(
    workspaceId: EntityId,
    userId: EntityId,
    researchFindingId: EntityId,
  ): Result<EvidenceOutcome, EvidenceError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;
    if (!researchFindingId || typeof researchFindingId !== "string") {
      return err(
        evidenceError("VALIDATION_ERROR", "researchFindingId is required", [
          { field: "researchFindingId", message: "researchFindingId must be a string" },
        ]),
      );
    }

    const loaded = this.repo.getResearchFinding(researchFindingId, userId);
    if (!loaded.ok) {
      // A finding belonging to another tenant is not revealed to exist.
      if (loaded.error.code === "UNAUTHORIZED") {
        return err(
          evidenceError("NOT_FOUND", "research finding not found", [
            { field: "researchFindingId", message: "no such finding in this workspace" },
          ]),
        );
      }
      return err(fromStorage(loaded.error.code, "research finding not found"));
    }
    const finding = loaded.value;

    // Belt: the finding's own workspace must be the one being written into.
    if (finding.workspaceId !== workspaceId) {
      return err(evidenceError("UNAUTHORIZED", "workspace access denied"));
    }
    const account = this.requireAccount(workspaceId, userId, finding.accountId);
    if (!account.ok) return account;

    // A finding whose source kind is outside the permitted list cannot become
    // evidence. It could only have entered the store through a defect, so the
    // conversion refuses rather than propagating it.
    if (!isPermittedSourceKind(finding.source)) {
      return err(
        evidenceError("UNSUPPORTED_SOURCE", "that research source cannot be cited as evidence", [
          {
            field: "source",
            message: `source must be one of: ${finding.source}, which is not a permitted source kind`,
          },
        ]),
      );
    }

    const resolved = this.resolveClaim(workspaceId, userId, account.value.id, {
      category: finding.category,
      field: finding.field,
      value: finding.value,
      claimKind: finding.claimKind,
    });
    if (!resolved.ok) return resolved;
    let claim = resolved.value.claim;

    const contradicted = this.markContradiction(workspaceId, userId, claim, finding.value);
    if (!contradicted.ok) return contradicted;

    const created = this.repo.createEvidence({
      workspaceId,
      accountClaimId: claim.id,
      evidence: {
        researchFindingId: finding.id,
        provenance: "research_finding",
        source: finding.source,
        sourceName: finding.sourceName,
        // Copied exactly. A missing citation is never reconstructed.
        sourceUrl: finding.sourceUrl,
        sourceTitle: finding.sourceTitle,
        observedAt: finding.observedAt,
        retrievedAt: finding.retrievedAt,
        confidence: finding.confidence,
        freshness: finding.freshness,
        relevance: finding.relevance,
        note: finding.note,
        // A contradicting record is created already marked: it must never read
        // as an unopposed observation.
        status: contradicted.value.length > 0 ? "contradicted" : "recorded",
      },
    });
    if (!created.ok) return err(fromStorage(created.error.code, "evidence creation failed"));

    const contested = contradicted.value;
    if (contested.length > 0) {
      const flagged = this.markClaimContested(claim, userId);
      if (!flagged.ok) return flagged;
      claim = flagged.value;
    }

    return ok({ evidence: created.value, claim, contradicted: contested });
  }

  /**
   * Record evidence for a source the workspace supplied directly.
   *
   * The provenance that has no research request behind it. The record's source
   * kind is fixed to the workspace's own account record: it cannot be stamped
   * `approved_api` or `public_web`, because that would manufacture the
   * appearance of a source DEALORA has not read.
   */
  recordUserSuppliedEvidence(
    workspaceId: EntityId,
    userId: EntityId,
    accountId: EntityId,
    input: UserEvidenceInput,
  ): Result<EvidenceOutcome, EvidenceError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;
    const account = this.requireAccount(workspaceId, userId, accountId);
    if (!account.ok) return account;

    const normalized = normalizeUserEvidence(input);
    if (normalized.error || normalized.record === null) {
      return err(normalized.error ?? evidenceError("VALIDATION_ERROR", "invalid evidence"));
    }
    const record = normalized.record;

    if (!isSelfAttributableSource(USER_SUPPLIED_SOURCE)) {
      return err(
        evidenceError("UNSUPPORTED_SOURCE", "that source cannot be attributed to user input", [
          { field: "source", message: "user-supplied evidence must be an account record" },
        ]),
      );
    }

    const now = this.clock();
    const resolved = this.resolveClaim(workspaceId, userId, account.value.id, {
      category: record.category,
      field: record.field,
      value: record.value,
      claimKind: record.claimKind,
    });
    if (!resolved.ok) return resolved;
    let claim = resolved.value.claim;

    const contradicted = this.markContradiction(workspaceId, userId, claim, record.value);
    if (!contradicted.ok) return contradicted;

    const created = this.repo.createEvidence({
      workspaceId,
      accountClaimId: claim.id,
      evidence: {
        researchFindingId: null,
        provenance: "user_supplied",
        source: USER_SUPPLIED_SOURCE,
        sourceName: record.sourceName,
        sourceUrl: record.sourceUrl,
        sourceTitle: record.sourceTitle,
        observedAt: record.observedAt,
        retrievedAt: now.toISOString(),
        confidence: record.confidence,
        // Derived from the observation date only, and `unknown` when absent.
        freshness: freshnessFor(record.observedAt, now),
        relevance: record.relevance,
        note: record.note,
        status: contradicted.value.length > 0 ? "contradicted" : "recorded",
      },
    });
    if (!created.ok) return err(fromStorage(created.error.code, "evidence creation failed"));

    const contested = contradicted.value;
    if (contested.length > 0) {
      const flagged = this.markClaimContested(claim, userId);
      if (!flagged.ok) return flagged;
      claim = flagged.value;
    }

    return ok({ evidence: created.value, claim, contradicted: contested });
  }

  getEvidence(id: EntityId, userId: EntityId): Result<Evidence, EvidenceError> {
    if (!id || typeof id !== "string") {
      return err(evidenceError("VALIDATION_ERROR", "evidence id is required"));
    }
    const record = this.repo.getEvidence(id, userId);
    if (!record.ok) return err(fromStorage(record.error.code, "evidence not found"));
    return ok(record.value);
  }

  /**
   * A workspace's evidence, optionally narrowed.
   *
   * Nothing is excluded by default: superseded, contradicted and rejected
   * records stay listable, because the point of the phase is that history
   * remains inspectable.
   */
  listEvidence(
    workspaceId: EntityId,
    userId: EntityId,
    filter?: {
      accountId?: EntityId;
      accountClaimId?: EntityId;
      researchFindingId?: EntityId;
      status?: EvidenceStatus;
    },
  ): Result<Evidence[], EvidenceError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;
    if (filter?.status !== undefined && !EVIDENCE_STATUSES.includes(filter.status)) {
      return err(
        evidenceError("VALIDATION_ERROR", "invalid status filter", [
          { field: "status", message: `status must be one of: ${EVIDENCE_STATUSES.join(", ")}` },
        ]),
      );
    }
    const listed = this.repo.listEvidence(workspaceId, userId, filter);
    if (!listed.ok) return err(fromStorage(listed.error.code, "evidence unavailable"));
    return ok(listed.value);
  }

  /** Every record supporting one claim — the traceability direction Phase 7 exists for. */
  listEvidenceForClaim(
    accountClaimId: EntityId,
    userId: EntityId,
  ): Result<Evidence[], EvidenceError> {
    const claim = this.repo.getAccountClaim(accountClaimId, userId);
    if (!claim.ok) return err(fromStorage(claim.error.code, "claim not found"));
    const listed = this.repo.listEvidence(claim.value.workspaceId, userId, {
      accountClaimId: claim.value.id,
    });
    if (!listed.ok) return err(fromStorage(listed.error.code, "evidence unavailable"));
    return ok(listed.value);
  }

  /**
   * Move one record along the evidence lifecycle.
   *
   * Status only. `superseded` is reachable only through
   * {@link supersedeEvidence}, because it names a replacement; letting a caller
   * set it alone would record a supersession with nothing to supersede it.
   */
  changeEvidenceStatus(
    id: EntityId,
    userId: EntityId,
    status: unknown,
  ): Result<Evidence, EvidenceError> {
    if (typeof status !== "string" || !EVIDENCE_STATUSES.includes(status as EvidenceStatus)) {
      return err(
        evidenceError("VALIDATION_ERROR", "invalid evidence status", [
          { field: "status", message: `status must be one of: ${EVIDENCE_STATUSES.join(", ")}` },
        ]),
      );
    }
    const target = status as EvidenceStatus;
    const found = this.repo.getEvidence(id, userId);
    if (!found.ok) return err(fromStorage(found.error.code, "evidence not found"));
    const record = found.value;

    if (target === "superseded") {
      return err(
        evidenceError("VALIDATION_ERROR", "supersede evidence by naming its replacement", [
          {
            field: "status",
            message: "use the supersede operation with the replacement evidence id",
          },
        ]),
      );
    }
    if (!canTransitionEvidence(record.status, target)) {
      return err(
        evidenceError("INVALID_TRANSITION", "this evidence cannot change to that status", [
          {
            field: "status",
            message: `a ${record.status} record cannot become ${target}; allowed next states: ${
              EVIDENCE_STATUSES.filter((s) => canTransitionEvidence(record.status, s)).join(", ") ||
              "none"
            }`,
          },
        ]),
      );
    }

    const updated = this.repo.updateEvidence(record.id, { userId, status: target });
    if (!updated.ok) return err(fromStorage(updated.error.code, "evidence update failed"));
    return ok(updated.value);
  }

  /**
   * Point one record at its replacement.
   *
   * Supersession is always caller-directed and always names both sides. No
   * timestamp is compared and no value is judged: the workspace states which
   * observation replaced which, and the service records exactly that. The old
   * record keeps its own source, value, confidence and timestamps, and stays
   * readable — a superseded observation is history, not a deletion.
   */
  supersedeEvidence(
    supersededEvidenceId: EntityId,
    userId: EntityId,
    replacementEvidenceId: unknown,
  ): Result<{ superseded: Evidence; replacement: Evidence }, EvidenceError> {
    if (
      typeof replacementEvidenceId !== "string" ||
      replacementEvidenceId === "" ||
      !supersededEvidenceId ||
      typeof supersededEvidenceId !== "string"
    ) {
      return err(
        evidenceError("VALIDATION_ERROR", "both evidence ids are required", [
          {
            field: "replacementEvidenceId",
            message: "the replacement evidence id must be a string",
          },
        ]),
      );
    }
    if (supersededEvidenceId === replacementEvidenceId) {
      return err(
        evidenceError("VALIDATION_ERROR", "evidence cannot supersede itself", [
          { field: "replacementEvidenceId", message: "the replacement must be a different record" },
        ]),
      );
    }

    const oldRecord = this.repo.getEvidence(supersededEvidenceId, userId);
    if (!oldRecord.ok) return err(fromStorage(oldRecord.error.code, "evidence not found"));
    const newRecord = this.repo.getEvidence(replacementEvidenceId, userId);
    if (!newRecord.ok) return err(fromStorage(newRecord.error.code, "evidence not found"));

    // Both records must belong to the same claim, so a supersession is always
    // about the same assertion rather than a cross-wiring of two accounts.
    if (oldRecord.value.accountClaimId !== newRecord.value.accountClaimId) {
      return err(
        evidenceError("CONFLICT", "evidence can only supersede a record of the same claim", [
          {
            field: "replacementEvidenceId",
            message: "both evidence records must support the same claim",
          },
        ]),
      );
    }
    if (!canTransitionEvidence(oldRecord.value.status, "superseded")) {
      return err(
        evidenceError("INVALID_TRANSITION", "this evidence cannot be superseded", [
          {
            field: "status",
            message: `a ${oldRecord.value.status} record cannot be superseded`,
          },
        ]),
      );
    }

    const updated = this.repo.updateEvidence(oldRecord.value.id, {
      userId,
      status: "superseded",
    });
    if (!updated.ok) return err(fromStorage(updated.error.code, "evidence update failed"));
    return ok({ superseded: updated.value, replacement: newRecord.value });
  }

  // --- Claims -----------------------------------------------------------

  getAccountClaim(id: EntityId, userId: EntityId): Result<AccountClaim, EvidenceError> {
    if (!id || typeof id !== "string") {
      return err(evidenceError("VALIDATION_ERROR", "claim id is required"));
    }
    const claim = this.repo.getAccountClaim(id, userId);
    if (!claim.ok) return err(fromStorage(claim.error.code, "claim not found"));
    return ok(claim.value);
  }

  listAccountClaims(
    workspaceId: EntityId,
    userId: EntityId,
    filter?: { accountId?: EntityId; status?: AccountClaimStatus },
  ): Result<AccountClaim[], EvidenceError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;
    if (filter?.status !== undefined && !ACCOUNT_CLAIM_STATUSES.includes(filter.status)) {
      return err(
        evidenceError("VALIDATION_ERROR", "invalid claim status filter", [
          {
            field: "status",
            message: `status must be one of: ${ACCOUNT_CLAIM_STATUSES.join(", ")}`,
          },
        ]),
      );
    }
    const listed = this.repo.listAccountClaims(workspaceId, userId, filter);
    if (!listed.ok) return err(fromStorage(listed.error.code, "claims unavailable"));
    return ok(listed.value);
  }

  /**
   * Withdraw a claim.
   *
   * Soft: the claim becomes `retracted` and its evidence stays readable, so
   * the record of what was once asserted, and on what basis, survives the
   * withdrawal.
   */
  changeAccountClaimStatus(
    id: EntityId,
    userId: EntityId,
    status: unknown,
  ): Result<AccountClaim, EvidenceError> {
    if (
      typeof status !== "string" ||
      !ACCOUNT_CLAIM_STATUSES.includes(status as AccountClaimStatus)
    ) {
      return err(
        evidenceError("VALIDATION_ERROR", "invalid claim status", [
          {
            field: "status",
            message: `status must be one of: ${ACCOUNT_CLAIM_STATUSES.join(", ")}`,
          },
        ]),
      );
    }
    const target = status as AccountClaimStatus;
    const found = this.repo.getAccountClaim(id, userId);
    if (!found.ok) return err(fromStorage(found.error.code, "claim not found"));
    const claim = found.value;

    if (!canTransitionClaim(claim.status, target)) {
      return err(
        evidenceError("INVALID_TRANSITION", "this claim cannot change to that status", [
          {
            field: "status",
            message: `a ${claim.status} claim cannot become ${target}; allowed next states: ${
              ACCOUNT_CLAIM_STATUSES.filter((s) => canTransitionClaim(claim.status, s)).join(
                ", ",
              ) || "none"
            }`,
          },
        ]),
      );
    }

    const updated = this.repo.updateAccountClaim(claim.id, { userId, status: target });
    if (!updated.ok) return err(fromStorage(updated.error.code, "claim update failed"));
    return ok(updated.value);
  }

  /** The stable identity of a claim, for callers grouping by category and field. */
  static keyFor(claim: { category: AccountClaim["category"]; field: string }): string {
    return claimKey(claim.category, claim.field);
  }
}

export type { UserEvidenceInput, ResearchFinding };
