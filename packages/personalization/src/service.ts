import { err, ok } from "@dealora/core";
import type { Result } from "@dealora/core";
import type {
  Account,
  AccountClaim,
  Claim,
  Contact,
  EntityId,
  Evidence,
  PersonalizedDraft,
} from "@dealora/db";

import { renderDraft } from "./render.js";
import { PERSONALIZATION_RENDERER_VERSION, SUPPORTED_RENDERER_VERSIONS } from "./rules.js";
import {
  DRAFTS_ARE_IMMUTABLE,
  describeRenderer,
  isSupportedRendererVersion,
  text,
} from "./validation.js";
import type { RendererView } from "./validation.js";
import type {
  Clock,
  PersonalizationApprovedClaim,
  PersonalizationError,
  PersonalizationOfferReader,
  PersonalizationOfferSnapshot,
  PersonalizationQualificationReader,
  PersonalizationQualificationSnapshot,
  PersonalizationRepository,
} from "./types.js";
import { personalizationError } from "./types.js";

export * from "./types.js";
export * from "./rules.js";
export * from "./validation.js";
export { renderDraft } from "./render.js";
export type { DraftRenderInput, DraftRenderOutput, RenderedDraft } from "./render.js";

function fromStorage(code: string, fallback: string): PersonalizationError {
  switch (code) {
    case "NOT_FOUND":
      return personalizationError("NOT_FOUND", fallback);
    case "UNAUTHORIZED":
      return personalizationError("UNAUTHORIZED", "workspace access denied");
    case "CONFLICT":
      return personalizationError("CONFLICT", fallback);
    case "INVALID":
      return personalizationError("VALIDATION_ERROR", fallback);
    default:
      // Never surface an internal storage message.
      return personalizationError("UNAVAILABLE", "storage unavailable");
  }
}

/** What the caller may influence: never the draft, only which of its own context to use. */
export interface GenerateDraftOptions {
  /** Which qualification of this account to draft for. Defaults to the newest. */
  qualificationId?: unknown;
  /** Which of the workspace's active offers to present. */
  offerId?: unknown;
  /** Which contact of this account the draft addresses. */
  contactId?: unknown;
  /** Which renderer to compose under. Validated against what we implement. */
  rendererVersion?: unknown;
}

/** A draft together with the records that explain every statement in it. */
export interface DraftInspection {
  draft: PersonalizedDraft;
  /** The account claims the draft's points state. References, not copies. */
  claims: AccountClaim[];
  /** The evidence behind those claims. References, not copies. */
  evidence: Evidence[];
  /** The approved Business Brain claims the body quotes. */
  approvedClaims: Claim[];
  /** The qualification the draft was generated for. */
  qualification: PersonalizationQualificationSnapshot | null;
  /** The offer the draft presents. */
  offer: PersonalizationOfferSnapshot | null;
}

/**
 * The Personalization Engine application service.
 *
 * Responsibilities:
 * - Authorize every call against the server-side identity.
 * - Require a `qualified` evaluation before drafting. `ROADMAP.md` §16's loop
 *   runs QUALIFICATION before PERSONALIZATION, and a draft generated for an
 *   account DEALORA has not qualified would let outreach skip the gate the
 *   roadmap put there.
 * - Resolve the offer, contact, claims, evidence and approved claims
 *   server-side, so a caller selects *which of the workspace's own* context to
 *   draft from and never supplies content.
 * - Render through the deterministic renderer and persist the result as a new,
 *   immutable, versioned record.
 *
 * It sends nothing, approves nothing and contacts nobody. A draft is a
 * document; the approval boundary is Phase 10 and the send path is Phase 11.
 */
export class PersonalizationService {
  constructor(
    private readonly repo: PersonalizationRepository,
    private readonly qualifications: PersonalizationQualificationReader,
    private readonly offers: PersonalizationOfferReader,
    private readonly clock: Clock = () => new Date(),
  ) {}

  /** Resolve the caller for a workspace using the server-side identity. */
  private guard(workspaceId: EntityId, userId: EntityId): Result<true, PersonalizationError> {
    if (!workspaceId || typeof workspaceId !== "string" || workspaceId.trim() === "") {
      return err(personalizationError("VALIDATION_ERROR", "workspace id is required"));
    }
    if (!userId || typeof userId !== "string") {
      return err(personalizationError("UNAUTHORIZED", "authentication required"));
    }
    const auth = this.repo.authorize(workspaceId, userId);
    if (!auth.ok) return err(fromStorage(auth.error.code, "workspace not found"));
    return ok(true);
  }

