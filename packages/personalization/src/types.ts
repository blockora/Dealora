import type { Result } from "@dealora/core";
import type {
  Account,
  AccountClaim,
  Claim,
  Contact,
  EntityId,
  Evidence,
  OfferStatus,
  PersonalizedDraft,
  QualificationState,
} from "@dealora/db";

/**
 * @dealora/personalization — Personalization Engine (DEALORA_BLUEPRINT.md §15,
 * ROADMAP.md §16).
 *
 * Turns a qualified account into a concise, evidence-backed outreach **draft**.
 * The output is a document, never an action: nothing here sends, contacts,
 * approves or dispatches. Every factual statement a draft makes is quoted from
 * a stored record and carries its reference, and anything the system cannot
 * honestly state is recorded as a warning rather than invented.
 *
 * What this package is not, stated once so every consumer inherits it:
 *
 *   - it is **not** a model. Nothing here calls a language model or reads a
 *     prompt. The same inputs always produce the same draft byte for byte, and
 *     the renderer that produced it is named in every record
 *     (`rendererVersion`);
 *   - it **never paraphrases**. Rewriting a source's words is where fabrication
 *     creeps in, so a personalization point quotes the claim value verbatim and
 *     attributes it to its source;
 *   - it **creates no evidence and modifies none**. A draft reads what research
 *     and evidence already established, and re-drafting never rewrites a claim,
 *     an evidence record or a qualification;
 *   - it **has no recipient, channel or send state**. A draft carries a contact
 *     reference at most, never an address, never a provider, never a delivery
 *     result. Approval is Phase 10 and outbound is Phase 11.
 */

/** Domain error vocabulary, closed and safe to render. */
export type PersonalizationErrorCode =
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "UNAUTHORIZED"
  | "CONFLICT"
  | "UNAVAILABLE"
  /** The caller asked for a renderer this deployment does not implement. */
  | "UNSUPPORTED_RENDERER_VERSION";

export interface PersonalizationError {
  code: PersonalizationErrorCode;
  message: string;
  details?: { field: string; message: string }[];
}

export function personalizationError(
  code: PersonalizationErrorCode,
  message: string,
  details?: { field: string; message: string }[],
): PersonalizationError {
  return details ? { code, message, details } : { code, message };
}

export type {
  Account,
  AccountClaim,
  Claim,
  Contact,
  EntityId,
  Evidence,
  OfferStatus,
  PersonalizedDraft,
  QualificationState,
} from "@dealora/db";

/**
 * The qualification a draft is generated for, narrowed to what personalization
 * reads: that the account was qualified, and by which evaluation.
 *
 * A reference, never a copy. The draft does not restate a score or a
 * qualification state — those live on the qualification record — and the
 * service refuses to draft for an evaluation that is not `qualified`.
 */
export interface PersonalizationQualificationSnapshot {
  id: EntityId;
  workspaceId: EntityId;
  accountId: EntityId;
  state: QualificationState;
}

/**
 * Reads qualifications through the caller's own authorization.
 *
 * `latest` resolves the newest evaluation for an account; `byId` resolves one
 * named evaluation. Both return `null` rather than an error for a record that
 * does not exist or belongs to another workspace, so a foreign qualification is
 * never revealed to exist.
 */
export interface PersonalizationQualificationReader {
  latest: (
    workspaceId: EntityId,
    userId: EntityId,
    accountId: EntityId,
  ) => PersonalizationQualificationSnapshot | null;
  byId: (
    qualificationId: EntityId,
    userId: EntityId,
  ) => PersonalizationQualificationSnapshot | null;
}

/**
 * The offer a draft presents, narrowed to the fields the renderer may quote.
 *
 * `pricingApproved` is carried so the renderer can state nothing about price
 * unless the business approved it (DEALORA_BLUEPRINT.md §9): an unapproved
 * price is not silently included and not silently dropped — it is recorded as
 * a warning on the draft.
 */
export interface PersonalizationOfferSnapshot {
  id: EntityId;
  name: string;
  description: string;
  outcome: string | null;
  status: OfferStatus;
  pricingApproved: boolean;
}

/**
 * Reads offers through the caller's own authorization.
 *
 * `byId` returns `null` for a record that does not exist or belongs to another
 * workspace. `listActive` returns exactly the workspace's offers whose status
 * is `active`, because only an active offer may be presented externally.
 */
export interface PersonalizationOfferReader {
  byId: (offerId: EntityId, userId: EntityId) => PersonalizationOfferSnapshot | null;
  listActive: (workspaceId: EntityId, userId: EntityId) => PersonalizationOfferSnapshot[];
}

/**
 * The approved Business Brain claims a renderer may quote.
 *
 * Only Phase 2 claims whose status is `approved` — the business has cleared
 * this text for external use. An `unverified` claim is context, not quotable
 * text, and a `restricted` claim must never appear externally.
 */
export interface PersonalizationApprovedClaim {
  id: EntityId;
  text: string;
}

/**
 * Storage the Personalization domain depends on.
 *
 * Declared as an interface so the domain never touches the JSON store directly
 * and a different driver can replace it without editing a line of
 * personalization logic. Every read is the workspace's own; nothing here reads
 * a provider, a prompt or a model.
 */
export interface PersonalizationRepository {
  authorize(workspaceId: EntityId, userId: EntityId): Result<unknown, { code: string }>;

  /** Resolves through the caller's own authorization: a foreign account is not found. */
  getAccount(id: EntityId, userId: EntityId): Result<Account, { code: string }>;

  /** Resolves through the caller's own authorization: a foreign contact is not found. */
  getContact(id: EntityId, userId: EntityId): Result<Contact, { code: string }>;

  /** The account's claims, workspace-scoped. Every status is included. */
  listAccountClaims(
    workspaceId: EntityId,
    userId: EntityId,
    accountId: EntityId,
  ): Result<AccountClaim[], { code: string }>;

  /** The account's evidence, workspace-scoped. Every status is included. */
  listEvidence(
    workspaceId: EntityId,
    userId: EntityId,
    filter: { accountId: EntityId },
  ): Result<Evidence[], { code: string }>;

  /** The workspace's Phase 2 claims with status `approved`. */
  listApprovedClaims(workspaceId: EntityId, userId: EntityId): Result<Claim[], { code: string }>;

  createDraft(input: {
    workspaceId: EntityId;
    createdBy: EntityId;
    accountId: EntityId;
    draft: Omit<
      PersonalizedDraft,
      "id" | "workspaceId" | "accountId" | "createdBy" | "version" | "createdAt" | "updatedAt"
    >;
  }): Result<PersonalizedDraft, { code: string }>;
  getDraft(id: EntityId, userId: EntityId): Result<PersonalizedDraft, { code: string }>;
  listDrafts(
    workspaceId: EntityId,
    userId: EntityId,
    filter?: { accountId?: EntityId },
  ): Result<PersonalizedDraft[], { code: string }>;
}

/**
 * Injected clock.
 *
 * Only used to stamp `createdAt`. Rendering itself reads no clock: the subject,
 * the body, the points and the warnings are a pure function of the account, its
 * claims, its evidence, the qualification, the offer, the contact, the approved
 * claims and the renderer version.
 */
export type Clock = () => Date;
