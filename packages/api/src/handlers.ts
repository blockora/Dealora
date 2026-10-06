import type {
  BrandVoice,
  BusinessProfile,
  Claim,
  Icp,
  Offer,
  Persona,
  Positioning,
} from "@dealora/db";
import type { BrainError, BusinessBrainService } from "@dealora/brain";
import { GOAL_STATUSES } from "@dealora/goal";
import type { GoalError, RevenueGoalService } from "@dealora/goal";
import { PLAN_STATUSES } from "@dealora/plan";
import type { PlanBrainReader, PlanError, RevenuePlanService } from "@dealora/plan";
import { ACCOUNT_STATUSES, CONTACT_STATUSES } from "@dealora/account";
import type { AccountError, AccountService } from "@dealora/account";
import { RESEARCH_REQUEST_STATUSES } from "@dealora/research";
import type { ResearchError, ResearchService } from "@dealora/research";
import { ACCOUNT_CLAIM_STATUSES, EVIDENCE_STATUSES } from "@dealora/evidence";
import type { EvidenceError, EvidenceService } from "@dealora/evidence";
import { SUPPORTED_RULE_VERSIONS } from "@dealora/qualification";
import type { QualificationError, QualificationService } from "@dealora/qualification";
import { SUPPORTED_RENDERER_VERSIONS } from "@dealora/personalization";
import type { PersonalizationError, PersonalizationService } from "@dealora/personalization";
import { APPROVAL_STATUSES } from "@dealora/approval";
import type { ApprovalError, ApprovalService } from "@dealora/approval";
import type { OutboundError, OutboundService } from "@dealora/outbound";
import type { ConversationError, ConversationService } from "@dealora/conversation";
import type { MeetingError, MeetingService } from "@dealora/meeting";
import type { NextActionError, NextActionService } from "@dealora/nextaction";
import type { RevenueGraphError, RevenueGraphService } from "@dealora/revenuegraph";
import type { CostError, CostService } from "@dealora/cost";
import type { DashboardError, DashboardService } from "@dealora/dashboard";
import type { AgentError, AgentService } from "@dealora/agent";
import type { EvaluationError, EvaluationService } from "@dealora/evaluation";
import { TraceService, type TraceError } from "@dealora/trace";
import type { ExperimentError, ExperimentService } from "@dealora/experiment";
import type { RevenueGoalStatus as GoalStatus } from "@dealora/db";
import type { RevenuePlanStatus as PlanStatus } from "@dealora/db";
import type { AccountStatus, ContactStatus } from "@dealora/db";
import type { AccountClaimStatus, EvidenceStatus, ResearchRequestStatus } from "@dealora/db";

import type {
  ApiError,
  ApiErrorCode,
  ApiHandler,
  ApiResponse,
  AuthenticatedActor,
  BrainContextReader,
  IdentityService,
  RequestBody,
  SessionResolver,
  WorkspaceBrainContext,
} from "./types.js";
import type { Result } from "@dealora/core";

/**
 * Transport layer.
 *
 * Handlers do four things and nothing else:
 *   1. parse the request body,
 *   2. resolve the authenticated actor from the session token,
 *   3. call an application service,
 *   4. translate the result into an `ApiResponse`.
 *
 * Authorization is always performed inside the application service against the
 * server-side identity, so a handler can never grant access a client asked
 * for (ADR 0003).
 */

/** Translate a service/identity error code into the safe API vocabulary. */
function toApiError(code: string, message: string): ApiError {
  switch (code) {
    case "UNAUTHENTICATED":
      return { code: "UNAUTHENTICATED", message: "authentication required" };
    case "UNAUTHORIZED":
      return { code: "UNAUTHORIZED", message: "workspace access denied" };
    case "NOT_FOUND":
      return { code: "NOT_FOUND", message };
    case "VALIDATION_ERROR":
      return { code: "VALIDATION_ERROR", message };
    case "CONFLICT":
      return { code: "CONFLICT", message };
    default:
      // Never surface an internal storage message.
      return { code: "SERVER_ERROR", message: "unexpected failure" };
  }
}

/** Translate a domain `BrainError` into the safe API error envelope. */
function fromBrainError(error: BrainError): ApiError {
  // `UNAVAILABLE` is an internal condition and is never surfaced verbatim.
  if (error.code === "UNAVAILABLE") {
    return { code: "SERVER_ERROR", message: "unexpected failure" };
  }
  const mapped: ApiError = { code: error.code, message: error.message };
  if (error.details) mapped.details = error.details;
  return mapped;
}

/**
 * Translate a domain `GoalError` into the safe API error envelope.
 *
 * `INVALID_TRANSITION` surfaces as a CONFLICT because the caller's request
 * conflicts with the goal's current state; `UNAVAILABLE` is never exposed.
 */
function fromGoalError(error: GoalError): ApiError {
  if (error.code === "UNAVAILABLE") {
    return { code: "SERVER_ERROR", message: "unexpected failure" };
  }
  const code: ApiErrorCode = error.code === "INVALID_TRANSITION" ? "CONFLICT" : error.code;
  const mapped: ApiError = { code, message: error.message };
  if (error.details) mapped.details = error.details;
  return mapped;
}

/**
 * Translate a domain `PlanError` into the safe API error envelope.
 *
 * Same contract as {@link fromGoalError}: an illegal transition is a CONFLICT
 * and an internal condition is never surfaced verbatim.
 */
function fromPlanError(error: PlanError): ApiError {
  if (error.code === "UNAVAILABLE") {
    return { code: "SERVER_ERROR", message: "unexpected failure" };
  }
  const code: ApiErrorCode = error.code === "INVALID_TRANSITION" ? "CONFLICT" : error.code;
  const mapped: ApiError = { code, message: error.message };
  if (error.details) mapped.details = error.details;
  return mapped;
}

/**
 * Translate a domain `AccountError` into the safe API error envelope.
 *
 * `UNAVAILABLE` is an internal condition and is never surfaced verbatim: the
 * caller learns only that something unexpected happened.
 */
function fromAccountError(error: AccountError): ApiError {
  if (error.code === "UNAVAILABLE") {
    return { code: "SERVER_ERROR", message: "unexpected failure" };
  }
  const mapped: ApiError = { code: error.code, message: error.message };
  if (error.details) mapped.details = error.details;
  return mapped;
}

/**
 * Translate a domain `ResearchError` into the safe API error envelope.
 *
 * `UNAVAILABLE` is an internal condition and is never surfaced verbatim.
 * An `UNSUPPORTED_PROVIDER` is the caller's mistake rather than ours, so it
 * reads as a validation failure; an `INVALID_TRANSITION` conflicts with the
 * request's current state, exactly as the goal and plan layers do.
 */
function fromResearchError(error: ResearchError): ApiError {
  if (error.code === "UNAVAILABLE") {
    return { code: "SERVER_ERROR", message: "unexpected failure" };
  }
  const code: ApiErrorCode =
    error.code === "INVALID_TRANSITION"
      ? "CONFLICT"
      : error.code === "UNSUPPORTED_PROVIDER"
        ? "VALIDATION_ERROR"
        : error.code;
  const mapped: ApiError = { code, message: error.message };
  if (error.details) mapped.details = error.details;
  return mapped;
}

/**
 * Translate a domain `EvidenceError` into the safe API error envelope.
 *
 * `UNAVAILABLE` is an internal condition and is never surfaced verbatim. An
 * `UNSUPPORTED_SOURCE` is the caller's mistake rather than ours, so it reads as
 * a validation failure; an `INVALID_TRANSITION` conflicts with the record's
 * current state, exactly as the goal, plan and research layers do.
 */
function fromEvidenceError(error: EvidenceError): ApiError {
  if (error.code === "UNAVAILABLE") {
    return { code: "SERVER_ERROR", message: "unexpected failure" };
  }
  const code: ApiErrorCode =
    error.code === "INVALID_TRANSITION"
      ? "CONFLICT"
      : error.code === "UNSUPPORTED_SOURCE"
        ? "VALIDATION_ERROR"
        : error.code;
  const mapped: ApiError = { code, message: error.message };
  if (error.details) mapped.details = error.details;
  return mapped;
}

/**
 * Translate a domain `QualificationError` into the safe API error envelope.
 *
 * `UNAVAILABLE` is an internal condition and is never surfaced verbatim. An
 * `UNSUPPORTED_RULE_VERSION` is the caller's mistake rather than ours, so it
 * reads as a validation failure; an `INVALID_TRANSITION` conflicts with the
 * record's current state, exactly as the goal, plan and research layers do.
 */
function fromQualificationError(error: QualificationError): ApiError {
  if (error.code === "UNAVAILABLE") {
    return { code: "SERVER_ERROR", message: "unexpected failure" };
  }
  const code: ApiErrorCode =
    error.code === "UNSUPPORTED_RULE_VERSION" ? "VALIDATION_ERROR" : error.code;
  const mapped: ApiError = { code, message: error.message };
  if (error.details) mapped.details = error.details;
  return mapped;
}

/**
 * Translate a domain `PersonalizationError` into the safe API error envelope.
 *
 * `UNAVAILABLE` is an internal condition and is never surfaced verbatim. An
 * `UNSUPPORTED_RENDERER_VERSION` is the caller's mistake rather than ours, so
 * it reads as a validation failure, exactly as an unsupported rule version or
 * provider does in the layers before it.
 */
function fromPersonalizationError(error: PersonalizationError): ApiError {
  if (error.code === "UNAVAILABLE") {
    return { code: "SERVER_ERROR", message: "unexpected failure" };
  }
  const code: ApiErrorCode =
    error.code === "UNSUPPORTED_RENDERER_VERSION" ? "VALIDATION_ERROR" : error.code;
  const mapped: ApiError = { code, message: error.message };
  if (error.details) mapped.details = error.details;
  return mapped;
}

/**
 * Translate a domain `ApprovalError` into the safe API error envelope.
 *
 * The mapping is total and written out case by case, never asserted: a domain
 * code that this table did not list could not be given an `ApiErrorCode`, and
 * the cast that used to stand here would have emitted a code the transport
 * contract does not define.
 *
 * Four domain codes are all "this request is not decidable any more", and all
 * four map to `CONFLICT` — a deadline passed, the previewed text moved, a
 * request that was already decided, a request that was cancelled or expired.
 * They stay distinguishable to the caller through their messages and details,
 * which name the actual cause, because "you cannot decide this any more" and
 * "the text you were shown has changed" call for different fixes.
 *
 * `UNAVAILABLE` is an internal condition and is never surfaced verbatim.
 */
function fromApprovalError(error: ApprovalError): ApiError {
  const code: ApiErrorCode = ((): ApiErrorCode => {
    switch (error.code) {
      case "NOT_FOUND":
        return "NOT_FOUND";
      case "UNAUTHORIZED":
        return "UNAUTHORIZED";
      case "VALIDATION_ERROR":
        return "VALIDATION_ERROR";
      case "CONFLICT":
      case "EXPIRED":
      case "PREVIEW_MISMATCH":
      case "INVALID_TRANSITION":
        return "CONFLICT";
      case "UNAVAILABLE":
        return "SERVER_ERROR";
    }
  })();
  const message = error.code === "UNAVAILABLE" ? "unexpected failure" : error.message;
  const mapped: ApiError = { code, message };
  if (error.details) mapped.details = error.details;
  return mapped;
}

/** Parse a JSON body, tolerating already-parsed objects. */
async function parseBody(req: RequestBody): Promise<Record<string, unknown> | ApiError> {
  const raw = req.body;
  if (raw === undefined || raw === null) return {};
  if (typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw !== "string") return { code: "VALIDATION_ERROR", message: "invalid JSON body" };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") {
      return { code: "VALIDATION_ERROR", message: "invalid JSON body" };
    }
    return parsed as Record<string, unknown>;
  } catch {
    return { code: "VALIDATION_ERROR", message: "invalid JSON body" };
  }
}

function isApiError(value: unknown): value is ApiError {
  return typeof value === "object" && value !== null && "code" in value && "message" in value;
}

/**
 * Translate a domain `OutboundError` into the safe API error envelope.
 *
 * Written case by case rather than asserted, so no domain code can be emitted
 * over the wire as a code the transport contract does not define. `ApiErrorCode`
 * is the Phase 1 vocabulary and stays closed; the five refusals that have no code
 * of their own there — no approval, a suppression, an unconfigured provider, a
 * provider refusal and an internal failure — all become `CONFLICT` except the
 * last, which becomes `SERVER_ERROR`.
 *
 * They stay distinguishable to the caller through their messages and details,
 * and that distinction matters: "a human has not approved this" and "this person
 * must not be contacted" call for completely different actions, and collapsing
 * them into one opaque conflict would make the second look like an ordinary
 * retry. The details name the actual cause in every case.
 *
 * `UNAVAILABLE` is an internal condition and is never surfaced verbatim.
 */
function fromOutboundError(error: OutboundError): ApiError {
  const code: ApiErrorCode = ((): ApiErrorCode => {
    switch (error.code) {
      case "NOT_FOUND":
        return "NOT_FOUND";
      case "UNAUTHORIZED":
        return "UNAUTHORIZED";
      case "VALIDATION_ERROR":
        return "VALIDATION_ERROR";
      case "CONFLICT":
        return "CONFLICT";
      case "UNAPPROVED":
      case "SUPPRESSED":
      case "PROVIDER_UNAVAILABLE":
      case "PROVIDER_FAILED":
        return "CONFLICT";
      case "UNAVAILABLE":
        return "SERVER_ERROR";
    }
  })();
  const message = error.code === "UNAVAILABLE" ? "unexpected failure" : error.message;
  const mapped: ApiError = { code, message };
  if (error.details) mapped.details = [...error.details];
  return mapped;
}

/**
 * Translate a domain `ConversationError` into the safe API error envelope.
 *
 * Written as an exhaustive switch, with no cast, so the `ApiErrorCode`
 * annotation is a real guarantee: TypeScript accepts the function only while
 * every member of the domain's error union has a case, which is what stops a new
 * domain code from reaching the wire as something the transport contract does not
 * define. (`fromOutboundError` above needed an IIFE for exactly that reason.)
 *
 * `UNSUPPORTED_CLASSIFIER_VERSION` becomes `VALIDATION_ERROR`, because a caller
 * naming a rule set this deployment does not implement has sent a bad request —
 * which is a different situation from a conflict, and retrying will not help.
 *
 * `UNAVAILABLE` is an internal condition and is never surfaced verbatim.
 */
function fromConversationError(error: ConversationError): ApiError {
  const code: ApiErrorCode = ((): ApiErrorCode => {
    switch (error.code) {
      case "NOT_FOUND":
        return "NOT_FOUND";
      case "UNAUTHORIZED":
        return "UNAUTHORIZED";
      case "VALIDATION_ERROR":
      case "UNSUPPORTED_CLASSIFIER_VERSION":
        return "VALIDATION_ERROR";
      case "CONFLICT":
        return "CONFLICT";
      case "UNAVAILABLE":
        return "SERVER_ERROR";
    }
  })();
  const message = error.code === "UNAVAILABLE" ? "unexpected failure" : error.message;
  const mapped: ApiError = { code, message };
  if (error.details) mapped.details = [...error.details];
  return mapped;
}

/**
 * Translate a domain `MeetingError` into the safe API error envelope.
 *
 * Written as an exhaustive switch, with no cast, so the `ApiErrorCode`
 * annotation is a real guarantee: TypeScript accepts the function only while
 * every member of the domain's error union has a case, which is what stops a new
 * domain code from reaching the wire as something the transport contract does not
 * define.
 *
 * The two domain codes that are not a plain mapping both become `CONFLICT`:
 * a booking that changed after it was proposed, and a booking whose state moved
 * on. Both are real-world conflicts a caller can re-read and retry deliberately —
 * not bad requests, and not something that a blind retry would fix.
 *
 * `UNAVAILABLE` is an internal condition and is never surfaced verbatim.
 */
function fromMeetingError(error: MeetingError): ApiError {
  const code: ApiErrorCode = ((): ApiErrorCode => {
    switch (error.code) {
      case "NOT_FOUND":
        return "NOT_FOUND";
      case "UNAUTHORIZED":
        return "UNAUTHORIZED";
      case "VALIDATION_ERROR":
        return "VALIDATION_ERROR";
      case "SUPPRESSED":
      case "PREREQUISITE_NOT_MET":
      case "INVALID_TRANSITION":
      case "CONFLICT":
        return "CONFLICT";
      case "UNAVAILABLE":
        return "SERVER_ERROR";
    }
  })();
  const message = error.code === "UNAVAILABLE" ? "unexpected failure" : error.message;
  const mapped: ApiError = { code, message };
  if (error.details) mapped.details = [...error.details];
  return mapped;
}