  /** Only a renderer this deployment implements may be asked for. */
  private requireRendererVersion(requested: unknown): Result<string, PersonalizationError> {
    if (requested === undefined || requested === null || requested === "") {
      return ok(PERSONALIZATION_RENDERER_VERSION);
    }
    if (!isSupportedRendererVersion(requested)) {
      return err(
        personalizationError(
          "UNSUPPORTED_RENDERER_VERSION",
          "that renderer version is not supported",
          [
            {
              field: "rendererVersion",
              message: `rendererVersion must be one of: ${SUPPORTED_RENDERER_VERSIONS.join(", ")}`,
            },
          ],
        ),
      );
    }
    return ok(requested);
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
  ): Result<Account, PersonalizationError> {
    if (!accountId || typeof accountId !== "string") {
      return err(
        personalizationError("VALIDATION_ERROR", "account id is required", [
          { field: "accountId", message: "accountId must be a string" },
        ]),
      );
    }
    const found = this.repo.getAccount(accountId, userId);
    if (!found.ok) {
      // A foreign account is not revealed to exist.
      return err(
        personalizationError("NOT_FOUND", "account not found", [
          { field: "accountId", message: "the account does not exist in this workspace" },
        ]),
      );
    }
    if (found.value.workspaceId !== workspaceId) {
      return err(personalizationError("UNAUTHORIZED", "workspace access denied"));
    }
    if (found.value.status === "archived") {
      return err(
        personalizationError("CONFLICT", "this account is archived and is no longer a target", [
          { field: "accountId", message: "an archived account cannot be drafted for" },
        ]),
      );
    }
    return ok(found.value);
  }

  /**
   * The qualification this draft is generated for.
   *
   * Precedence: one the caller named, validated to belong to this workspace and
   * this account; otherwise the newest evaluation for the account. The state
   * must be `qualified` — the renderer composes from evidence a qualification
   * already found eligible, and drafting for an `unqualified`,
   * `insufficient_data` or `contested` account would send outreach past the
   * roadmap's QUALIFICATION step.
   */
  private requireQualification(
    workspaceId: EntityId,
    userId: EntityId,
    accountId: EntityId,
    requested: unknown,
  ): Result<PersonalizationQualificationSnapshot, PersonalizationError> {
    let snapshot: PersonalizationQualificationSnapshot | null;
    if (requested !== undefined && requested !== null && requested !== "") {
      if (typeof requested !== "string") {
        return err(
          personalizationError("VALIDATION_ERROR", "qualificationId must be a string", [
            { field: "qualificationId", message: "qualificationId must be a string" },
          ]),
        );
      }
      snapshot = this.qualifications.byId(requested, userId);
    } else {
      snapshot = this.qualifications.latest(workspaceId, userId, accountId);
    }

    if (snapshot === null) {
      return err(
        personalizationError("NOT_FOUND", "this account has no qualification evaluation", [
          {
            field: "qualificationId",
            message: "qualify the account before generating a draft for it",
          },
        ]),
      );
    }
    if (snapshot.workspaceId !== workspaceId || snapshot.accountId !== accountId) {
      // Never confirm that another workspace's evaluation exists.
      return err(personalizationError("NOT_FOUND", "qualification not found"));
    }
    if (snapshot.state !== "qualified") {
      return err(
        personalizationError(
          "CONFLICT",
          `this account's latest qualification is ${snapshot.state}, not qualified`,
          [
            {
              field: "qualificationId",
              message: "personalization requires a qualified account",
            },
          ],
        ),
      );
    }
    return ok(snapshot);
  }

  /**
   * The offer the draft presents.
   *
   * Only an `active` offer may be presented externally: a `draft` offer is
   * still being written and a `retired` one is no longer sold. When no offer is
   * named and the workspace has exactly one active offer, that one is used; an
   * ambiguous or absent set is refused rather than guessed, because presenting
   * the wrong offer is a commercial statement.
   */
  private requireOffer(
    workspaceId: EntityId,
    userId: EntityId,
    requested: unknown,
  ): Result<PersonalizationOfferSnapshot, PersonalizationError> {
    if (requested !== undefined && requested !== null && requested !== "") {
      if (typeof requested !== "string") {
        return err(
          personalizationError("VALIDATION_ERROR", "offerId must be a string", [
            { field: "offerId", message: "offerId must be a string" },
          ]),
        );
      }
      const offer = this.offers.byId(requested, userId);
      if (offer === null) {
        return err(
          personalizationError("NOT_FOUND", "offer not found", [
            { field: "offerId", message: "no such offer in this workspace" },
          ]),
        );
      }
      if (offer.status !== "active") {
        return err(
          personalizationError("CONFLICT", `that offer is ${offer.status}, not active`, [
            { field: "offerId", message: "only an active offer may be presented" },
          ]),
        );
      }
      return ok(offer);
    }

    const active = this.offers.listActive(workspaceId, userId);
    const first = active[0];
    if (first === undefined) {
      return err(
        personalizationError("NOT_FOUND", "this workspace has no active offer to present", [
          { field: "offerId", message: "activate an offer before generating a draft" },
        ]),
      );
    }
    if (active.length > 1) {
      return err(
        personalizationError(
          "VALIDATION_ERROR",
          "this workspace has several active offers, so one must be named",
          [
            {
              field: "offerId",
              message: `offerId is required when more than one offer is active (${active.length} are)`,
            },
          ],
        ),
      );
    }
    return ok(first);
  }

  /**
   * The contact the draft addresses, when one was named.
   *
   * A contact is optional — a draft may be prepared before a recipient is
   * chosen — but a named contact must belong to this account and this
   * workspace, and the renderer records a warning when there is none.
   */
  private requireContact(
    workspaceId: EntityId,
    userId: EntityId,
    accountId: EntityId,
    requested: unknown,
  ): Result<Contact | null, PersonalizationError> {
    if (requested === undefined || requested === null || requested === "") return ok(null);
    if (typeof requested !== "string") {
      return err(
        personalizationError("VALIDATION_ERROR", "contactId must be a string", [
          { field: "contactId", message: "contactId must be a string" },
        ]),
      );
    }
    const found = this.repo.getContact(requested, userId);
    if (!found.ok) {
      return err(
        personalizationError("NOT_FOUND", "contact not found", [
          { field: "contactId", message: "no such contact in this workspace" },
        ]),
      );
    }
    if (found.value.workspaceId !== workspaceId || found.value.accountId !== accountId) {
      return err(
        personalizationError("NOT_FOUND", "contact not found", [
          { field: "contactId", message: "the contact does not belong to this account" },
        ]),
      );
    }
    if (found.value.status === "archived") {
      return err(
        personalizationError("CONFLICT", "this contact is archived and is no longer a target", [
          { field: "contactId", message: "an archived contact cannot be addressed" },
        ]),
      );
    }
    return ok(found.value);
  }

  /**
   * Generate one draft for a qualified account and persist it as a new version.
   *
   * The full precondition chain runs before anything is read for composition:
   * authenticate → authorize → renderer version → account → qualification →
   * offer → contact → claims and evidence → approved claims → render →
   * persist.
   *
   * Nothing about the content is accepted from the caller. `options` chooses
   * *which of the workspace's own* qualification, offer and contact to draft
   * from; the subject, the body, every personalization point and every warning
   * come from the deterministic renderer alone.
   */
  generateDraft(
    workspaceId: EntityId,
    userId: EntityId,
    accountId: EntityId,
    options?: GenerateDraftOptions,
  ): Result<PersonalizedDraft, PersonalizationError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;

    const rendererVersion = this.requireRendererVersion(options?.rendererVersion);
    if (!rendererVersion.ok) return rendererVersion;
    const account = this.requireAccount(workspaceId, userId, accountId);
    if (!account.ok) return account;
    const qualification = this.requireQualification(
      workspaceId,
      userId,
      account.value.id,
      options?.qualificationId,
    );
    if (!qualification.ok) return qualification;
    const offer = this.requireOffer(workspaceId, userId, options?.offerId);
    if (!offer.ok) return offer;
    const contact = this.requireContact(workspaceId, userId, account.value.id, options?.contactId);
    if (!contact.ok) return contact;

    const claims = this.repo.listAccountClaims(workspaceId, userId, account.value.id);
    if (!claims.ok) return err(fromStorage(claims.error.code, "account claims unavailable"));
    const evidence = this.repo.listEvidence(workspaceId, userId, { accountId: account.value.id });
    if (!evidence.ok) return err(fromStorage(evidence.error.code, "evidence unavailable"));
    const approved = this.repo.listApprovedClaims(workspaceId, userId);
    if (!approved.ok) return err(fromStorage(approved.error.code, "approved claims unavailable"));

    // Only `approved` Phase 2 claims are quotable. `unverified` text is context
    // and `restricted` text must never leave the workspace; the repository
    // filters on status, and this narrows the shape the renderer consumes.
    const approvedClaims: PersonalizationApprovedClaim[] = approved.value.map((claim) => ({
      id: claim.id,
      text: claim.text,
    }));

    const rendered = renderDraft({
      rendererVersion: rendererVersion.value,
      account: { id: account.value.id, name: account.value.name },
      contact:
        contact.value === null ? null : { id: contact.value.id, fullName: contact.value.fullName },
      qualificationId: qualification.value.id,
      offer: offer.value,
      claims: claims.value,
      evidence: evidence.value,
      approvedClaims,
    });