/**
 * Translate a domain `NextActionError` into the safe API error envelope.
 *
 * Written as an exhaustive switch, with no cast, so the `ApiErrorCode` annotation
 * is a real guarantee: TypeScript accepts the function only while every member of
 * the domain's error union has a case, which is what stops a new domain code from
 * reaching the wire as something the transport contract does not define.
 *
 * `UNAVAILABLE` is an internal condition — storage refusing a write because the
 * recommendation contradicted itself — and is never surfaced verbatim.
 */
function fromNextActionError(error: NextActionError): ApiError {
  const code: ApiErrorCode = ((): ApiErrorCode => {
    switch (error.code) {
      case "NOT_FOUND":
        return "NOT_FOUND";
      case "UNAUTHORIZED":
        return "UNAUTHORIZED";
      case "VALIDATION_ERROR":
        return "VALIDATION_ERROR";
      case "UNAVAILABLE":
        return "SERVER_ERROR";
    }
  })();
  const message = error.code === "UNAVAILABLE" ? "unexpected failure" : error.message;
  const mapped: ApiError = { code, message };
  if (error.details) mapped.details = [...error.details];
  return mapped;
}

/**
 * Translate a domain `RevenueGraphError` into the safe API error envelope.
 *
 * Exhaustive with no cast, like every other mapper here: TypeScript accepts
 * this function only while every member of the domain's error union has a
 * case, so a new domain code cannot reach the wire as something the transport
 * contract does not define. `UNAVAILABLE` is internal (a store row disagreeing
 * with its own vocabulary) and is never surfaced verbatim.
 */
function fromRevenueGraphError(error: RevenueGraphError): ApiError {
  const code: ApiErrorCode = ((): ApiErrorCode => {
    switch (error.code) {
      case "NOT_FOUND":
        return "NOT_FOUND";
      case "UNAUTHORIZED":
        return "UNAUTHORIZED";
      case "VALIDATION_ERROR":
        return "VALIDATION_ERROR";
      case "UNAVAILABLE":
        return "SERVER_ERROR";
    }
  })();
  const message = error.code === "UNAVAILABLE" ? "unexpected failure" : error.message;
  const mapped: ApiError = { code, message };
  if (error.details) mapped.details = [...error.details];
  return mapped;
}

/**
 * Translate a domain `CostError` into the safe API error envelope.
 *
 * Exhaustive with no cast, like every other mapper here: TypeScript accepts
 * this function only while every member of the domain's error union has a
 * case. A replayed key is a CONFLICT the caller can retry differently;
 * `UNAVAILABLE` (an aggregate that could not be derived) is internal and is
 * never surfaced verbatim.
 */
function fromCostError(error: CostError): ApiError {
  const code: ApiErrorCode = ((): ApiErrorCode => {
    switch (error.code) {
      case "NOT_FOUND":
        return "NOT_FOUND";
      case "UNAUTHORIZED":
        return "UNAUTHORIZED";
      case "VALIDATION_ERROR":
        return "VALIDATION_ERROR";
      case "CONFLICT":
        return "CONFLICT";
      case "UNAVAILABLE":
        return "SERVER_ERROR";
    }
  })();
  const message = error.code === "UNAVAILABLE" ? "unexpected failure" : error.message;
  const mapped: ApiError = { code, message };
  if (error.details) mapped.details = [...error.details];
  return mapped;
}

/**
 * Map an experiment domain error onto the transport vocabulary.
 *
 * The mapping is exhaustive over the domain's closed error codes, and the
 * internal `UNAVAILABLE` is reported generically, so a storage failure never
 * leaks its message to a caller — the same rule every phase's mapping follows.
 */
function fromExperimentError(error: ExperimentError): ApiError {
  const code: ApiErrorCode = ((): ApiErrorCode => {
    switch (error.code) {
      case "NOT_FOUND":
        return "NOT_FOUND";
      case "UNAUTHORIZED":
        return "UNAUTHORIZED";
      case "VALIDATION_ERROR":
        return "VALIDATION_ERROR";
      case "CONFLICT":
        return "CONFLICT";
      case "UNAVAILABLE":
        return "SERVER_ERROR";
    }
  })();
  const message = error.code === "UNAVAILABLE" ? "unexpected failure" : error.message;
  const mapped: ApiError = { code, message };
  if (error.details) mapped.details = [...error.details];
  return mapped;
}

/**
 * Map a dashboard domain error onto the transport vocabulary. The mapping is
 * exhaustive: `UNAVAILABLE` — the only code that means an internal condition —
 * becomes a generic `SERVER_ERROR`, so storage internals never reach a client.
 */
function fromDashboardError(error: DashboardError): ApiError {
  const code: ApiErrorCode = ((): ApiErrorCode => {
    switch (error.code) {
      case "NOT_FOUND":
        return "NOT_FOUND";
      case "UNAUTHORIZED":
        return "UNAUTHORIZED";
      case "VALIDATION_ERROR":
        return "VALIDATION_ERROR";
      case "UNAVAILABLE":
        return "SERVER_ERROR";
    }
  })();
  const message = error.code === "UNAVAILABLE" ? "unexpected failure" : error.message;
  const mapped: ApiError = { code, message };
  if (error.details) mapped.details = [...error.details];
  return mapped;
}

/**
 * Map an agent-registry domain error onto the transport vocabulary.
 *
 * Exhaustive, like every other mapper here. `UNAVAILABLE` — the only code that
 * means an internal condition — becomes a generic `SERVER_ERROR`, so storage
 * internals never reach a client. `CONFLICT` keeps its meaning: a lifecycle
 * transition the table does not publish is a conflict with the current state,
 * not a bad request.
 */
function fromAgentError(error: AgentError): ApiError {
  const code: ApiErrorCode = ((): ApiErrorCode => {
    switch (error.code) {
      case "NOT_FOUND":
        return "NOT_FOUND";
      case "UNAUTHORIZED":
        return "UNAUTHORIZED";
      case "VALIDATION_ERROR":
        return "VALIDATION_ERROR";
      case "CONFLICT":
        return "CONFLICT";
      case "UNAVAILABLE":
        return "SERVER_ERROR";
    }
  })();
  const message = error.code === "UNAVAILABLE" ? "unexpected failure" : error.message;
  const mapped: ApiError = { code, message };
  if (error.details) mapped.details = [...error.details];
  return mapped;
}

/**
 * Map an evaluation domain error onto the transport vocabulary.
 *
 * Exhaustive, like every other mapper here. `UNAVAILABLE` — the only code that
 * means an internal condition — becomes a generic `SERVER_ERROR`, so storage
 * internals never reach a client. `CONFLICT` keeps its meaning: a replayed
 * judgement of the same subject with a different value, or a judgement offered
 * before a round exists, is a conflict with recorded state rather than a
 * malformed request.
 */
function fromEvaluationError(error: EvaluationError): ApiError {
  const code: ApiErrorCode = ((): ApiErrorCode => {
    switch (error.code) {
      case "NOT_FOUND":
        return "NOT_FOUND";
      case "UNAUTHORIZED":
        return "UNAUTHORIZED";
      case "VALIDATION_ERROR":
        return "VALIDATION_ERROR";
      case "CONFLICT":
        return "CONFLICT";
      case "UNAVAILABLE":
        return "SERVER_ERROR";
    }
  })();
  const message = error.code === "UNAVAILABLE" ? "unexpected failure" : error.message;
  const mapped: ApiError = { code, message };
  if (error.details) mapped.details = [...error.details];
  return mapped;
}

/**
 * Map a trace domain error onto the transport vocabulary.
 *
 * Exhaustive, like every other mapper here. `UNAVAILABLE` becomes a generic
 * `SERVER_ERROR`, so storage internals never reach a client — including the
 * cross-check that refuses to report a run whose stored status disagrees with
 * its recorded outcomes, which is deliberately opaque: saying more would tell a
 * caller which internal invariant tripped.
 *
 * `CONFLICT` is the code that matters most here, because it is what carries
 * `ROADMAP.md` §27's critical rule to the wire: recording a step on a closed
 * run, replaying an attempt with different content, and opening a run for an
 * agent that is not in `production` all surface as a conflict with recorded
 * state. None of them is a malformed request, and none can be turned into a
 * success by retrying differently.
 */
function fromTraceError(error: TraceError): ApiError {
  const code: ApiErrorCode = ((): ApiErrorCode => {
    switch (error.code) {
      case "NOT_FOUND":
        return "NOT_FOUND";
      case "UNAUTHORIZED":
        return "UNAUTHORIZED";
      case "VALIDATION_ERROR":
        return "VALIDATION_ERROR";
      case "CONFLICT":
        return "CONFLICT";
      case "UNAVAILABLE":
        return "SERVER_ERROR";
    }
  })();
  const message = error.code === "UNAVAILABLE" ? "unexpected failure" : error.message;
  const mapped: ApiError = { code, message };
  if (error.details) mapped.details = [...error.details];
  return mapped;
}

export interface HandlerDeps {
  identity: IdentityService;
  brain: BusinessBrainService;
  goal: RevenueGoalService;
  brainContext: BrainContextReader;
  plan: RevenuePlanService;
  planContext: PlanBrainReader;
  account: AccountService;
  research: ResearchService;
  evidence: EvidenceService;
  qualification: QualificationService;
  personalization: PersonalizationService;
  approval: ApprovalService;
  outbound: OutboundService;
  conversation: ConversationService;
  meeting: MeetingService;
  nextaction: NextActionService;
  revenuegraph: RevenueGraphService;
  cost: CostService;
  dashboard: DashboardService;
  agent: AgentService;
  evaluation: EvaluationService;
  trace: TraceService;
  experiment: ExperimentService;
  resolveSession: SessionResolver;
}

/**
 * Resolve the authenticated actor from the bearer token.
 *
 * The user id always comes from the session. A `workspaceId` in the body or
 * query is never treated as proof of access — the application service
 * re-authorizes every call against this identity.
 */
function actorFrom(req: RequestBody, deps: HandlerDeps): AuthenticatedActor | null {
  const token = req.query.sessionToken;
  if (typeof token !== "string" || token === "") return null;
  return deps.resolveSession(token);
}

function ok<T>(data: T): ApiResponse<T> {
  return { status: "ok", data };
}

/** Wrap a handler body that requires an authenticated actor. */
function authenticated<T>(
  req: RequestBody,
  deps: HandlerDeps,
  run: (actor: AuthenticatedActor) => Promise<Result<ApiResponse<T>, ApiError>>,
): Promise<Result<ApiResponse<T>, ApiError>> {
  const actor = actorFrom(req, deps);
  if (!actor) {
    return Promise.resolve({
      ok: false,
      error: { code: "UNAUTHENTICATED", message: "authentication required" },
    });
  }
  return run(actor).catch((err: unknown) => ({
    ok: false,
    error: toApiError(
      typeof err === "object" && err !== null && "code" in err
        ? String((err as { code: unknown }).code)
        : "SERVER_ERROR",
      "unexpected failure",
    ),
  }));
}

/** Read a required route parameter. */
function param(req: RequestBody, name: string): string | ApiError {
  const value = req.params[name];
  if (typeof value !== "string" || value.trim() === "") {
    return { code: "VALIDATION_ERROR", message: `${name} is required` };
  }
  return value;
}

// ---------------------------------------------------------------------------
// Phase 1 — identity and workspaces
// ---------------------------------------------------------------------------