    const created = this.repo.createDraft({
      workspaceId,
      createdBy: userId,
      accountId: account.value.id,
      draft: {
        contactId: contact.value?.id ?? null,
        rendererVersion: rendererVersion.value,
        contextDigest: rendered.contextDigest,
        qualificationId: qualification.value.id,
        offerId: offer.value.id,
        subject: rendered.subject,
        body: rendered.body,
        personalizationPoints: rendered.points,
        approvedClaimIds: rendered.approvedClaimIds,
        warnings: rendered.warnings,
      },
    });
    if (!created.ok) return err(fromStorage(created.error.code, "draft creation failed"));
    return ok(created.value);
  }

  getDraft(id: EntityId, userId: EntityId): Result<PersonalizedDraft, PersonalizationError> {
    if (!id || typeof id !== "string") {
      return err(personalizationError("VALIDATION_ERROR", "draft id is required"));
    }
    const found = this.repo.getDraft(id, userId);
    if (!found.ok) return err(fromStorage(found.error.code, "draft not found"));
    return ok(found.value);
  }

  /**
   * A workspace's drafts, newest first, optionally narrowed to one account.
   *
   * Every version stays listable: an approval may be bound to any of them, and
   * a record that disappears from a listing is a record a reviewer cannot
   * re-check.
   */
  listDrafts(
    workspaceId: EntityId,
    userId: EntityId,
    filter?: { accountId?: unknown },
  ): Result<PersonalizedDraft[], PersonalizationError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;
    let narrowed: { accountId?: EntityId } | undefined;
    if (filter?.accountId !== undefined && filter.accountId !== null && filter.accountId !== "") {
      if (typeof filter.accountId !== "string") {
        return err(
          personalizationError("VALIDATION_ERROR", "accountId must be a string", [
            { field: "accountId", message: "accountId must be a string" },
          ]),
        );
      }
      narrowed = { accountId: filter.accountId };
    }
    const listed = this.repo.listDrafts(workspaceId, userId, narrowed);
    if (!listed.ok) return err(fromStorage(listed.error.code, "drafts unavailable"));
    return ok(listed.value);
  }

  /**
   * What a draft says and why — the phase's gate, "generate a personalized
   * draft with supporting evidence", served in one read.
   *
   * The records are joined from storage rather than copied into the draft, so
   * the stored draft stays small and the claim, evidence and approved-claim
   * records stay the single source of truth. Only what the draft actually
   * referenced is returned, so the view cannot imply support that the body
   * does not rest on.
   */
  inspectDraft(id: EntityId, userId: EntityId): Result<DraftInspection, PersonalizationError> {
    const found = this.getDraft(id, userId);
    if (!found.ok) return found;
    const draft = found.value;

    const claims = this.repo.listAccountClaims(draft.workspaceId, userId, draft.accountId);
    if (!claims.ok) return err(fromStorage(claims.error.code, "account claims unavailable"));
    const evidence = this.repo.listEvidence(draft.workspaceId, userId, {
      accountId: draft.accountId,
    });
    if (!evidence.ok) return err(fromStorage(evidence.error.code, "evidence unavailable"));
    const approved = this.repo.listApprovedClaims(draft.workspaceId, userId);
    if (!approved.ok) return err(fromStorage(approved.error.code, "approved claims unavailable"));

    const claimIds = new Set(draft.personalizationPoints.map((point) => point.claimId));
    const evidenceIds = new Set(draft.personalizationPoints.flatMap((point) => point.evidenceIds));
    const qualification =
      draft.qualificationId === null
        ? null
        : this.qualifications.byId(draft.qualificationId, userId);
    const offer = draft.offerId === null ? null : this.offers.byId(draft.offerId, userId);

    return ok({
      draft,
      claims: claims.value.filter((claim) => claimIds.has(claim.id)),
      evidence: evidence.value.filter((record) => evidenceIds.has(record.id)),
      approvedClaims: approved.value.filter((claim) => draft.approvedClaimIds.includes(claim.id)),
      qualification,
      offer,
    });
  }

  /**
   * The renderer this deployment composes under, inspectable on its own terms.
   *
   * The point of exposing this is the same as the qualification criteria
   * inspector: what a draft may and may not say is readable before any draft
   * exists, rather than only as a by-product of one.
   */
  describePersonalizationRenderer(
    workspaceId: EntityId,
    userId: EntityId,
    requested?: { rendererVersion?: unknown },
  ): Result<RendererView, PersonalizationError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;
    const rendererVersion = this.requireRendererVersion(requested?.rendererVersion);
    if (!rendererVersion.ok) return rendererVersion;
    return ok(describeRenderer());
  }

  /** Every renderer version this deployment can compose under. */
  static supportedRendererVersions(): readonly string[] {
    return SUPPORTED_RENDERER_VERSIONS;
  }

  /** Whether drafts are immutable documents. Always true. See validation.ts. */
  static draftsAreImmutable(): boolean {
    return DRAFTS_ARE_IMMUTABLE;
  }
}

export { text };