export function createHandlers(deps: HandlerDeps) {
  const signupHandler: ApiHandler = async (req) => {
    const body = await parseBody(req);
    if (isApiError(body)) return { ok: false, error: body };

    const email = typeof body.email === "string" ? body.email : "";
    const password = typeof body.password === "string" ? body.password : "";
    const displayName = typeof body.displayName === "string" ? body.displayName : "";
    if (!email || !password || !displayName) {
      return {
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "email, password and displayName are required",
        },
      };
    }
    try {
      const created = deps.identity.signup(email, password, displayName);
      return { ok: true, value: ok({ user: publicUser(created.user), token: created.token }) };
    } catch (err: unknown) {
      const code =
        typeof err === "object" && err !== null && "code" in err
          ? String((err as { code: unknown }).code)
          : "SERVER_ERROR";
      return { ok: false, error: toApiError(code, "signup failed") };
    }
  };

  const authenticateHandler: ApiHandler = async (req) => {
    const body = await parseBody(req);
    if (isApiError(body)) return { ok: false, error: body };

    const email = typeof body.email === "string" ? body.email : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!email || !password) {
      return {
        ok: false,
        error: { code: "VALIDATION_ERROR", message: "email and password are required" },
      };
    }
    try {
      const found = deps.identity.authenticate(email, password);
      return { ok: true, value: ok({ user: publicUser(found.user), token: found.token }) };
    } catch (err: unknown) {
      const code =
        typeof err === "object" && err !== null && "code" in err
          ? String((err as { code: unknown }).code)
          : "SERVER_ERROR";
      return { ok: false, error: toApiError(code, "invalid credentials") };
    }
  };

  const listWorkspacesHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const result = deps.identity.listWorkspaces(actor.userId);
      if (!result.ok) {
        return Promise.resolve({
          ok: false,
          error: toApiError(result.error.code, "workspaces unavailable"),
        });
      }
      return Promise.resolve({ ok: true, value: ok({ workspaces: result.value }) });
    });

  const getWorkspaceHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const id = param(req, "id");
      if (isApiError(id)) return Promise.resolve({ ok: false, error: id });
      const result = deps.identity.getWorkspace(id, actor.userId);
      if (!result.ok) {
        return Promise.resolve({
          ok: false,
          error: toApiError(result.error.code, "workspace not found"),
        });
      }
      return Promise.resolve({ ok: true, value: ok({ workspace: result.value }) });
    });

  const updateWorkspaceHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const id = param(req, "id");
      if (isApiError(id)) return { ok: false, error: id };
      const body = await parseBody(req);
      if (isApiError(body)) return { ok: false, error: body };

      const input: { name?: string; timezone?: string } = {};
      if (typeof body.name === "string" && body.name.trim() !== "") input.name = body.name.trim();
      if (typeof body.timezone === "string" && body.timezone.trim() !== "")
        input.timezone = body.timezone.trim();

      const result = deps.identity.updateWorkspace(id, actor.userId, input);
      if (!result.ok) {
        return { ok: false, error: toApiError(result.error.code, "workspace not found") };
      }
      return { ok: true, value: ok({ workspace: result.value }) };
    });

  const meHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const result = deps.identity.getUser(actor.userId);
      if (!result.ok) {
        return Promise.resolve({
          ok: false,
          error: toApiError(result.error.code, "user not found"),
        });
      }
      return Promise.resolve({ ok: true, value: ok({ user: publicUser(result.value) }) });
    });

  // -------------------------------------------------------------------------
  // Phase 2 — Business Brain
  //
  // The workspace id always comes from the route; the acting user always comes
  // from the session. The service authorizes that pair server-side, so a
  // handler never decides access itself.
  // -------------------------------------------------------------------------

  /** Company section (Phase 1 business profile, canonical for the Brain). */
  const getCompanyHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return Promise.resolve({ ok: false, error: workspaceId });
      const result = deps.brain.getCompany(workspaceId, actor.userId);
      if (!result.ok) {
        return Promise.resolve({ ok: false, error: fromBrainError(result.error) });
      }
      return Promise.resolve({ ok: true, value: ok({ company: result.value }) });
    });

  const upsertCompanyHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };
      const body = await parseBody(req);
      if (isApiError(body)) return { ok: false, error: body };
      const result = deps.brain.upsertCompany(workspaceId, actor.userId, body);
      if (!result.ok) return { ok: false, error: fromBrainError(result.error) };
      return { ok: true, value: ok({ company: result.value }) };
    });

  const createOfferHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };
      const body = await parseBody(req);
      if (isApiError(body)) return { ok: false, error: body };
      const result = deps.brain.createOffer(workspaceId, actor.userId, body);
      if (!result.ok) return { ok: false, error: fromBrainError(result.error) };
      return { ok: true, value: ok({ offer: result.value }) };
    });

  const listOffersHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return Promise.resolve({ ok: false, error: workspaceId });
      const result = deps.brain.listOffers(workspaceId, actor.userId);
      if (!result.ok) return Promise.resolve({ ok: false, error: fromBrainError(result.error) });
      return Promise.resolve({ ok: true, value: ok({ offers: result.value }) });
    });

  const updateOfferHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const body = await parseBody(req);
      if (isApiError(body)) return { ok: false, error: body };
      const id = param(req, "id");
      if (isApiError(id)) return { ok: false, error: id };
      const result = deps.brain.updateOffer(id, actor.userId, body);
      if (!result.ok) return { ok: false, error: fromBrainError(result.error) };
      return { ok: true, value: ok({ offer: result.value }) };
    });

  const deleteOfferHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const id = param(req, "id");
      if (isApiError(id)) return Promise.resolve({ ok: false, error: id });
      const result = deps.brain.deleteOffer(id, actor.userId);
      if (!result.ok) return Promise.resolve({ ok: false, error: fromBrainError(result.error) });
      return Promise.resolve({ ok: true, value: ok({ deleted: true }) });
    });

  const upsertIcpHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };
      const body = await parseBody(req);
      if (isApiError(body)) return { ok: false, error: body };
      const result = deps.brain.upsertIcp(workspaceId, actor.userId, body);
      if (!result.ok) return { ok: false, error: fromBrainError(result.error) };
      return { ok: true, value: ok({ icp: result.value }) };
    });

  const getIcpHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return Promise.resolve({ ok: false, error: workspaceId });
      const result = deps.brain.getIcp(workspaceId, actor.userId);
      if (!result.ok) return Promise.resolve({ ok: false, error: fromBrainError(result.error) });
      return Promise.resolve({ ok: true, value: ok({ icp: result.value }) });
    });

  const createPersonaHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };
      const body = await parseBody(req);
      if (isApiError(body)) return { ok: false, error: body };
      const result = deps.brain.createPersona(workspaceId, actor.userId, body);
      if (!result.ok) return { ok: false, error: fromBrainError(result.error) };
      return { ok: true, value: ok({ persona: result.value }) };
    });

  const listPersonasHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return Promise.resolve({ ok: false, error: workspaceId });
      const result = deps.brain.listPersonas(workspaceId, actor.userId);
      if (!result.ok) return Promise.resolve({ ok: false, error: fromBrainError(result.error) });
      return Promise.resolve({ ok: true, value: ok({ personas: result.value }) });
    });

  const upsertPositioningHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };
      const body = await parseBody(req);
      if (isApiError(body)) return { ok: false, error: body };
      const result = deps.brain.upsertPositioning(workspaceId, actor.userId, body);
      if (!result.ok) return { ok: false, error: fromBrainError(result.error) };
      return { ok: true, value: ok({ positioning: result.value }) };
    });

  const getPositioningHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return Promise.resolve({ ok: false, error: workspaceId });
      const result = deps.brain.getPositioning(workspaceId, actor.userId);
      if (!result.ok) return Promise.resolve({ ok: false, error: fromBrainError(result.error) });
      return Promise.resolve({ ok: true, value: ok({ positioning: result.value }) });
    });

  const upsertBrandVoiceHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };
      const body = await parseBody(req);
      if (isApiError(body)) return { ok: false, error: body };
      const result = deps.brain.upsertBrandVoice(workspaceId, actor.userId, body);
      if (!result.ok) return { ok: false, error: fromBrainError(result.error) };
      return { ok: true, value: ok({ brandVoice: result.value }) };
    });

  const getBrandVoiceHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return Promise.resolve({ ok: false, error: workspaceId });
      const result = deps.brain.getBrandVoice(workspaceId, actor.userId);
      if (!result.ok) return Promise.resolve({ ok: false, error: fromBrainError(result.error) });
      return Promise.resolve({ ok: true, value: ok({ brandVoice: result.value }) });
    });

  const createClaimHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };
      const body = await parseBody(req);
      if (isApiError(body)) return { ok: false, error: body };
      const result = deps.brain.createClaim(workspaceId, actor.userId, body);
      if (!result.ok) return { ok: false, error: fromBrainError(result.error) };
      return { ok: true, value: ok({ claim: result.value }) };
    });

  const listClaimsHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return Promise.resolve({ ok: false, error: workspaceId });
      const rawStatus = req.query.status;
      let status: "approved" | "unverified" | "restricted" | undefined;
      if (typeof rawStatus === "string" && rawStatus !== "") {
        if (!["approved", "unverified", "restricted"].includes(rawStatus)) {
          return Promise.resolve({
            ok: false,
            error: { code: "VALIDATION_ERROR", message: "invalid status filter" } as ApiError,
          });
        }
        status = rawStatus as "approved" | "unverified" | "restricted";
      }
      const result = deps.brain.listClaims(
        workspaceId,
        actor.userId,
        status ? { status } : undefined,
      );
      if (!result.ok) return Promise.resolve({ ok: false, error: fromBrainError(result.error) });
      return Promise.resolve({ ok: true, value: ok({ claims: result.value }) });
    });

  const approveClaimHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const id = param(req, "id");
      if (isApiError(id)) return Promise.resolve({ ok: false, error: id });
      const result = deps.brain.approveClaim(id, actor.userId);
      if (!result.ok) return Promise.resolve({ ok: false, error: fromBrainError(result.error) });
      return Promise.resolve({ ok: true, value: ok({ claim: result.value }) });
    });

  const updateClaimHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const body = await parseBody(req);
      if (isApiError(body)) return { ok: false, error: body };
      const id = param(req, "id");
      if (isApiError(id)) return { ok: false, error: id };
      const result = deps.brain.updateClaim(id, actor.userId, body);
      if (!result.ok) return { ok: false, error: fromBrainError(result.error) };
      return { ok: true, value: ok({ claim: result.value }) };
    });

  // -------------------------------------------------------------------------
  // Phase 3 — Revenue Goal Engine
  //
  // Handlers stay translation-only: the workspace id comes from the route, the
  // acting user from the session, and every rule (validation, reference
  // checking, lifecycle) is enforced by the goal service.
  // -------------------------------------------------------------------------

  /**
   * Read the canonical workspace context used for goal references.
   *
   * Authorization runs first, against the session identity, so a caller from
   * another tenant is denied with `UNAUTHORIZED` rather than being reported as
   * an internal failure when the reader refuses the read.
   */
  async function workspaceContext(
    workspaceId: string,
    userId: string,
  ): Promise<WorkspaceBrainContext | ApiError> {
    const auth = deps.identity.authorize(workspaceId, userId);
    if (!auth.ok) return toApiError(auth.error.code, "workspace not found");
    try {
      return await deps.brainContext(workspaceId, userId);
    } catch {
      return { code: "SERVER_ERROR", message: "unexpected failure" };
    }
  }

  const createRevenueGoalHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };
      const body = await parseBody(req);
      if (isApiError(body)) return { ok: false, error: body };
      const context = await workspaceContext(workspaceId, actor.userId);
      if (isApiError(context)) return { ok: false, error: context };

      const result = deps.goal.createRevenueGoal(workspaceId, actor.userId, body, context);
      if (!result.ok) return { ok: false, error: fromGoalError(result.error) };
      return { ok: true, value: ok({ goal: result.value }) };
    });

  const listRevenueGoalsHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return Promise.resolve({ ok: false, error: workspaceId });
      const rawStatus = req.query.status;
      let status: GoalStatus | undefined;
      if (typeof rawStatus === "string" && rawStatus !== "") {
        if (!GOAL_STATUSES.includes(rawStatus as GoalStatus)) {
          return Promise.resolve({
            ok: false,
            error: { code: "VALIDATION_ERROR", message: "invalid status filter" },
          });
        }
        status = rawStatus as GoalStatus;
      }
      const result = deps.goal.listRevenueGoals(
        workspaceId,
        actor.userId,
        status ? { status } : undefined,
      );
      if (!result.ok) return Promise.resolve({ ok: false, error: fromGoalError(result.error) });
      return Promise.resolve({ ok: true, value: ok({ goals: result.value }) });
    });

  const getRevenueGoalHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const id = param(req, "id");
      if (isApiError(id)) return Promise.resolve({ ok: false, error: id });
      const result = deps.goal.getRevenueGoal(id, actor.userId);
      if (!result.ok) return Promise.resolve({ ok: false, error: fromGoalError(result.error) });
      return Promise.resolve({ ok: true, value: ok({ goal: result.value }) });
    });

  const updateRevenueGoalHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const id = param(req, "id");
      if (isApiError(id)) return { ok: false, error: id };
      const body = await parseBody(req);
      if (isApiError(body)) return { ok: false, error: body };
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };
      const context = await workspaceContext(workspaceId, actor.userId);
      if (isApiError(context)) return { ok: false, error: context };

      // Status is never accepted through a field update: it has its own
      // transition-validated route.
      const { status: _status, ...patch } = body as Record<string, unknown> & { status?: unknown };
      void _status;

      const result = deps.goal.updateRevenueGoal(id, actor.userId, patch, context);
      if (!result.ok) return { ok: false, error: fromGoalError(result.error) };
      return { ok: true, value: ok({ goal: result.value }) };
    });

  const changeRevenueGoalStatusHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const id = param(req, "id");
      if (isApiError(id)) return { ok: false, error: id };
      const body = await parseBody(req);
      if (isApiError(body)) return { ok: false, error: body };
      const result = deps.goal.changeRevenueGoalStatus(id, actor.userId, body.status);
      if (!result.ok) return { ok: false, error: fromGoalError(result.error) };
      return { ok: true, value: ok({ goal: result.value }) };
    });

  const archiveRevenueGoalHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const id = param(req, "id");
      if (isApiError(id)) return Promise.resolve({ ok: false, error: id });
      const result = deps.goal.archiveRevenueGoal(id, actor.userId);
      if (!result.ok) return Promise.resolve({ ok: false, error: fromGoalError(result.error) });
      return Promise.resolve({ ok: true, value: ok({ goal: result.value }) });
    });

  const revenueGoalHistoryHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const id = param(req, "id");
      if (isApiError(id)) return Promise.resolve({ ok: false, error: id });
      const result = deps.goal.goalHistory(id, actor.userId);
      if (!result.ok) return Promise.resolve({ ok: false, error: fromGoalError(result.error) });
      return Promise.resolve({ ok: true, value: ok({ history: result.value }) });
    });

  /**
   * Parse a natural-language goal without persisting anything.
   *
   * The response includes the provenance of every field so a caller can see
   * what was stated, what was inferred, and what is still unknown.
   */
  const parseRevenueGoalInputHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };
      const body = await parseBody(req);
      if (isApiError(body)) return { ok: false, error: body };
      const context = await workspaceContext(workspaceId, actor.userId);
      if (isApiError(context)) return { ok: false, error: context };

      const input = typeof body.input === "string" ? body.input : "";
      // The reference instant is injected so parsing is deterministic.
      const now = new Date();
      const result = deps.goal.parseRevenueGoalInput(input, context, now);
      if (!result.ok) return { ok: false, error: fromGoalError(result.error) };
      return { ok: true, value: ok({ draft: result.value }) };
    });

  /** Create a goal directly from natural language. */
  const createRevenueGoalFromTextHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };
      const body = await parseBody(req);
      if (isApiError(body)) return { ok: false, error: body };
      const context = await workspaceContext(workspaceId, actor.userId);
      if (isApiError(context)) return { ok: false, error: context };

      const input = typeof body.input === "string" ? body.input : "";
      const now = new Date();
      const result = deps.goal.createFromNaturalLanguage(
        workspaceId,
        actor.userId,
        input,
        context,
        now,
      );
      if (!result.ok) return { ok: false, error: fromGoalError(result.error) };
      return { ok: true, value: ok({ goal: result.value }) };
    });

  // -------------------------------------------------------------------------
  // Phase 4 — Revenue Plan Compiler
  //
  // Compilation produces a proposal only. No handler here performs, schedules
  // or records an external action of any kind.
  // -------------------------------------------------------------------------

  /**
   * Compile a RevenueGoal into a new RevenuePlan version.
   *
   * The workspace is authorized here before the compiler runs, so a caller
   * from another tenant is denied rather than being allowed to compile against
   * a goal they cannot read.
   */
  const compileRevenuePlanHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };
      const auth = deps.identity.authorize(workspaceId, actor.userId);
      if (!auth.ok) return { ok: false, error: toApiError(auth.error.code, "workspace not found") };

      const body = await parseBody(req);
      if (isApiError(body)) return { ok: false, error: body };
      const revenueGoalId = body.revenueGoalId;

      const result = deps.plan.compileRevenuePlan(workspaceId, actor.userId, revenueGoalId);
      if (!result.ok) return { ok: false, error: fromPlanError(result.error) };
      return { ok: true, value: ok({ plan: result.value }) };
    });

  const listRevenuePlansHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return Promise.resolve({ ok: false, error: workspaceId });
      const rawStatus = req.query.status;
      let status: PlanStatus | undefined;
      if (typeof rawStatus === "string" && rawStatus !== "") {
        if (!PLAN_STATUSES.includes(rawStatus as PlanStatus)) {
          return Promise.resolve({
            ok: false,
            error: { code: "VALIDATION_ERROR", message: "invalid status filter" },
          });
        }
        status = rawStatus as PlanStatus;
      }
      const revenueGoalId =
        typeof req.query.revenueGoalId === "string" && req.query.revenueGoalId !== ""
          ? req.query.revenueGoalId
          : undefined;

      const result = deps.plan.listRevenuePlans(
        workspaceId,
        actor.userId,
        status ? { status } : revenueGoalId ? { revenueGoalId } : undefined,
      );
      if (!result.ok) return Promise.resolve({ ok: false, error: fromPlanError(result.error) });
      return Promise.resolve({ ok: true, value: ok({ plans: result.value }) });
    });

  const getRevenuePlanHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const id = param(req, "id");
      if (isApiError(id)) return Promise.resolve({ ok: false, error: id });
      const result = deps.plan.getRevenuePlan(id, actor.userId);
      if (!result.ok) return Promise.resolve({ ok: false, error: fromPlanError(result.error) });
      return Promise.resolve({ ok: true, value: ok({ plan: result.value }) });
    });

  /** Every version compiled from the same goal, oldest first. */
  const getRevenuePlanHistoryHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const id = param(req, "id");
      if (isApiError(id)) return Promise.resolve({ ok: false, error: id });
      const result = deps.plan.planHistory(id, actor.userId);
      if (!result.ok) return Promise.resolve({ ok: false, error: fromPlanError(result.error) });
      return Promise.resolve({ ok: true, value: ok({ history: result.value }) });
    });

  const changeRevenuePlanStatusHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const id = param(req, "id");
      if (isApiError(id)) return { ok: false, error: id };
      const body = await parseBody(req);
      if (isApiError(body)) return { ok: false, error: body };
      const result = deps.plan.changeRevenuePlanStatus(id, actor.userId, body.status);
      if (!result.ok) return { ok: false, error: fromPlanError(result.error) };
      return { ok: true, value: ok({ plan: result.value }) };
    });

  const archiveRevenuePlanHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const id = param(req, "id");
      if (isApiError(id)) return Promise.resolve({ ok: false, error: id });
      const result = deps.plan.archiveRevenuePlan(id, actor.userId);
      if (!result.ok) return Promise.resolve({ ok: false, error: fromPlanError(result.error) });
      return Promise.resolve({ ok: true, value: ok({ plan: result.value }) });
    });

  /**
   * The agent-facing Business Brain context.
   *
   * Returns the structured snapshot; pricing is included only when approved.
   */
  const getBusinessContextHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return Promise.resolve({ ok: false, error: workspaceId });
      const result = deps.brain.getBusinessContext(workspaceId, actor.userId);
      if (!result.ok) return Promise.resolve({ ok: false, error: fromBrainError(result.error) });
      return Promise.resolve({ ok: true, value: ok({ context: result.value }) });
    });

  // -------------------------------------------------------------------------
  // Phase 5 — Account & Prospect Input
  //
  // Input only. These handlers store what the user supplies: they never look
  // anything up externally, never score a record and never contact anyone.
  // -------------------------------------------------------------------------

  /** Create a target account from user-supplied fields. */
  const createAccountHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };
      const body = await parseBody(req);
      if (isApiError(body)) return { ok: false, error: body };

      // Only the account fields are read. A `workspaceId` or `userId` in the
      // body is ignored: the workspace is the route's, the identity the token's.
      const result = deps.account.createAccount(workspaceId, actor.userId, body);
      if (!result.ok) return { ok: false, error: fromAccountError(result.error) };
      return { ok: true, value: ok({ account: result.value }) };
    });

  const listAccountsHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return Promise.resolve({ ok: false, error: workspaceId });
      const rawStatus = req.query.status;
      let status: AccountStatus | undefined;
      if (typeof rawStatus === "string" && rawStatus !== "") {
        if (!ACCOUNT_STATUSES.includes(rawStatus as AccountStatus)) {
          return Promise.resolve({
            ok: false,
            error: { code: "VALIDATION_ERROR", message: "invalid status filter" },
          });
        }
        status = rawStatus as AccountStatus;
      }
      const revenuePlanId =
        typeof req.query.revenuePlanId === "string" && req.query.revenuePlanId !== ""
          ? req.query.revenuePlanId
          : undefined;

      const result = deps.account.listAccounts(
        workspaceId,
        actor.userId,
        status ? { status } : revenuePlanId ? { revenuePlanId } : undefined,
      );
      if (!result.ok) return Promise.resolve({ ok: false, error: fromAccountError(result.error) });
      return Promise.resolve({ ok: true, value: ok({ accounts: result.value }) });
    });

  const getAccountHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const id = param(req, "id");
      if (isApiError(id)) return Promise.resolve({ ok: false, error: id });
      const result = deps.account.getAccount(id, actor.userId);
      if (!result.ok) return Promise.resolve({ ok: false, error: fromAccountError(result.error) });
      return Promise.resolve({ ok: true, value: ok({ account: result.value }) });
    });

  const updateAccountHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const id = param(req, "id");
      if (isApiError(id)) return { ok: false, error: id };
      const body = await parseBody(req);
      if (isApiError(body)) return { ok: false, error: body };
      const result = deps.account.updateAccount(id, actor.userId, body);
      if (!result.ok) return { ok: false, error: fromAccountError(result.error) };
      return { ok: true, value: ok({ account: result.value }) };
    });

  /** Archive an account. Its contacts are archived with it; nothing is deleted. */
  const archiveAccountHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const id = param(req, "id");
      if (isApiError(id)) return Promise.resolve({ ok: false, error: id });
      const result = deps.account.archiveAccount(id, actor.userId);
      if (!result.ok) return Promise.resolve({ ok: false, error: fromAccountError(result.error) });
      return Promise.resolve({ ok: true, value: ok({ account: result.value }) });
    });

  /** The accounts one revenue plan targeted. */
  const listPlanAccountsHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const revenuePlanId = param(req, "revenuePlanId");
      if (isApiError(revenuePlanId)) return Promise.resolve({ ok: false, error: revenuePlanId });
      const result = deps.account.listAccountsForPlan(revenuePlanId, actor.userId);
      if (!result.ok) return Promise.resolve({ ok: false, error: fromAccountError(result.error) });
      return Promise.resolve({ ok: true, value: ok({ accounts: result.value }) });
    });

  /**
   * Import accounts from CSV.
   *
   * The response reports every row; a caller is told what landed, what updated,
   * what was skipped and what failed, so nothing is ever dropped silently.
   */
  const importAccountsHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };
      const body = await parseBody(req);
      if (isApiError(body)) return { ok: false, error: body };
      const csv = body.csv;
      if (typeof csv !== "string") {
        return {
          ok: false,
          error: { code: "VALIDATION_ERROR", message: "csv must be a string" },
        };
      }
      const options: { sourceReference?: string; revenuePlanId?: string } = {};
      if (typeof body.sourceReference === "string") options.sourceReference = body.sourceReference;
      if (typeof body.revenuePlanId === "string") options.revenuePlanId = body.revenuePlanId;
      const result = deps.account.importAccountsCsv(workspaceId, actor.userId, csv, options);
      if (!result.ok) return { ok: false, error: fromAccountError(result.error) };
      return { ok: true, value: ok(result.value) };
    });

  const importContactsHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };
      const body = await parseBody(req);
      if (isApiError(body)) return { ok: false, error: body };
      const csv = body.csv;
      if (typeof csv !== "string") {
        return {
          ok: false,
          error: { code: "VALIDATION_ERROR", message: "csv must be a string" },
        };
      }
      const contactOptions: { sourceReference?: string } = {};
      if (typeof body.sourceReference === "string")
        contactOptions.sourceReference = body.sourceReference;
      const result = deps.account.importContactsCsv(workspaceId, actor.userId, csv, contactOptions);
      if (!result.ok) return { ok: false, error: fromAccountError(result.error) };
      return { ok: true, value: ok(result.value) };
    });

  /**
   * Add a contact to an account.
   *
   * The account may come from the route (`POST /accounts/:id/contacts`) or the
   * body. Either way the account must belong to the caller's workspace, which
   * the service checks against the authenticated identity.
   */
  const createContactHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };
      const body = await parseBody(req);
      if (isApiError(body)) return { ok: false, error: body };
      const accountId = req.params.accountId ?? body.accountId;

      const result = deps.account.createContact(workspaceId, actor.userId, {
        ...body,
        accountId,
      });
      if (!result.ok) return { ok: false, error: fromAccountError(result.error) };
      return { ok: true, value: ok({ contact: result.value }) };
    });

  const listAccountContactsHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const accountId = param(req, "accountId");
      if (isApiError(accountId)) return Promise.resolve({ ok: false, error: accountId });
      const result = deps.account.listContactsForAccount(accountId, actor.userId);
      if (!result.ok) return Promise.resolve({ ok: false, error: fromAccountError(result.error) });
      return Promise.resolve({ ok: true, value: ok({ contacts: result.value }) });
    });

  const listContactsHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return Promise.resolve({ ok: false, error: workspaceId });
      const rawStatus = req.query.status;
      let status: ContactStatus | undefined;
      if (typeof rawStatus === "string" && rawStatus !== "") {
        if (!CONTACT_STATUSES.includes(rawStatus as ContactStatus)) {
          return Promise.resolve({
            ok: false,
            error: { code: "VALIDATION_ERROR", message: "invalid status filter" },
          });
        }
        status = rawStatus as ContactStatus;
      }
      const accountId =
        typeof req.query.accountId === "string" && req.query.accountId !== ""
          ? req.query.accountId
          : undefined;

      const result = deps.account.listContacts(
        workspaceId,
        actor.userId,
        status ? { status } : accountId ? { accountId } : undefined,
      );
      if (!result.ok) return Promise.resolve({ ok: false, error: fromAccountError(result.error) });
      return Promise.resolve({ ok: true, value: ok({ contacts: result.value }) });
    });

  const getContactHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const id = param(req, "id");
      if (isApiError(id)) return Promise.resolve({ ok: false, error: id });
      const result = deps.account.getContact(id, actor.userId);
      if (!result.ok) return Promise.resolve({ ok: false, error: fromAccountError(result.error) });
      return Promise.resolve({ ok: true, value: ok({ contact: result.value }) });
    });

  const updateContactHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const id = param(req, "id");
      if (isApiError(id)) return { ok: false, error: id };
      const body = await parseBody(req);
      if (isApiError(body)) return { ok: false, error: body };
      const result = deps.account.updateContact(id, actor.userId, body);
      if (!result.ok) return { ok: false, error: fromAccountError(result.error) };
      return { ok: true, value: ok({ contact: result.value }) };
    });

  const archiveContactHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const id = param(req, "id");
      if (isApiError(id)) return Promise.resolve({ ok: false, error: id });
      const result = deps.account.archiveContact(id, actor.userId);
      if (!result.ok) return Promise.resolve({ ok: false, error: fromAccountError(result.error) });
      return Promise.resolve({ ok: true, value: ok({ contact: result.value }) });
    });

  // -------------------------------------------------------------------------
  // Phase 6 — Research Engine
  //
  // Research over an account the workspace already supplied. These handlers
  // ask the Research service to run a permitted provider and return its
  // findings; they never fetch anything themselves, never verify a claim and
  // never score, rank or contact the account.
  //
  // A run that fails is returned as a `failed` request with its recorded
  // reason, not as an empty success: a caller can always tell the difference
  // between "researched, nothing found" and "could not research".
  // -------------------------------------------------------------------------

  /** Request research for an existing account. */
  const createResearchRequestHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };
      const accountId = param(req, "accountId");
      if (isApiError(accountId)) return { ok: false, error: accountId };
      const body = await parseBody(req);
      if (isApiError(body)) return { ok: false, error: body };

      // Only the research fields are read. A `workspaceId` or `userId` in the
      // body is ignored: the workspace is the route's, the identity the
      // token's, and the account is the one the route names.
      const result = deps.research.createResearchRequest(workspaceId, actor.userId, accountId, {
        provider: body.provider,
        categories: body.categories,
        idempotencyKey: body.idempotencyKey,
      });
      if (!result.ok) return { ok: false, error: fromResearchError(result.error) };
      return { ok: true, value: ok({ request: result.value }) };
    });

  const getResearchRequestHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const id = param(req, "id");
      if (isApiError(id)) return Promise.resolve({ ok: false, error: id });
      const result = deps.research.getResearchRequest(id, actor.userId);
      if (!result.ok) return Promise.resolve({ ok: false, error: fromResearchError(result.error) });
      return Promise.resolve({ ok: true, value: ok({ request: result.value }) });
    });

  const listResearchRequestsHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return Promise.resolve({ ok: false, error: workspaceId });
      const rawStatus = req.query.status;
      let status: ResearchRequestStatus | undefined;
      if (typeof rawStatus === "string" && rawStatus !== "") {
        if (!RESEARCH_REQUEST_STATUSES.includes(rawStatus as ResearchRequestStatus)) {
          return Promise.resolve({
            ok: false,
            error: { code: "VALIDATION_ERROR", message: "invalid status filter" },
          });
        }
        status = rawStatus as ResearchRequestStatus;
      }
      const accountId =
        typeof req.query.accountId === "string" && req.query.accountId !== ""
          ? req.query.accountId
          : undefined;

      const result = deps.research.listResearchRequests(
        workspaceId,
        actor.userId,
        status ? { status } : accountId ? { accountId } : undefined,
      );
      if (!result.ok) return Promise.resolve({ ok: false, error: fromResearchError(result.error) });
      return Promise.resolve({ ok: true, value: ok({ requests: result.value }) });
    });

  /** Execute a pending (or retryable failed) research request. */
  const runResearchRequestHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const id = param(req, "id");
      if (isApiError(id)) return { ok: false, error: id };
      const result = await deps.research.runResearchRequest(id, actor.userId);
      if (!result.ok) return { ok: false, error: fromResearchError(result.error) };
      return { ok: true, value: ok(result.value) };
    });

  /** The attributed findings of one research request. */
  const getResearchFindingsHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const id = param(req, "id");
      if (isApiError(id)) return Promise.resolve({ ok: false, error: id });
      const result = deps.research.listFindingsForRequest(id, actor.userId);
      if (!result.ok) return Promise.resolve({ ok: false, error: fromResearchError(result.error) });
      return Promise.resolve({ ok: true, value: ok({ findings: result.value }) });
    });

  /** Stop a research request that has not finished. */
  const cancelResearchRequestHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const id = param(req, "id");
      if (isApiError(id)) return Promise.resolve({ ok: false, error: id });
      const result = deps.research.cancelResearchRequest(id, actor.userId);
      if (!result.ok) return Promise.resolve({ ok: false, error: fromResearchError(result.error) });
      return Promise.resolve({ ok: true, value: ok({ request: result.value }) });
    });

  // -------------------------------------------------------------------------
  // Phase 7 — Evidence System
  //
  // Evidence makes a research observation traceable, and a claim traceable
  // back to its evidence. These handlers translate; they never fetch a source,
  // never judge whether a claim is true, and never score, rank or contact the
  // account.
  //
  // The workspace always comes from the route and the identity always from the
  // session. A `workspaceId`, `userId`, `accountId` or `researchFindingId` in a
  // body is not proof of anything: ownership is re-verified server-side, and
  // another tenant's finding is reported as not found rather than revealed.
  // -------------------------------------------------------------------------

  /**
   * Record evidence for a research finding, and the claim it supports.
   *
   * The finding id is the only input: the account, workspace, source,
   * timestamps, confidence and freshness all come from the stored finding, so
   * a caller cannot cite one account's observation in support of another's.
   */
  const createEvidenceFromFindingHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return Promise.resolve({ ok: false, error: workspaceId });
      const researchFindingId = param(req, "researchFindingId");
      if (isApiError(researchFindingId)) {
        return Promise.resolve({ ok: false, error: researchFindingId });
      }

      const result = deps.evidence.createEvidenceFromFinding(
        workspaceId,
        actor.userId,
        researchFindingId,
      );
      if (!result.ok) {
        return Promise.resolve({ ok: false, error: fromEvidenceError(result.error) });
      }
      // `contradicted` is returned rather than hidden: a caller can always see
      // that a competing observation already existed.
      return Promise.resolve({ ok: true, value: ok(result.value) });
    });

  /**
   * Record evidence for a source the workspace supplied directly.
   *
   * The provenance path with no research request behind it. The account is the
   * route's, and the record is attributed to the workspace's own account
   * record rather than to an external source DEALORA has not read.
   */
  const recordUserEvidenceHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };
      const accountId = param(req, "accountId");
      if (isApiError(accountId)) return { ok: false, error: accountId };
      const body = await parseBody(req);
      if (isApiError(body)) return { ok: false, error: body };

      // Only the evidence fields are read. `workspaceId`, `userId` and
      // `accountId` in the body are ignored in favour of the route's.
      const result = deps.evidence.recordUserSuppliedEvidence(
        workspaceId,
        actor.userId,
        accountId,
        {
          category: body.category,
          field: body.field,
          value: body.value,
          claimKind: body.claimKind,
          sourceName: body.sourceName,
          sourceUrl: body.sourceUrl,
          sourceTitle: body.sourceTitle,
          observedAt: body.observedAt,
          confidence: body.confidence,
          relevance: body.relevance,
          note: body.note,
        },
      );
      if (!result.ok) return { ok: false, error: fromEvidenceError(result.error) };
      return { ok: true, value: ok(result.value) };
    });

  /** One evidence record, with the provenance that supports it. */
  const getEvidenceHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const id = param(req, "id");
      if (isApiError(id)) return Promise.resolve({ ok: false, error: id });
      const result = deps.evidence.getEvidence(id, actor.userId);
      if (!result.ok) return Promise.resolve({ ok: false, error: fromEvidenceError(result.error) });
      return Promise.resolve({ ok: true, value: ok({ evidence: result.value }) });
    });

  /**
   * A workspace's evidence, optionally narrowed to one account or status.
   *
   * Superseded, contradicted and rejected records are listed like any other:
   * a trail that hides the discarded half is not a trail.
   */
  const listEvidenceHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return Promise.resolve({ ok: false, error: workspaceId });

      const rawStatus = req.query.status;
      let status: EvidenceStatus | undefined;
      if (typeof rawStatus === "string" && rawStatus !== "") {
        if (!EVIDENCE_STATUSES.includes(rawStatus as EvidenceStatus)) {
          return Promise.resolve({
            ok: false,
            error: {
              code: "VALIDATION_ERROR",
              message: `status must be one of: ${EVIDENCE_STATUSES.join(", ")}`,
            },
          });
        }
        status = rawStatus as EvidenceStatus;
      }
      const accountId =
        typeof req.query.accountId === "string" && req.query.accountId !== ""
          ? req.query.accountId
          : undefined;

      const filter: { accountId?: string; status?: EvidenceStatus } = {};
      if (status) filter.status = status;
      if (accountId) filter.accountId = accountId;

      const result = deps.evidence.listEvidence(
        workspaceId,
        actor.userId,
        Object.keys(filter).length > 0 ? filter : undefined,
      );
      if (!result.ok) return Promise.resolve({ ok: false, error: fromEvidenceError(result.error) });
      return Promise.resolve({ ok: true, value: ok({ evidence: result.value }) });
    });

  /** Mark one record rejected, or contested. Status only, never a field edit. */
  const changeEvidenceStatusHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const id = param(req, "id");
      if (isApiError(id)) return { ok: false, error: id };
      const body = await parseBody(req);
      if (isApiError(body)) return { ok: false, error: body };

      const result = deps.evidence.changeEvidenceStatus(id, actor.userId, body.status);
      if (!result.ok) return { ok: false, error: fromEvidenceError(result.error) };
      return { ok: true, value: ok({ evidence: result.value }) };
    });

  /**
   * Point one record at its replacement.
   *
   * The replacement is named, never inferred: DEALORA does not decide that the
   * newer observation is the true one.
   */
  const supersedeEvidenceHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const id = param(req, "id");
      if (isApiError(id)) return { ok: false, error: id };
      const body = await parseBody(req);
      if (isApiError(body)) return { ok: false, error: body };

      const result = deps.evidence.supersedeEvidence(id, actor.userId, body.replacementEvidenceId);
      if (!result.ok) return { ok: false, error: fromEvidenceError(result.error) };
      return { ok: true, value: ok(result.value) };
    });

  /** One claim about an account. */
  const getAccountClaimHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const id = param(req, "id");
      if (isApiError(id)) return Promise.resolve({ ok: false, error: id });
      const result = deps.evidence.getAccountClaim(id, actor.userId);
      if (!result.ok) return Promise.resolve({ ok: false, error: fromEvidenceError(result.error) });
      return Promise.resolve({ ok: true, value: ok({ claim: result.value }) });
    });

  /** A workspace's claims, optionally narrowed to one account or status. */
  const listAccountClaimsHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return Promise.resolve({ ok: false, error: workspaceId });

      const rawStatus = req.query.status;
      let status: AccountClaimStatus | undefined;
      if (typeof rawStatus === "string" && rawStatus !== "") {
        if (!ACCOUNT_CLAIM_STATUSES.includes(rawStatus as AccountClaimStatus)) {
          return Promise.resolve({
            ok: false,
            error: {
              code: "VALIDATION_ERROR",
              message: `status must be one of: ${ACCOUNT_CLAIM_STATUSES.join(", ")}`,
            },
          });
        }
        status = rawStatus as AccountClaimStatus;
      }
      const accountId =
        typeof req.query.accountId === "string" && req.query.accountId !== ""
          ? req.query.accountId
          : undefined;

      const filter: { accountId?: string; status?: AccountClaimStatus } = {};
      if (status) filter.status = status;
      if (accountId) filter.accountId = accountId;

      const result = deps.evidence.listAccountClaims(
        workspaceId,
        actor.userId,
        Object.keys(filter).length > 0 ? filter : undefined,
      );
      if (!result.ok) return Promise.resolve({ ok: false, error: fromEvidenceError(result.error) });
      return Promise.resolve({ ok: true, value: ok({ claims: result.value }) });
    });

  /**
   * Every record supporting one claim — the traceability direction this phase
   * exists to provide.
   */
  const listClaimEvidenceHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const id = param(req, "id");
      if (isApiError(id)) return Promise.resolve({ ok: false, error: id });
      const result = deps.evidence.listEvidenceForClaim(id, actor.userId);
      if (!result.ok) return Promise.resolve({ ok: false, error: fromEvidenceError(result.error) });
      return Promise.resolve({ ok: true, value: ok({ evidence: result.value }) });
    });

  /** Withdraw a claim, or flag it contested. Soft: the evidence stays readable. */
  const changeAccountClaimStatusHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const id = param(req, "id");
      if (isApiError(id)) return { ok: false, error: id };
      const body = await parseBody(req);
      if (isApiError(body)) return { ok: false, error: body };

      const result = deps.evidence.changeAccountClaimStatus(id, actor.userId, body.status);
      if (!result.ok) return { ok: false, error: fromEvidenceError(result.error) };
      return { ok: true, value: ok({ claim: result.value }) };
    });

  // -------------------------------------------------------------------------
  // Phase 8 — Qualification Engine
  //
  // These handlers decide nothing. They resolve the authenticated actor,
  // take the account from the route, and hand the work to the qualification
  // service, which reads the criteria from the canonical Business Brain and
  // the account's own Phase 7 evidence.
  //
  // Nothing about the outcome is accepted from a caller. A `score`, `state`,
  // `confidence`, `priority` or `qualification` field in a body is not read:
  // the server computes the result or there is no result. The two fields a body
  // may carry — `revenueGoalId` and `ruleVersion` — select *which of the
  // workspace's own context* to measure against, and both are validated
  // server-side against the real goal and the rule versions this deployment
  // implements.
  // -------------------------------------------------------------------------

  /**
   * Evaluate an account and return the explainable result.
   *
   * Evaluation creates a new versioned record; it never overwrites an earlier
   * one, so a score a user acted on stays readable after the rules move on.
   */
  const createQualificationHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };
      const accountId = param(req, "accountId");
      if (isApiError(accountId)) return { ok: false, error: accountId };
      const body = await parseBody(req);
      if (isApiError(body)) return { ok: false, error: body };

      // Only the context selectors are read. `workspaceId`, `userId` and
      // `accountId` in the body are ignored in favour of the route's and the
      // token's.
      const result = deps.qualification.evaluateAccount(workspaceId, actor.userId, accountId, {
        revenueGoalId: body.revenueGoalId,
        ruleVersion: body.ruleVersion,
      });
      if (!result.ok) return { ok: false, error: fromQualificationError(result.error) };
      return { ok: true, value: ok({ qualification: result.value }) };
    });

  /**
   * The criteria this workspace would be measured against, before any
   * evaluation.
   *
   * A `ruleVersion` may be asked for explicitly and is validated against what
   * this deployment implements; when it is omitted the current rule set is
   * described, so a caller never has to know a version number to inspect the
   * rules.
   */
  const getQualificationCriteriaHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return Promise.resolve({ ok: false, error: workspaceId });

      const requested = req.query.ruleVersion;
      if (requested !== undefined && typeof requested !== "string") {
        return Promise.resolve({
          ok: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "ruleVersion must be one of: " + SUPPORTED_RULE_VERSIONS.join(", "),
          },
        });
      }
      const result = deps.qualification.describeQualificationCriteria(workspaceId, actor.userId, {
        ruleVersion: requested,
      });
      if (!result.ok)
        return Promise.resolve({ ok: false, error: fromQualificationError(result.error) });
      return Promise.resolve({ ok: true, value: ok(result.value) });
    });

  /** One evaluation, with its per-criterion results intact. */
  const getQualificationHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const id = param(req, "id");
      if (isApiError(id)) return Promise.resolve({ ok: false, error: id });
      const result = deps.qualification.getQualification(id, actor.userId);
      if (!result.ok)
        return Promise.resolve({ ok: false, error: fromQualificationError(result.error) });
      return Promise.resolve({ ok: true, value: ok({ qualification: result.value }) });
    });

  /**
   * A workspace's evaluations, newest first, optionally narrowed to one
   * account, state or rule version.
   */
  const listQualificationsHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return Promise.resolve({ ok: false, error: workspaceId });

      const accountId =
        typeof req.query.accountId === "string" && req.query.accountId !== ""
          ? req.query.accountId
          : undefined;
      const state =
        typeof req.query.state === "string" && req.query.state !== "" ? req.query.state : undefined;
      const ruleVersion =
        typeof req.query.ruleVersion === "string" && req.query.ruleVersion !== ""
          ? req.query.ruleVersion
          : undefined;

      const filter: { accountId?: string; state?: string; ruleVersion?: string } = {};
      if (accountId) filter.accountId = accountId;
      if (state) filter.state = state;
      if (ruleVersion) filter.ruleVersion = ruleVersion;

      const result = deps.qualification.listQualifications(
        workspaceId,
        actor.userId,
        Object.keys(filter).length > 0 ? filter : undefined,
      );
      if (!result.ok)
        return Promise.resolve({ ok: false, error: fromQualificationError(result.error) });
      return Promise.resolve({ ok: true, value: ok({ qualifications: result.value }) });
    });

  /**
   * Why an account received a score: the evaluation together with the claim and
   * evidence records each criterion actually read.
   *
   * This is the phase's gate in one read — "a user can inspect why an account
   * received a score" — and it is a join over Phase 7's records rather than a
   * copy of them.
   */
  const getQualificationExplanationHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const id = param(req, "id");
      if (isApiError(id)) return Promise.resolve({ ok: false, error: id });
      const result = deps.qualification.inspectQualification(id, actor.userId);
      if (!result.ok)
        return Promise.resolve({ ok: false, error: fromQualificationError(result.error) });
      return Promise.resolve({ ok: true, value: ok(result.value) });
    });

  // -------------------------------------------------------------------------
  // Phase 9 — Personalization Engine
  //
  // These handlers translate and nothing more. The account comes from the
  // route, the identity from the session, and every rule — that the account is
  // qualified, that the offer is active, that the contact belongs to the
  // account, and above all what a draft may say — is enforced by the
  // personalization service against the server-side identity.
  //
  // Nothing about the content is accepted from a caller. A `subject`, `body`,
  // `warnings` or `personalizationPoints` field in a body is not read: the
  // server renders the draft or there is no draft. The four selectors a body
  // may carry — `qualificationId`, `offerId`, `contactId` and
  // `rendererVersion` — choose *which of the workspace's own* context to draft
  // from, and each is validated server-side against the real records and the
  // renderer versions this deployment implements.
  //
  // No handler here sends anything. There is no send route, no channel and no
  // provider at this phase: the only path out of a draft is the Phase 10
  // approval boundary.
  // -------------------------------------------------------------------------

  /**
   * Generate one draft for a qualified account.
   *
   * Generation inserts a new immutable version rather than rewriting an
   * existing draft, so a draft a reviewer has already seen can never change
   * underneath them — which is what lets an approval bind to one exact version.
   */
  const createPersonalizedDraftHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };
      const accountId = param(req, "accountId");
      if (isApiError(accountId)) return { ok: false, error: accountId };
      const body = await parseBody(req);
      if (isApiError(body)) return { ok: false, error: body };

      // Only the context selectors are read. `workspaceId`, `userId` and
      // `accountId` in the body are ignored in favour of the route's and the
      // token's, and no content field is read at all.
      const result = deps.personalization.generateDraft(workspaceId, actor.userId, accountId, {
        qualificationId: body.qualificationId,
        offerId: body.offerId,
        contactId: body.contactId,
        rendererVersion: body.rendererVersion,
      });
      if (!result.ok) return { ok: false, error: fromPersonalizationError(result.error) };
      return { ok: true, value: ok({ draft: result.value }) };
    });

  /**
   * The rules this workspace's drafts are composed under, before any draft
   * exists.
   *
   * A `rendererVersion` may be asked for explicitly and is validated against
   * what this deployment implements; when it is omitted the current renderer is
   * described, so a caller never has to know a version number to learn what a
   * draft may and may not state.
   */
  const getPersonalizationRendererHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return Promise.resolve({ ok: false, error: workspaceId });

      const requested = req.query.rendererVersion;
      if (requested !== undefined && typeof requested !== "string") {
        return Promise.resolve({
          ok: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "rendererVersion must be one of: " + SUPPORTED_RENDERER_VERSIONS.join(", "),
          },
        });
      }
      const result = deps.personalization.describePersonalizationRenderer(
        workspaceId,
        actor.userId,
        { rendererVersion: requested },
      );
      if (!result.ok)
        return Promise.resolve({ ok: false, error: fromPersonalizationError(result.error) });
      return Promise.resolve({ ok: true, value: ok(result.value) });
    });

  /** One draft, exactly as it was rendered and stored. */
  const getPersonalizedDraftHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const id = param(req, "id");
      if (isApiError(id)) return Promise.resolve({ ok: false, error: id });
      const result = deps.personalization.getDraft(id, actor.userId);
      if (!result.ok)
        return Promise.resolve({ ok: false, error: fromPersonalizationError(result.error) });
      return Promise.resolve({ ok: true, value: ok({ draft: result.value }) });
    });

  /** A workspace's drafts, newest first, optionally narrowed to one account. */
  const listPersonalizedDraftsHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return Promise.resolve({ ok: false, error: workspaceId });

      const accountId =
        typeof req.query.accountId === "string" && req.query.accountId !== ""
          ? req.query.accountId
          : undefined;

      const result = deps.personalization.listDrafts(workspaceId, actor.userId, { accountId });
      if (!result.ok)
        return Promise.resolve({ ok: false, error: fromPersonalizationError(result.error) });
      return Promise.resolve({ ok: true, value: ok({ drafts: result.value }) });
    });

  /**
   * The draft together with the claim and evidence records behind every
   * statement in it.
   *
   * This is the phase's gate — "a personalized draft with supporting evidence"
   * — in one read. The records are joined from storage rather than copied into
   * the draft, so the stored document stays small and Phase 7's records stay
   * the single source of truth.
   */
  const getPersonalizedDraftEvidenceHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const id = param(req, "id");
      if (isApiError(id)) return Promise.resolve({ ok: false, error: id });
      const result = deps.personalization.inspectDraft(id, actor.userId);
      if (!result.ok)
        return Promise.resolve({ ok: false, error: fromPersonalizationError(result.error) });
      return Promise.resolve({ ok: true, value: ok(result.value) });
    });

  // -------------------------------------------------------------------------
  // Phase 10 — Approval Engine
  //
  // These handlers create and record a persisted human decision. They decide
  // nothing themselves and execute nothing: the identity is always the
  // session's, and the only state a request is ever created in is `pending`.
  //
  // Nothing about the decision is accepted from a caller. An `approved`,
  // `decidedBy`, `decidedAt`, `status` or `decision` field in a body is not
  // read — the decision route takes exactly one field, the decision itself, and
  // the reviewer is the authenticated user. A client cannot name its own
  // approver, cannot backdate a decision, and cannot turn a request into an
  // approval by asking twice.
  //
  // There is no execute route here. An approval authorizes a send; the send is
  // Phase 11, and it re-verifies these records independently before it calls a
  // provider.
  // -------------------------------------------------------------------------

  /**
   * Put one exact draft version up for a human decision.
   *
   * The draft and version come from the route. The request is bound to both,
   * plus a digest of the exact content the reviewer is about to see, so
   * "which version was approved?" is a stored answer rather than a
   * reconstruction.
   */
  const createApprovalRequestHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };
      const draftId = param(req, "draftId");
      if (isApiError(draftId)) return { ok: false, error: draftId };
      const body = await parseBody(req);
      if (isApiError(body)) return { ok: false, error: body };

      // Only the two lifecycle selectors are read. Everything that would
      // constitute a decision is ignored in favour of the session.
      const result = deps.approval.requestApproval(workspaceId, actor.userId, draftId, {
        draftVersion: body.draftVersion,
        expiresInDays: body.expiresInDays,
      });
      if (!result.ok) return { ok: false, error: fromApprovalError(result.error) };
      return { ok: true, value: ok({ approval: result.value }) };
    });

  /**
   * Record one explicit human decision.
   *
   * Exactly one field is read: the decision. The reviewer is the session's
   * user, the instant is the server's clock, and a rejection or change request
   * must say why — so "who approved this, and when?" is answerable from the
   * stored record alone.
   */
  const decideApprovalRequestHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };
      const id = param(req, "id");
      if (isApiError(id)) return { ok: false, error: id };
      const body = await parseBody(req);
      if (isApiError(body)) return { ok: false, error: body };

      // Only `decision` and `reason` are read. `decidedBy`, `decidedAt`,
      // `status`, `approved` and `expiresAt` in a body are ignored: the
      // reviewer and the instant are the server's to record.
      const result = deps.approval.recordDecision(
        workspaceId,
        actor.userId,
        id,
        body.decision,
        body.reason,
      );
      if (!result.ok) return { ok: false, error: fromApprovalError(result.error) };
      return { ok: true, value: ok({ approval: result.value.request, event: result.value.event }) };
    });

  /** Withdraw a pending request. Terminal, and never a decision. */
  const cancelApprovalRequestHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };
      const id = param(req, "id");
      if (isApiError(id)) return { ok: false, error: id };
      const body = await parseBody(req);
      if (isApiError(body)) return { ok: false, error: body };

      const result = deps.approval.cancelApproval(workspaceId, actor.userId, id, body.reason);
      if (!result.ok) return { ok: false, error: fromApprovalError(result.error) };
      return { ok: true, value: ok({ approval: result.value }) };
    });

  /** One request, as stored. */
  const getApprovalRequestHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const id = param(req, "id");
      if (isApiError(id)) return Promise.resolve({ ok: false, error: id });
      const result = deps.approval.getApprovalRequest(id, actor.userId);
      if (!result.ok) return Promise.resolve({ ok: false, error: fromApprovalError(result.error) });
      return Promise.resolve({ ok: true, value: ok({ approval: result.value }) });
    });

  /**
   * What a reviewer sees: the request plus the exact content of the draft
   * version it is bound to, including everything the renderer declined to state.
   */
  const previewApprovalRequestHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const id = param(req, "id");
      if (isApiError(id)) return Promise.resolve({ ok: false, error: id });
      const result = deps.approval.previewApproval(id, actor.userId);
      if (!result.ok) return Promise.resolve({ ok: false, error: fromApprovalError(result.error) });
      return Promise.resolve({ ok: true, value: ok(result.value) });
    });

  /** A workspace's requests, newest first, optionally narrowed. */
  const listApprovalRequestsHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return Promise.resolve({ ok: false, error: workspaceId });

      const rawStatus = req.query.status;
      let status: string | undefined;
      if (typeof rawStatus === "string" && rawStatus !== "") {
        if (!APPROVAL_STATUSES.includes(rawStatus as never)) {
          return Promise.resolve({
            ok: false,
            error: {
              code: "VALIDATION_ERROR" as const,
              message: `status must be one of: ${APPROVAL_STATUSES.join(", ")}`,
            },
          });
        }
        status = rawStatus;
      }
      const draftId =
        typeof req.query.draftId === "string" && req.query.draftId !== ""
          ? req.query.draftId
          : undefined;
      const decidedBy =
        typeof req.query.decidedBy === "string" && req.query.decidedBy !== ""
          ? req.query.decidedBy
          : undefined;

      const result = deps.approval.listApprovals(workspaceId, actor.userId, {
        status,
        draftId,
        decidedBy,
      });
      if (!result.ok) return Promise.resolve({ ok: false, error: fromApprovalError(result.error) });
      return Promise.resolve({ ok: true, value: ok({ approvals: result.value }) });
    });

  /**
   * The whole audit trail for one request: who asked, who decided, what, when
   * and why. Append-only, so it survives whatever happens to the request row.
   */
  const approvalHistoryHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const id = param(req, "id");
      if (isApiError(id)) return Promise.resolve({ ok: false, error: id });
      const result = deps.approval.approvalHistory(id, actor.userId);
      if (!result.ok) return Promise.resolve({ ok: false, error: fromApprovalError(result.error) });
      return Promise.resolve({ ok: true, value: ok({ history: result.value }) });
    });

  /** The policy this deployment enforces, readable before any request exists. */
  const getApprovalPolicyHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return Promise.resolve({ ok: false, error: workspaceId });
      const result = deps.approval.describeApprovalPolicy(workspaceId, actor.userId);
      if (!result.ok) return Promise.resolve({ ok: false, error: fromApprovalError(result.error) });
      return Promise.resolve({ ok: true, value: ok(result.value) });
    });

  // -------------------------------------------------------------------------
  // Phase 11 — First Outbound Integration
  //
  // These handlers move an approved message to one configured provider. They
  // are the only routes in the API that can cause anything to leave the
  // system, and each one is explicit: nothing here is scheduled, queued or
  // retried automatically, and a send only happens because an authenticated
  // request asked for it.
  //
  // Nothing about the send is accepted from a caller. There is no `approved`,
  // `status`, `provider`, `providerReference`, `sentAt` or `delivered` field
  // that is read: the approval is re-verified from storage, the recipient is
  // resolved from the contact record, the provider is the one this deployment
  // configured, and `sent` is written only from a provider confirmation. A
  // client cannot mark its own message delivered.
  // -------------------------------------------------------------------------

  /**
   * Stage an approved draft version for sending.
   *
   * Only `draftVersion` is read from the body. Everything that would describe
   * the message itself — recipient, provider, subject, body, status — is
   * resolved server-side, and the approval must already cover this exact
   * version for the action to be created at all.
   */
  const createOutboundActionHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };
      const draftId = param(req, "draftId");
      if (isApiError(draftId)) return { ok: false, error: draftId };
      const body = await parseBody(req);
      if (isApiError(body)) return { ok: false, error: body };

      const result = deps.outbound.stageOutbound(workspaceId, actor.userId, draftId, {
        draftVersion: body.draftVersion,
      });
      if (!result.ok) return { ok: false, error: fromOutboundError(result.error) };
      return { ok: true, value: ok({ action: result.value }) };
    });

  /**
   * Send one staged action.
   *
   * Takes no body at all. The provider, the recipient and the approval are
   * the system's to determine, and the whole authorization chain is
   * re-verified here rather than trusted from staging.
   */
  const sendOutboundActionHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };
      const id = param(req, "id");
      if (isApiError(id)) return { ok: false, error: id };

      const result = await deps.outbound.sendOutbound(workspaceId, actor.userId, id);
      if (!result.ok) return { ok: false, error: fromOutboundError(result.error) };
      return {
        ok: true,
        value: ok({
          action: result.value.action,
          delivered: result.value.delivered,
          provider: result.value.provider,
          history: result.value.events,
        }),
      };
    });

  /** Withdraw a staged action before any provider call. Terminal. */
  const cancelOutboundActionHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };
      const id = param(req, "id");
      if (isApiError(id)) return { ok: false, error: id };
      const body = await parseBody(req);
      if (isApiError(body)) return { ok: false, error: body };

      const result = deps.outbound.cancelOutbound(workspaceId, actor.userId, id, body.reason);
      if (!result.ok) return { ok: false, error: fromOutboundError(result.error) };
      return { ok: true, value: ok({ action: result.value }) };
    });

  /** One action, as stored. */
  const getOutboundActionHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const id = param(req, "id");
      if (isApiError(id)) return Promise.resolve({ ok: false, error: id });
      const result = deps.outbound.getOutbound(id, actor.userId);
      if (!result.ok) {
        return Promise.resolve({ ok: false, error: fromOutboundError(result.error) });
      }
      return Promise.resolve({ ok: true, value: ok({ action: result.value }) });
    });

  /** A workspace's actions, newest first, optionally narrowed by status. */
  const listOutboundActionsHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return Promise.resolve({ ok: false, error: workspaceId });

      const result = deps.outbound.listOutbound(workspaceId, actor.userId, {
        status: req.query.status,
        draftId: req.query.draftId,
        approvalId: req.query.approvalId,
      });
      if (!result.ok) {
        return Promise.resolve({ ok: false, error: fromOutboundError(result.error) });
      }
      return Promise.resolve({ ok: true, value: ok({ actions: result.value }) });
    });

  /**
   * One action's audit trail: created, attempted, sent, failed, cancelled.
   * Append-only, and a failure is recorded as durably as a success.
   */
  const outboundActionHistoryHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const id = param(req, "id");
      if (isApiError(id)) return Promise.resolve({ ok: false, error: id });
      const result = deps.outbound.actionHistory(id, actor.userId);
      if (!result.ok) {
        return Promise.resolve({ ok: false, error: fromOutboundError(result.error) });
      }
      return Promise.resolve({ ok: true, value: ok({ history: result.value }) });
    });

  /**
   * Add an address to the workspace's opt-out list.
   *
   * Permanent and attributed: the record keeps who added it and why, because
   * an opt-out that cannot be explained is one a workspace cannot be asked to
   * trust. Checked before every provider call.
   */
  const createOutboundSuppressionHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };
      const body = await parseBody(req);
      if (isApiError(body)) return { ok: false, error: body };

      const result = deps.outbound.suppress(workspaceId, actor.userId, body.email, body.reason);
      if (!result.ok) return { ok: false, error: fromOutboundError(result.error) };
      return { ok: true, value: ok({ suppression: result.value }) };
    });

  const listOutboundSuppressionsHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return Promise.resolve({ ok: false, error: workspaceId });
      const result = deps.outbound.listSuppressions(workspaceId, actor.userId);
      if (!result.ok) {
        return Promise.resolve({ ok: false, error: fromOutboundError(result.error) });
      }
      return Promise.resolve({ ok: true, value: ok({ suppressions: result.value }) });
    });

  /**
   * The outbound policy this deployment enforces, plus which providers it has
   * configured. Readable before anything has been sent.
   */
  const getOutboundPolicyHandler: ApiHandler = (req) =>
    authenticated(req, deps, (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return Promise.resolve({ ok: false, error: workspaceId });
      const result = deps.outbound.policy(workspaceId, actor.userId);
      if (!result.ok) {
        return Promise.resolve({ ok: false, error: fromOutboundError(result.error) });
      }
      return Promise.resolve({
        ok: true,
        value: ok({ ...result.value, configuredProviders: deps.outbound.configuredProviders() }),
      });
    });

  // -------------------------------------------------------------------------
  // Phase 12 — Conversation Engine
  //
  // These handlers record a response that was actually received and read it
  // with the deterministic classifier. They are the read-and-recommend half
  // of the revenue loop, and deliberately the *only* thing Phase 12 can do
  // through the API: none of these routes sends a message, creates an
  // approval, writes evidence, or schedules anything.
  //
  // Nothing about the reading is accepted from a caller. There is no `intent`,
  // `confidence`, `signals`, `recommendedNextAction`,
  // `humanInterventionRequired` or `suppressed` field that is read: the
  // classifier decides those from the recorded text alone. A client cannot
  // label a customer's reply, and it cannot make one look urgent.
  // -------------------------------------------------------------------------

  /**
   * Record one inbound response and classify it.
   *
   * Only `outboundActionId`, the text itself and its provenance are read from
   * the body. The contact and account are resolved server-side from the sent
   * action, and an action that was never sent is not found — so a response
   * cannot be filed against a contact DEALORA never actually wrote to.
   */
  const createInboundMessageHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };
      const outboundActionId = param(req, "outboundActionId");
      if (isApiError(outboundActionId)) return { ok: false, error: outboundActionId };
      const body = await parseBody(req);
      if (isApiError(body)) return { ok: false, error: body };

      const result = deps.conversation.recordInbound(
        workspaceId,
        actor.userId,
        outboundActionId,
        {
          body: body.body,
          subject: body.subject,
          fromAddress: body.fromAddress,
          providerMessageId: body.providerMessageId,
        },
        { source: body.source, receivedAt: body.receivedAt },
      );
      if (!result.ok) return { ok: false, error: fromConversationError(result.error) };
      return { ok: true, value: ok(result.value) };
    });

  /** One recorded response with its classification and its audit trail. */
  const getInboundMessageHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const id = param(req, "id");
      if (isApiError(id)) return { ok: false, error: id };
      const result = deps.conversation.inspectResponse(id, actor.userId);
      if (!result.ok) return { ok: false, error: fromConversationError(result.error) };
      return { ok: true, value: ok(result.value) };
    });

  /** A workspace's recorded responses, newest first. */
  const listInboundMessagesHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };
      const result = deps.conversation.listInbound(workspaceId, actor.userId, {
        outboundActionId: req.query.outboundActionId,
        contactId: req.query.contactId,
      });
      if (!result.ok) return { ok: false, error: fromConversationError(result.error) };
      return { ok: true, value: ok({ messages: result.value }) };
    });

  /** A workspace's classifications, newest first, optionally by intent. */
  const listConversationClassificationsHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };
      const result = deps.conversation.listClassifications(workspaceId, actor.userId, {
        intent: req.query.intent,
        outboundActionId: req.query.outboundActionId,
      });
      if (!result.ok) return { ok: false, error: fromConversationError(result.error) };
      return { ok: true, value: ok({ classifications: result.value }) };
    });

  /** One classification's append-only audit trail, oldest first. */
  const conversationHistoryHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const id = param(req, "id");
      if (isApiError(id)) return { ok: false, error: id };
      const result = deps.conversation.classificationHistory(id, actor.userId);
      if (!result.ok) return { ok: false, error: fromConversationError(result.error) };
      return { ok: true, value: ok({ events: result.value }) };
    });

  /**
   * The conversation policy this deployment enforces, plus the rule set it
   * reads with — readable before any response exists.
   */
  const getConversationPolicyHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };
      const result = deps.conversation.policy(workspaceId, actor.userId);
      if (!result.ok) return { ok: false, error: fromConversationError(result.error) };
      return { ok: true, value: ok(result.value) };
    });

  // -------------------------------------------------------------------------
  // Phase 13 — Meeting Workflow
  //
  // These handlers turn a response that read as positive into a booking record
  // with a measurable state, and produce the preparation brief BLUEPRINT.md §22
  // describes. They are the only thing Phase 13 can do through the API.
  //
  // **None of them can book a meeting.** `DEALORA_BLUEPRINT.md` §17 classifies
  // scheduling an event as a Level 2 external action requiring approval or policy
  // authorization, so proposing, approving and booking are three separate
  // authenticated calls, and the service refuses any booking that has no approval
  // behind it.
  //
  // No server-owned field is read from a request body. A caller supplies a
  // classification id, the booking's own times and title, and a decision — never
  // an account, a contact, a qualification, a recommendation reason, a state, an
  // approver, a provider reference or a booked instant. All of those are derived
  // server-side or come from the session.
  // -------------------------------------------------------------------------

  /**
   * Propose a meeting from a positive response.
   *
   * The result is always `recommended`: nothing is scheduled, no invitation is
   * sent, and no calendar has been contacted. The account, contact, qualification
   * and reason are all resolved server-side from the named classification.
   */
  const recommendMeetingHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };
      const body = await parseBody(req);
      if (isApiError(body)) return { ok: false, error: body };

      const result = deps.meeting.recommendMeeting(workspaceId, actor.userId, {
        classificationId: body.classificationId,
        title: body.title,
        startsAt: body.startsAt,
        endsAt: body.endsAt,
        timezone: body.timezone,
        durationMinutes: body.durationMinutes,
      });
      if (!result.ok) return { ok: false, error: fromMeetingError(result.error) };
      return { ok: true, value: ok(result.value) };
    });

  /** A workspace's meetings, newest first, optionally narrowed by state. */
  const listMeetingsHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };
      const result = deps.meeting.listMeetings(workspaceId, actor.userId, {
        state: req.query.state,
        accountId: req.query.accountId,
        contactId: req.query.contactId,
      });
      if (!result.ok) return { ok: false, error: fromMeetingError(result.error) };
      return { ok: true, value: ok({ meetings: result.value }) };
    });

  /** One meeting with its brief, authorized against the caller's own workspace. */
  const getMeetingHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const id = param(req, "id");
      if (isApiError(id)) return { ok: false, error: id };
      const result = deps.meeting.getMeeting(id, actor.userId);
      if (!result.ok) return { ok: false, error: fromMeetingError(result.error) };
      return { ok: true, value: ok(result.value) };
    });

  /**
   * Record a person's decision about a proposed booking.
   *
   * The approver identity and the instant come from the session, never from the
   * body: a caller can say *whether* they approve, but not *who* approved or
   * *when*. A decline or a cancellation must say why.
   */
  const decideMeetingHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };
      const id = param(req, "id");
      if (isApiError(id)) return { ok: false, error: id };
      const body = await parseBody(req);
      if (isApiError(body)) return { ok: false, error: body };

      const result = deps.meeting.decideMeeting(
        workspaceId,
        actor.userId,
        id,
        body.decision,
        body.reason,
      );
      if (!result.ok) return { ok: false, error: fromMeetingError(result.error) };
      return { ok: true, value: ok(result.value) };
    });

  /**
   * Book an approved meeting through the calendar adapter.
   *
   * This is the only route that reaches an external system, and it refuses unless
   * the stored row already carries an approval. The event is created by the
   * adapter; `booked` is written only on its confirmation, so a refusal or a
   * thrown call is recorded as a booking failure and never as a meeting.
   *
   * It books nothing else: no invitation is sent, because Phase 10's approval and
   * Phase 11's send path still govern every message.
   */
  const bookMeetingHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };
      const id = param(req, "id");
      if (isApiError(id)) return { ok: false, error: id };

      const result = await deps.meeting.bookMeeting(workspaceId, actor.userId, id);
      if (!result.ok) return { ok: false, error: fromMeetingError(result.error) };
      return { ok: true, value: ok(result.value) };
    });

  /**
   * Produce the preparation brief for a meeting.
   *
   * Versioned rather than replaced, and explicit about what the workspace does
   * not have: every section `DEALORA_BLUEPRINT.md` §22 names that has no record
   * behind it is returned in `gaps` instead of being filled in.
   */
  const prepareMeetingBriefHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };
      const id = param(req, "id");
      if (isApiError(id)) return { ok: false, error: id };

      const result = deps.meeting.prepareBrief(workspaceId, actor.userId, id);
      if (!result.ok) return { ok: false, error: fromMeetingError(result.error) };
      return { ok: true, value: ok(result.value) };
    });

  /** One meeting's append-only audit trail, oldest first. */
  const getMeetingHistoryHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const id = param(req, "id");
      if (isApiError(id)) return { ok: false, error: id };
      const result = deps.meeting.meetingHistory(id, actor.userId);
      if (!result.ok) return { ok: false, error: fromMeetingError(result.error) };
      return { ok: true, value: ok({ events: result.value }) };
    });

  /**
   * The booking policy this deployment enforces, plus the brief renderer version —
   * readable before any meeting exists, including every legal state transition.
   */
  const getMeetingPolicyHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };
      const result = deps.meeting.policy(workspaceId, actor.userId);
      if (!result.ok) return { ok: false, error: fromMeetingError(result.error) };
      return { ok: true, value: ok(result.value) };
    });

  // -------------------------------------------------------------------------
  // Phase 14 — Next Best Action Engine
  //
  // These handlers answer ROADMAP.md §21's one question — "what should happen
  // next?" — for a single account and for a whole workspace. They are the only
  // thing Phase 14 can do through the API.
  //
  // **None of them acts on the answer.** There is no route here that sends,
  // approves, books or schedules anything. A recommendation is a record with its
  // reasons attached; acting on it means calling Phase 10, 11 or 13, each of
  // which re-derives its own approval, digest and suppression check first.
  //
  // The only field a caller ever sends is an account id. There is deliberately no
  // `action`, `reason`, `confidence`, `riskLevel`, `approvalRequired` or
  // `expectedOutcome` anywhere in these handlers: all six are server-derived, and
  // a body that carries them is ignored rather than trusted.
  // -------------------------------------------------------------------------

  /**
   * The next recommended action for one account, computed live.
   *
   * Nothing is persisted. This is the route that answers "what should happen
   * right now?", and it re-decides from current rows on every call so a stale
   * suggestion can never be shown.
   */
  const recommendNextActionHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };
      const body = await parseBody(req);
      if (isApiError(body)) return { ok: false, error: body };

      const result = deps.nextaction.recommendNextAction(workspaceId, actor.userId, {
        accountId: body.accountId,
      });
      if (!result.ok) return { ok: false, error: fromNextActionError(result.error) };
      return { ok: true, value: ok(result.value) };
    });

  /**
   * The next recommended action for every account in a workspace.
   *
   * §25's "constantly answer what should happen next" is really about this shape:
   * a workspace asking about its whole pipeline rather than one account at a
   * time. A workspace with more accounts than the published cap is **refused**
   * rather than silently truncated.
   */
  const recommendWorkspaceActionsHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };

      const result = deps.nextaction.recommendForWorkspace(workspaceId, actor.userId);
      if (!result.ok) return { ok: false, error: fromNextActionError(result.error) };
      return { ok: true, value: ok(result.value) };
    });

  /**
   * Record the current recommendation for one account.
   *
   * Recording is explicit rather than a side effect of reading, so "DEALORA
   * advised this, on this evidence, at this rule version" is something the
   * workspace chose to keep. The row is immutable, and **it still does not act**:
   * the phases that own doing the work still require their own human approval.
   */
  const recordNextActionHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };
      const body = await parseBody(req);
      if (isApiError(body)) return { ok: false, error: body };

      const result = deps.nextaction.recordRecommendation(workspaceId, actor.userId, {
        accountId: body.accountId,
      });
      if (!result.ok) return { ok: false, error: fromNextActionError(result.error) };
      return { ok: true, value: ok(result.value) };
    });

  /** The recorded history, newest first, optionally narrowed by account or action. */
  const listNextActionsHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };

      const result = deps.nextaction.listRecommendations(workspaceId, actor.userId, {
        accountId: req.query.accountId,
        action: req.query.action,
      });
      if (!result.ok) return { ok: false, error: fromNextActionError(result.error) };
      return { ok: true, value: ok({ recommendations: result.value }) };
    });

  /** One recorded recommendation, authorized against the caller's own workspace. */
  const getNextActionHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const id = param(req, "id");
      if (isApiError(id)) return { ok: false, error: id };

      const result = deps.nextaction.getRecommendation(id, actor.userId);
      if (!result.ok) return { ok: false, error: fromNextActionError(result.error) };
      return { ok: true, value: ok(result.value) };
    });

  /**
   * The recommendation rules this deployment enforces — every state, the action
   * it produces, the §17 level and the expected outcome — plus everything the
   * engine refuses to do.
   *
   * Readable before a workspace has a single account, so a workspace can see the
   * whole rule set before handing over anything.
   */
  const getNextActionPolicyHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };

      const result = deps.nextaction.policy(workspaceId, actor.userId);
      if (!result.ok) return { ok: false, error: fromNextActionError(result.error) };
      return { ok: true, value: ok(result.value) };
    });

  // -------------------------------------------------------------------------
  // Phase 15 — Revenue Graph
  //
  // These handlers answer ROADMAP.md §22's one question — how does this
  // workspace's revenue loop actually connect? — for a whole workspace, for a
  // single account's opportunity lifecycle, and for the rule set that decides
  // what the graph may say.
  //
  // **All three are reads.** There is no route here that creates a node, adds
  // an edge, records an opportunity or extends a lifecycle: every relationship
  // is derived server-side from stored linkage, and this phase has no write
  // path at all. Nothing is recommended either — Phase 14 owns advice — and
  // nothing is acted on.
  //
  // The only field a caller ever sends is an account id. Nodes, edges,
  // provenance, opportunity and lifecycle are never read from the request, so
  // a body that carries them is ignored rather than trusted.
  // -------------------------------------------------------------------------

  /**
   * The whole workspace's graph: every account's nodes and edges, merged,
   * deduplicated and ordered by the revenue loop. A workspace above the
   * published account cap is **refused** rather than silently truncated.
   */
  const getRevenueGraphHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };

      const result = deps.revenuegraph.workspaceGraph(workspaceId, actor.userId);
      if (!result.ok) return { ok: false, error: fromRevenueGraphError(result.error) };
      return { ok: true, value: ok(result.value) };
    });

  /**
   * Trace the lifecycle of one account's opportunity: the account's graph
   * plus its ordered stages, frontier and opportunity node, all derived live
   * from current rows. The caller sends an account id and nothing else.
   */
  const traceOpportunityHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };
      const body = await parseBody(req);
      if (isApiError(body)) return { ok: false, error: body };

      const result = deps.revenuegraph.traceOpportunity(workspaceId, actor.userId, {
        accountId: body.accountId,
      });
      if (!result.ok) return { ok: false, error: fromRevenueGraphError(result.error) };
      return { ok: true, value: ok(result.value) };
    });

  /**
   * The vocabulary this deployment enforces — every node kind, every edge
   * kind with its stored-field derivation, the stage order — plus everything
   * the graph refuses with the phase that owns it. Readable before a workspace
   * has a single account.
   */
  const getRevenueGraphPolicyHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };

      const result = deps.revenuegraph.policy(workspaceId, actor.userId);
      if (!result.ok) return { ok: false, error: fromRevenueGraphError(result.error) };
      return { ok: true, value: ok(result.value) };
    });

  // -------------------------------------------------------------------------
  // Phase 16 — Cost Engine
  //
  // These handlers answer ROADMAP.md §23: what did a run cost, and what does
  // the whole workspace's cost look like once derived from its facts.
  //
  // Recording appends exactly one immutable fact per request. The body is
  // read for the fact's fields — execution, category, basis, amount, currency,
  // occurred-at, idempotency key, source — and for nothing else: who recorded
  // it is the session, when it was recorded is the server's clock, and a
  // `createdBy`, `workspaceId` or `totalMinor` in the body is ignored rather
  // than trusted. Totals are never accepted, only derived.
  //
  // Reads are all server-side derivations over the caller's own workspace:
  // no route stores, accepts or mutates an aggregate.
  // -------------------------------------------------------------------------

  /** Append one immutable cost fact for a run of this workspace. */
  const recordCostHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };
      const body = await parseBody(req);
      if (isApiError(body)) return { ok: false, error: body };

      const result = deps.cost.record(workspaceId, actor.userId, {
        executionKind: body.executionKind,
        executionId: body.executionId,
        category: body.category,
        basis: body.basis,
        amountMinor: body.amountMinor,
        currency: body.currency,
        source: body.source,
        occurredAt: body.occurredAt,
        idempotencyKey: body.idempotencyKey,
      });
      if (!result.ok) return { ok: false, error: fromCostError(result.error) };
      return { ok: true, value: ok({ costEvent: result.value }) };
    });

  /** One recorded cost fact, authorized against the caller's workspace. */
  const getCostHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };
      const id = param(req, "id");
      if (isApiError(id)) return { ok: false, error: id };

      const result = deps.cost.get(workspaceId, actor.userId, id);
      if (!result.ok) return { ok: false, error: fromCostError(result.error) };
      return { ok: true, value: ok(result.value) };
    });

  /** The workspace's recorded facts, optionally narrowed, newest first. */
  const listCostsHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };

      const result = deps.cost.list(workspaceId, actor.userId, {
        executionKind: req.query.executionKind,
        executionId: req.query.executionId,
        category: req.query.category,
        basis: req.query.basis,
      });
      if (!result.ok) return { ok: false, error: fromCostError(result.error) };
      return { ok: true, value: ok({ costEvents: result.value }) };
    });

  /**
   * What one execution cost — the phase's gate. The estimated and measured
   * sums are reported separately over the double-count-safe total, so a run
   * can show estimated **or** measured cost from stored facts alone.
   */
  const getExecutionCostHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };

      const result = deps.cost.executionCost(workspaceId, actor.userId, {
        executionKind: req.query.executionKind,
        executionId: req.query.executionId,
      });
      if (!result.ok) return { ok: false, error: fromCostError(result.error) };
      return { ok: true, value: ok(result.value) };
    });

  /**
   * The workspace's derived cost picture: totals, metric denominators, the
   * three derivable metrics and the three refused with their owning phase.
   * Every number here is recomputed from the facts on this request.
   */
  const getCostMetricsHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };

      const result = deps.cost.metrics(workspaceId, actor.userId);
      if (!result.ok) return { ok: false, error: fromCostError(result.error) };
      return { ok: true, value: ok(result.value) };
    });

  /** The cost vocabulary this deployment enforces, and everything it refuses. */
  const getCostPolicyHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };

      const result = deps.cost.policy(workspaceId, actor.userId);
      if (!result.ok) return { ok: false, error: fromCostError(result.error) };
      return { ok: true, value: ok(result.value) };
    });

  // -------------------------------------------------------------------------
  // Phase 17 — Revenue Dashboard
  // -------------------------------------------------------------------------

  /**
   * The workspace's whole dashboard, derived from its own rows on this
   * request.
   *
   * The workspace is a route parameter and the caller is the session: the
   * service re-authorizes that pair against storage, and every tile is
   * recomputed from the workspace's rows. Nothing a client sends can reach a
   * number here, because nothing a client sends is read.
   */
  const getDashboardHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };

      const result = deps.dashboard.snapshot(workspaceId, actor.userId);
      if (!result.ok) return { ok: false, error: fromDashboardError(result.error) };
      return { ok: true, value: ok(result.value) };
    });

  /**
   * The dashboard's published rule set: all fourteen tiles with their
   * derivations, the three refusals with their owning phase, and the four
   * questions the Blueprint asks of a home screen. Readable before a single
   * row exists.
   */
  const getDashboardPolicyHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };

      const result = deps.dashboard.policy(workspaceId, actor.userId);
      if (!result.ok) return { ok: false, error: fromDashboardError(result.error) };
      return { ok: true, value: ok(result.value) };
    });

  // -------------------------------------------------------------------------
  // Phase 18 — Agent System
  // -------------------------------------------------------------------------

  /**
   * The workspace's agent registry: twelve declared agents and the lifecycle
   * state this workspace has put each one in.
   *
   * The workspace is a route parameter and the caller is the session; the
   * service re-authorizes that pair against storage. Nothing a client sends is
   * read here, so no body or query field can reach a declaration.
   */
  const getAgentRegistryHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };

      const result = deps.agent.registry(workspaceId, actor.userId);
      if (!result.ok) return { ok: false, error: fromAgentError(result.error) };
      return { ok: true, value: ok(result.value) };
    });

  /**
   * One agent's full declaration and current state.
   *
   * The agent id is a route parameter. An id outside the twelve is a validation
   * error from the service rather than a 404 from the transport, because the
   * answer is the same whether or not such an agent exists anywhere.
   */
  const getAgentHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };
      const agentId = param(req, "agentId");
      if (isApiError(agentId)) return { ok: false, error: agentId };

      const result = deps.agent.describe(workspaceId, actor.userId, agentId);
      if (!result.ok) return { ok: false, error: fromAgentError(result.error) };
      return { ok: true, value: ok({ agent: result.value }) };
    });

  /**
   * Record a lifecycle decision about one agent.
   *
   * The target state is the only value a client supplies. The prior state, the
   * actor and the timestamp are the server's, and whether the transition is
   * permitted at all is decided by the published lifecycle table — so a forged
   * request cannot promote an agent, and cannot forge the record of who did.
   */
  const changeAgentStatusHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };
      const agentId = param(req, "agentId");
      if (isApiError(agentId)) return { ok: false, error: agentId };
      const body = await parseBody(req);
      if (isApiError(body)) return { ok: false, error: body };
      const status = typeof body.status === "string" ? body.status : "";

      const result = deps.agent.changeStatus(workspaceId, actor.userId, agentId, status);
      if (!result.ok) return { ok: false, error: fromAgentError(result.error) };
      return { ok: true, value: ok({ agent: result.value }) };
    });

  /**
   * The governance trail: who moved which agent, when, and from what state.
   *
   * These are decisions about the registry, not traces of agent runs — Phase 20
   * owns those, and this phase writes none.
   */
  const listAgentEventsHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };
      const requested = req.query.agentId;
      const agentId =
        typeof requested === "string" && requested.trim() !== "" ? requested : undefined;

      const result = deps.agent.events(workspaceId, actor.userId, agentId);
      if (!result.ok) return { ok: false, error: fromAgentError(result.error) };
      return { ok: true, value: ok({ events: result.value }) };
    });

  /**
   * The published rule set: the twelve declarations, the lifecycle, the tools
   * and the phase that executes each one, and the promotion rule that Phase 19
   * will unlock. Readable before a workspace has registered anything.
   */
  const getAgentPolicyHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };

      const result = deps.agent.policy(workspaceId, actor.userId);
      if (!result.ok) return { ok: false, error: fromAgentError(result.error) };
      return { ok: true, value: ok(result.value) };
    });

  // -------------------------------------------------------------------------
  // Phase 19 — Agent Evaluation
  // -------------------------------------------------------------------------

  /**
   * Open a new evaluation round for one agent.
   *
   * A round pins the agent's **declared version**, which the service reads from
   * the declaration table — the request contributes nothing at all, so there is
   * no version to forge. Opening a round is how a changed opinion is expressed:
   * judgements are never edited, so the previous round's evidence stays exactly
   * as recorded and simply stops being the live round.
   */
  const openAgentEvaluationRunHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };
      const agentId = param(req, "agentId");
      if (isApiError(agentId)) return { ok: false, error: agentId };

      const result = deps.evaluation.openRun(workspaceId, actor.userId, agentId);
      if (!result.ok) return { ok: false, error: fromEvaluationError(result.error) };
      return { ok: true, value: ok({ run: result.value }) };
    });

  /**
   * Record one judged observation.
   *
   * This is the only write in the phase, and its body is deliberately small: a
   * metric, a subject, and then either a `verdict` **or** a measured
   * `amountMinor` / `durationMs`. Nothing in the body can name the workspace,
   * the actor, the timestamp, the agent version, a rate, a total, a threshold,
   * a pass or an agent status — every one of those is derived server-side from
   * stored rows, so there is no request that can declare an agent evaluated.
   *
   * A replay of the same subject, metric and judgement returns the original
   * record rather than adding a second vote; a different judgement for a
   * subject already judged in this round is a `CONFLICT`, because judgements
   * are append-only and a changed mind opens a new round.
   */
  const recordAgentEvaluationHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };
      const agentId = param(req, "agentId");
      if (isApiError(agentId)) return { ok: false, error: agentId };
      const body = await parseBody(req);
      if (isApiError(body)) return { ok: false, error: body };

      const result = deps.evaluation.recordObservation(workspaceId, actor.userId, agentId, {
        metric: typeof body.metric === "string" ? body.metric : "",
        subjectId: typeof body.subjectId === "string" ? body.subjectId : "",
        ...(typeof body.verdict === "string" ? { verdict: body.verdict } : {}),
        ...(typeof body.amountMinor === "number" ? { amountMinor: body.amountMinor } : {}),
        ...(typeof body.durationMs === "number" ? { durationMs: body.durationMs } : {}),
        ...(typeof body.note === "string" ? { note: body.note } : {}),
      });
      if (!result.ok) return { ok: false, error: fromEvaluationError(result.error) };
      return { ok: true, value: ok({ observation: result.value }) };
    });

  /**
   * The whole evaluation for one agent version, derived on read.
   *
   * Read-only. An agent nobody has measured still returns every metric it
   * declares, each as `insufficient_evidence` with no value — never an empty
   * list and never a zero, because "not measured" and "measured as zero" are
   * different claims.
   */
  const getAgentEvaluationHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };
      const agentId = param(req, "agentId");
      if (isApiError(agentId)) return { ok: false, error: agentId };

      const result = deps.evaluation.report(workspaceId, actor.userId, agentId);
      if (!result.ok) return { ok: false, error: fromEvaluationError(result.error) };
      return { ok: true, value: ok(result.value) };
    });

  /**
   * The provenance trail: every round for this agent, and the judgements in the
   * live one — who judged what, about which agent version, and when.
   *
   * This is a record of human judgements about work already done. It is not a
   * trace of an agent run: `ROADMAP.md` §27 (Phase 20) owns execution traces,
   * token usage and tool-call trails, and nothing here carries any of them.
   */
  const listAgentEvaluationTrailHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };
      const agentId = param(req, "agentId");
      if (isApiError(agentId)) return { ok: false, error: agentId };

      const result = deps.evaluation.trail(workspaceId, actor.userId, agentId);
      if (!result.ok) return { ok: false, error: fromEvaluationError(result.error) };
      return { ok: true, value: ok(result.value) };
    });

  /**
   * The published bar: ROADMAP.md §26's thirteen metrics with their thresholds,
   * minimum samples and rationale, the three judgements, and the promotion
   * gate. Readable before a workspace has measured anything.
   */
  const getAgentEvaluationPolicyHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };

      const result = deps.evaluation.policy(workspaceId, actor.userId);
      if (!result.ok) return { ok: false, error: fromEvaluationError(result.error) };
      return { ok: true, value: ok(result.value) };
    });

  // -------------------------------------------------------------------------
  // Phase 20 — Agent Trace & Observability
  // -------------------------------------------------------------------------

  /**
   * Open a traced run for one agent.
   *
   * The request names an agent and nothing else. The agent **version** is read
   * from `@dealora/agent`'s declaration table, and the agent's `production`
   * state is re-read from the Phase 18 registry at this moment — so a body
   * containing `version`, `status`, `workspaceId`, `actorUserId` or `startedAt`
   * is ignored in full, and a run cannot be opened for an agent this workspace
   * has not promoted.
   *
   * Opening a run records no execution. It creates the container steps will be
   * appended to; a run with no steps reads as `open`, which asserts nothing.
   */
  const openAgentTraceRunHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };
      const agentId = param(req, "agentId");
      if (isApiError(agentId)) return { ok: false, error: agentId };

      const result = deps.trace.openRun(workspaceId, actor.userId, agentId);
      if (!result.ok) return { ok: false, error: fromTraceError(result.error) };
      return { ok: true, value: ok({ run: result.value }) };
    });

  /**
   * Record one step in one traced run.
   *
   * The body is the whole vocabulary of what a recorder may report: a
   * `stepId`, a `stage`, an `outcome` for that step, and optional facts about
   * it. There is no field in it — and no field on the route — that can name the
   * run's status, a sequence number, an attempt number, the agent version, the
   * workspace, the actor or a timestamp: all seven are derived server-side, and
   * `ROADMAP.md` §27's critical rule is therefore unreachable from a request.
   *
   * Re-sending the same `stepId` is how a **retry** is traced — storage counts
   * the attempts already recorded and allocates the next one — and re-sending
   * the identical attempt returns the original step rather than appending a
   * second one.
   */
  const recordAgentTraceStepHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };
      const runId = param(req, "runId");
      if (isApiError(runId)) return { ok: false, error: runId };
      const body = await parseBody(req);
      if (isApiError(body)) return { ok: false, error: body };

      const result = deps.trace.recordStep(workspaceId, actor.userId, runId, {
        stepId: typeof body.stepId === "string" ? body.stepId : "",
        stage: typeof body.stage === "string" ? body.stage : "",
        outcome: typeof body.outcome === "string" ? body.outcome : "",
        ...(typeof body.detail === "string" ? { detail: body.detail } : {}),
        ...(typeof body.tool === "string" ? { tool: body.tool } : {}),
        ...(typeof body.referenceId === "string" ? { referenceId: body.referenceId } : {}),
        ...(typeof body.errorCode === "string" ? { errorCode: body.errorCode } : {}),
        ...(typeof body.durationMs === "number" ? { durationMs: body.durationMs } : {}),
        ...(typeof body.modelProvider === "string" ? { modelProvider: body.modelProvider } : {}),
        ...(typeof body.modelName === "string" ? { modelName: body.modelName } : {}),
        ...(typeof body.inputTokens === "number" ? { inputTokens: body.inputTokens } : {}),
        ...(typeof body.outputTokens === "number" ? { outputTokens: body.outputTokens } : {}),
      });
      if (!result.ok) return { ok: false, error: fromTraceError(result.error) };
      return { ok: true, value: ok({ step: result.value }) };
    });

  /**
   * Close a traced run.
   *
   * **The body is not read**, and that is the point. A close carries a run id
   * and nothing else: there is no `status`, no `succeeded` flag and no
   * completion timestamp on the wire, so the outcome the caller gets back is
   * whatever the recorded steps prove. `ROADMAP.md` §27's critical rule holds
   * at the transport layer, not only in the domain.
   */
  const closeAgentTraceRunHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };
      const runId = param(req, "runId");
      if (isApiError(runId)) return { ok: false, error: runId };

      const result = deps.trace.closeRun(workspaceId, actor.userId, runId);
      if (!result.ok) return { ok: false, error: fromTraceError(result.error) };
      return { ok: true, value: ok({ run: result.value }) };
    });

  /**
   * One whole run: its chain, its derived status, its usage and its cost.
   *
   * Read-only and derived on every request. `status` and `derivedStatus` are
   * printed as separate fields so a reader can see that the recorded verdict and
   * the evidence behind it agree; cost is `null` when no Phase 16 fact exists
   * for the run, never a zero.
   */
  const getAgentTraceHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };
      const runId = param(req, "runId");
      if (isApiError(runId)) return { ok: false, error: runId };

      const result = deps.trace.trace(workspaceId, actor.userId, runId);
      if (!result.ok) return { ok: false, error: fromTraceError(result.error) };
      return { ok: true, value: ok(result.value) };
    });

  /**
   * The recorded step trail for one run, oldest first.
   *
   * Ordered by the sequence storage allocated, not by timestamp — two steps
   * recorded in the same millisecond are ordinary and a timestamp-only order
   * would be ambiguous between them. An empty run returns an empty list rather
   * than a refusal: "this run recorded nothing yet" is a real answer.
   */
  const listAgentTraceStepsHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };
      const runId = param(req, "runId");
      if (isApiError(runId)) return { ok: false, error: runId };

      const result = deps.trace.steps(workspaceId, actor.userId, runId);
      if (!result.ok) return { ok: false, error: fromTraceError(result.error) };
      return { ok: true, value: ok({ steps: result.value }) };
    });

  /**
   * Every traced run, optionally narrowed to one agent.
   *
   * Read-only. A workspace that has traced nothing gets an empty list, which
   * is a real state rather than a missing page.
   */
  const listAgentTraceRunsHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };
      const requested = req.query.agentId;
      const agentId =
        typeof requested === "string" && requested.trim() !== "" ? requested : undefined;

      const result = deps.trace.runs(workspaceId, actor.userId, agentId);
      if (!result.ok) return { ok: false, error: fromTraceError(result.error) };
      return { ok: true, value: ok({ runs: result.value }) };
    });

  /**
   * The published bar: the seven stages, the three outcomes, the five run
   * statuses, the nine tracked dimensions, the eighteen tools, and the negative
   * space — including what this phase does not execute. Readable before a
   * workspace has traced anything.
   */
  const getAgentTracePolicyHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };

      const result = deps.trace.policy(workspaceId, actor.userId);
      if (!result.ok) return { ok: false, error: fromTraceError(result.error) };
      return { ok: true, value: ok(result.value) };
    });

  // -------------------------------------------------------------------------
  // Phase 22 — Experiment Engine
  //
  // These handlers answer ROADMAP.md §29: declare controlled comparisons,
  // open and freeze their windows, and read the derived comparison — sample
  // size, conversion, confidence, cost and revenue impact — without ever
  // being able to hand the engine a winner. The lifecycle routes carry the
  // experiment id and the session and nothing else: statuses, timestamps and
  // decisions are the server's, which is what makes §29's critical rule hold
  // at the transport layer.
  // -------------------------------------------------------------------------

  /** Declare one controlled experiment in this workspace. */
  const createExperimentHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };
      const body = await parseBody(req);
      if (isApiError(body)) return { ok: false, error: body };

      const result = deps.experiment.create(workspaceId, actor.userId, {
        name: body.name,
        metric: body.metric,
        durationDays: body.durationDays,
      });
      if (!result.ok) return { ok: false, error: fromExperimentError(result.error) };
      return { ok: true, value: ok({ experiment: result.value }) };
    });

  /** Pin one arm of the comparison to an exact immutable draft. */
  const addExperimentArmHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };
      const experimentId = param(req, "experimentId");
      if (isApiError(experimentId)) return { ok: false, error: experimentId };
      const body = await parseBody(req);
      if (isApiError(body)) return { ok: false, error: body };

      const result = deps.experiment.addArm(workspaceId, actor.userId, experimentId, {
        draftId: body.draftId,
        label: body.label,
      });
      if (!result.ok) return { ok: false, error: fromExperimentError(result.error) };
      return { ok: true, value: ok({ arm: result.value }) };
    });

  /** Every experiment in this workspace, oldest declaration first. */
  const listExperimentsHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };

      const result = deps.experiment.list(workspaceId, actor.userId, req.query.status);
      if (!result.ok) return { ok: false, error: fromExperimentError(result.error) };
      return { ok: true, value: ok({ experiments: result.value }) };
    });

  /**
   * One experiment read back complete — the declaration, the arms, the
   * lifecycle trail and the whole derived comparison. Every number here is
   * recomputed from this request's rows; the read stores nothing.
   */
  const getExperimentHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };
      const experimentId = param(req, "experimentId");
      if (isApiError(experimentId)) return { ok: false, error: experimentId };

      const result = deps.experiment.get(workspaceId, actor.userId, experimentId);
      if (!result.ok) return { ok: false, error: fromExperimentError(result.error) };
      return { ok: true, value: ok(result.value) };
    });

  /** Open the declared window. The open instant is the server's clock. */
  const startExperimentHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };
      const experimentId = param(req, "experimentId");
      if (isApiError(experimentId)) return { ok: false, error: experimentId };

      // No body is read: there is no field a caller could contribute here.
      const result = deps.experiment.start(workspaceId, actor.userId, experimentId);
      if (!result.ok) return { ok: false, error: fromExperimentError(result.error) };
      return { ok: true, value: ok({ experiment: result.value }) };
    });

  /**
   * Freeze the window. Like the Phase 20 close route, this handler carries a
   * run id and does not read its body at all — there is no winner argument to
   * pass, because the decision is derived on read and never accepted.
   */
  const closeExperimentHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };
      const experimentId = param(req, "experimentId");
      if (isApiError(experimentId)) return { ok: false, error: experimentId };

      const result = deps.experiment.close(workspaceId, actor.userId, experimentId);
      if (!result.ok) return { ok: false, error: fromExperimentError(result.error) };
      return { ok: true, value: ok({ experiment: result.value }) };
    });

  /** Withdraw the experiment, keeping every collected row for audit. */
  const cancelExperimentHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };
      const experimentId = param(req, "experimentId");
      if (isApiError(experimentId)) return { ok: false, error: experimentId };
      const body = await parseBody(req);
      if (isApiError(body)) return { ok: false, error: body };

      const result = deps.experiment.cancel(workspaceId, actor.userId, experimentId, {
        reason: body.reason ?? null,
      });
      if (!result.ok) return { ok: false, error: fromExperimentError(result.error) };
      return { ok: true, value: ok({ experiment: result.value }) };
    });

  /** One experiment's lifecycle trail, oldest first. */
  const getExperimentHistoryHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };
      const experimentId = param(req, "experimentId");
      if (isApiError(experimentId)) return { ok: false, error: experimentId };

      const result = deps.experiment.history(workspaceId, actor.userId, experimentId);
      if (!result.ok) return { ok: false, error: fromExperimentError(result.error) };
      return { ok: true, value: ok({ events: result.value }) };
    });

  /** The experiment rule set this deployment publishes, and what it refuses. */
  const getExperimentPolicyHandler: ApiHandler = (req) =>
    authenticated(req, deps, async (actor) => {
      const workspaceId = param(req, "workspaceId");
      if (isApiError(workspaceId)) return { ok: false, error: workspaceId };

      const result = deps.experiment.policy(workspaceId, actor.userId);
      if (!result.ok) return { ok: false, error: fromExperimentError(result.error) };
      return { ok: true, value: ok(result.value) };
    });

  return {
    signupHandler,
    authenticateHandler,
    listWorkspacesHandler,
    getWorkspaceHandler,
    updateWorkspaceHandler,
    meHandler,
    getCompanyHandler,
    upsertCompanyHandler,
    createOfferHandler,
    listOffersHandler,
    updateOfferHandler,
    deleteOfferHandler,
    upsertIcpHandler,
    getIcpHandler,
    createPersonaHandler,
    listPersonasHandler,
    upsertPositioningHandler,
    getPositioningHandler,
    upsertBrandVoiceHandler,
    getBrandVoiceHandler,
    createClaimHandler,
    listClaimsHandler,
    updateClaimHandler,
    approveClaimHandler,
    getBusinessContextHandler,
    createRevenueGoalHandler,
    listRevenueGoalsHandler,
    getRevenueGoalHandler,
    updateRevenueGoalHandler,
    changeRevenueGoalStatusHandler,
    archiveRevenueGoalHandler,
    revenueGoalHistoryHandler,
    parseRevenueGoalInputHandler,
    createRevenueGoalFromTextHandler,
    compileRevenuePlanHandler,
    listRevenuePlansHandler,
    getRevenuePlanHandler,
    getRevenuePlanHistoryHandler,
    changeRevenuePlanStatusHandler,
    archiveRevenuePlanHandler,
    createAccountHandler,
    listAccountsHandler,
    getAccountHandler,
    updateAccountHandler,
    archiveAccountHandler,
    listPlanAccountsHandler,
    importAccountsHandler,
    importContactsHandler,
    createContactHandler,
    listAccountContactsHandler,
    listContactsHandler,
    getContactHandler,
    updateContactHandler,
    archiveContactHandler,
    createResearchRequestHandler,
    getResearchRequestHandler,
    listResearchRequestsHandler,
    runResearchRequestHandler,
    getResearchFindingsHandler,
    cancelResearchRequestHandler,
    createEvidenceFromFindingHandler,
    recordUserEvidenceHandler,
    getEvidenceHandler,
    listEvidenceHandler,
    changeEvidenceStatusHandler,
    supersedeEvidenceHandler,
    getAccountClaimHandler,
    listAccountClaimsHandler,
    listClaimEvidenceHandler,
    changeAccountClaimStatusHandler,
    createQualificationHandler,
    getQualificationCriteriaHandler,
    getQualificationHandler,
    listQualificationsHandler,
    getQualificationExplanationHandler,
    createPersonalizedDraftHandler,
    getPersonalizationRendererHandler,
    getPersonalizedDraftHandler,
    listPersonalizedDraftsHandler,
    getPersonalizedDraftEvidenceHandler,
    createApprovalRequestHandler,
    decideApprovalRequestHandler,
    cancelApprovalRequestHandler,
    getApprovalRequestHandler,
    previewApprovalRequestHandler,
    listApprovalRequestsHandler,
    approvalHistoryHandler,
    getApprovalPolicyHandler,
    createOutboundActionHandler,
    sendOutboundActionHandler,
    cancelOutboundActionHandler,
    getOutboundActionHandler,
    listOutboundActionsHandler,
    outboundActionHistoryHandler,
    createOutboundSuppressionHandler,
    listOutboundSuppressionsHandler,
    getOutboundPolicyHandler,

    // -------------------------------------------------------------------------
    // Phase 12 — Conversation Engine
    // -------------------------------------------------------------------------
    createInboundMessageHandler,
    getInboundMessageHandler,
    listInboundMessagesHandler,
    listConversationClassificationsHandler,
    conversationHistoryHandler,
    getConversationPolicyHandler,

    // -------------------------------------------------------------------------
    // Phase 13 — Meeting Workflow
    // -------------------------------------------------------------------------
    recommendMeetingHandler,
    listMeetingsHandler,
    getMeetingHandler,
    decideMeetingHandler,
    bookMeetingHandler,
    prepareMeetingBriefHandler,
    getMeetingHistoryHandler,
    getMeetingPolicyHandler,

    // -------------------------------------------------------------------------
    // Phase 14 — Next Best Action Engine
    // -------------------------------------------------------------------------
    recommendNextActionHandler,
    recommendWorkspaceActionsHandler,
    recordNextActionHandler,
    listNextActionsHandler,
    getNextActionHandler,
    getNextActionPolicyHandler,

    // -------------------------------------------------------------------------
    // Phase 15 — Revenue Graph
    // -------------------------------------------------------------------------
    getRevenueGraphHandler,
    traceOpportunityHandler,
    getRevenueGraphPolicyHandler,

    // -------------------------------------------------------------------------
    // Phase 16 — Cost Engine
    // -------------------------------------------------------------------------
    recordCostHandler,
    getCostHandler,
    listCostsHandler,
    getExecutionCostHandler,
    getCostMetricsHandler,
    getCostPolicyHandler,

    // -------------------------------------------------------------------------
    // Phase 17 — Revenue Dashboard
    // -------------------------------------------------------------------------
    getDashboardHandler,
    getDashboardPolicyHandler,

    // -------------------------------------------------------------------------
    // Phase 18 — Agent System
    // -------------------------------------------------------------------------
    getAgentRegistryHandler,
    getAgentHandler,
    changeAgentStatusHandler,
    listAgentEventsHandler,
    getAgentPolicyHandler,
    openAgentEvaluationRunHandler,
    recordAgentEvaluationHandler,
    getAgentEvaluationHandler,
    listAgentEvaluationTrailHandler,
    getAgentEvaluationPolicyHandler,

    openAgentTraceRunHandler,
    recordAgentTraceStepHandler,
    closeAgentTraceRunHandler,
    getAgentTraceHandler,
    listAgentTraceStepsHandler,
    listAgentTraceRunsHandler,
    getAgentTracePolicyHandler,

    // -------------------------------------------------------------------------
    // Phase 22 — Experiment Engine
    // -------------------------------------------------------------------------
    createExperimentHandler,
    getExperimentHandler,
    listExperimentsHandler,
    addExperimentArmHandler,
    startExperimentHandler,
    closeExperimentHandler,
    cancelExperimentHandler,
    getExperimentHistoryHandler,
    getExperimentPolicyHandler,
  };
}

/** Strip the password hash from any user leaving the API boundary. */
export function publicUser(user: {
  id: string;
  email: string;
  displayName: string;
  role: string;
  createdAt: string;
  updatedAt: string;
}): Record<string, unknown> {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

export type { BrandVoice, BusinessProfile, Claim, Icp, Offer, Persona, Positioning };
