import type { Result } from "@dealora/core";
import { err, ok } from "@dealora/core";
import type {
  BrandVoice,
  BusinessProfile,
  Claim,
  ClaimCategory,
  EntityId,
  Icp,
  Offer,
  Persona,
  Positioning,
  User,
} from "@dealora/db";

import { brainError } from "./types.js";
import type { BrainError, BusinessContext } from "./types.js";
import {
  Issues,
  LIMITS,
  optionalAmount,
  optionalCurrency,
  optionalString,
  optionalUrl,
  requireEnum,
  requireString,
  requireStringList,
  setOptional,
  setOptionalList,
} from "./validation.js";

export * from "./types.js";

/** Every storage method the Business Brain depends on. */
export interface BrainRepository {
  authorize(workspaceId: EntityId, userId: EntityId): Result<unknown, { code: string }>;
  getBusinessProfileFor(
    workspaceId: EntityId,
    userId: EntityId,
  ): Result<BusinessProfile | null, { code: string }>;
  createBusinessProfile(input: {
    workspaceId: EntityId;
    ownerId: EntityId;
    name: string;
    description: string;
    website?: string | null;
    type?: string | null;
    industry?: string | null;
    size?: string | null;
    market?: string | null;
  }): Result<BusinessProfile, { code: string }>;
  updateBusinessProfile(
    id: EntityId,
    input: {
      workspaceId: EntityId;
      name?: string;
      description?: string;
      website?: string | null;
      type?: string | null;
      industry?: string | null;
      size?: string | null;
      market?: string | null;
    },
  ): Result<BusinessProfile, { code: string }>;

  createOffer(input: {
    workspaceId: EntityId;
    userId: EntityId;
    name: string;
    description: string;
    targetCustomer?: string | null;
    problemSolved?: string | null;
    outcome?: string | null;
    pricing?: Offer["pricing"];
    deliveryModel?: string | null;
    status?: Offer["status"];
  }): Result<Offer, { code: string }>;
  listOffers(workspaceId: EntityId, userId: EntityId): Result<Offer[], { code: string }>;
  getOffer(id: EntityId, userId: EntityId): Result<Offer, { code: string }>;
  updateOffer(
    id: EntityId,
    input: { userId: EntityId } & Partial<Omit<Offer, "id" | "workspaceId" | "createdAt">>,
  ): Result<Offer, { code: string }>;
  deleteOffer(id: EntityId, userId: EntityId): Result<void, { code: string }>;

  upsertIcp(
    workspaceId: EntityId,
    userId: EntityId,
    input: {
      industries?: string[];
      companySizes?: string[];
      geographies?: string[];
      businessModels?: string[];
      characteristics?: string[];
      disqualifiers?: string[];
      notes?: string | null;
    },
  ): Result<Icp, { code: string }>;
  getIcp(workspaceId: EntityId, userId: EntityId): Result<Icp | null, { code: string }>;

  createPersona(
    workspaceId: EntityId,
    userId: EntityId,
    input: {
      title: string;
      responsibilities?: string[];
      painPoints?: string[];
      goals?: string[];
      buyingContext?: string | null;
    },
  ): Result<Persona, { code: string }>;
  listPersonas(workspaceId: EntityId, userId: EntityId): Result<Persona[], { code: string }>;
  updatePersona(
    id: EntityId,
    input: { userId: EntityId } & Partial<Omit<Persona, "id" | "workspaceId" | "createdAt">>,
  ): Result<Persona, { code: string }>;
  deletePersona(id: EntityId, userId: EntityId): Result<void, { code: string }>;

  upsertPositioning(
    workspaceId: EntityId,
    userId: EntityId,
    input: {
      statement: string;
      differentiators?: string[];
      approvedValuePropositions?: string[];
      competitorContext?: string[];
    },
  ): Result<Positioning, { code: string }>;
  getPositioning(
    workspaceId: EntityId,
    userId: EntityId,
  ): Result<Positioning | null, { code: string }>;

  upsertBrandVoice(
    workspaceId: EntityId,
    userId: EntityId,
    input: {
      tone: string[];
      style?: string | null;
      terminology?: string[];
      constraints?: string[];
    },
  ): Result<BrandVoice, { code: string }>;
  getBrandVoice(
    workspaceId: EntityId,
    userId: EntityId,
  ): Result<BrandVoice | null, { code: string }>;

  createClaim(input: {
    workspaceId: EntityId;
    userId: EntityId;
    text: string;
    category: ClaimCategory;
    status?: Claim["status"];
    sourceNote?: string | null;
  }): Result<Claim, { code: string }>;
  listClaims(
    workspaceId: EntityId,
    userId: EntityId,
    filter?: { status?: Claim["status"] },
  ): Result<Claim[], { code: string }>;
  getClaim(id: EntityId, userId: EntityId): Result<Claim, { code: string }>;
  updateClaim(
    id: EntityId,
    input: { userId: EntityId } & Partial<Omit<Claim, "id" | "workspaceId" | "createdAt">>,
  ): Result<Claim, { code: string }>;
  approveClaim(id: EntityId, userId: EntityId): Result<Claim, { code: string }>;
  deleteClaim(id: EntityId, userId: EntityId): Result<void, { code: string }>;
}

/** Allowed claim statuses and categories — closed enums, no free strings. */
export const CLAIM_STATUSES = ["approved", "unverified", "restricted"] as const;
export const CLAIM_CATEGORIES = [
  "capability",
  "pricing",
  "result",
  "case_study",
  "testimonial",
  "certification",
  "partnership",
  "guarantee",
  "other",
] as const;
export const OFFER_STATUSES = ["draft", "active", "retired"] as const;
export const PRICING_MODELS = ["one_time", "recurring", "usage_based", "custom"] as const;

/** Translate a storage code into a safe domain error. */
function fromStorage(code: string, fallbackMessage: string): BrainError {
  switch (code) {
    case "NOT_FOUND":
      return brainError("NOT_FOUND", fallbackMessage);
    case "UNAUTHORIZED":
      return brainError("UNAUTHORIZED", "workspace access denied");
    case "CONFLICT":
      return brainError("CONFLICT", fallbackMessage);
    case "INVALID":
      return brainError("VALIDATION_ERROR", fallbackMessage);
    default:
      // Never surface raw storage messages.
      return brainError("UNAVAILABLE", "storage unavailable");
  }
}

function fail(issues: Issues, message = "validation failed"): BrainError {
  return brainError("VALIDATION_ERROR", message, issues.all());
}

/** Parsed, validated pricing input. */
type PricingInput = NonNullable<Offer["pricing"]>;

function parsePricing(issues: Issues, value: unknown): Offer["pricing"] | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "object") {
    issues.add("pricing", "pricing must be an object");
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const model = requireEnum(issues, "pricing.model", raw.model, PRICING_MODELS);
  const amountMin = optionalAmount(raw.amountMin, "pricing.amountMin", issues);
  const amountMax = optionalAmount(raw.amountMax, "pricing.amountMax", issues);
  const currency = optionalCurrency(issues, "pricing.currency", raw.currency);
  const notes = optionalString(issues, "pricing.notes", raw.notes, LIMITS.shortText);
  if (raw.approved !== undefined && typeof raw.approved !== "boolean") {
    issues.add("pricing.approved", "pricing.approved must be a boolean");
  }
  if (!model) return undefined;
  if (
    amountMin !== undefined &&
    amountMin !== null &&
    amountMax !== undefined &&
    amountMax !== null &&
    amountMin > amountMax
  ) {
    issues.add("pricing.amountMin", "pricing.amountMin must not exceed pricing.amountMax");
  }
  const parsed: PricingInput = {
    model,
    amountMin: amountMin ?? null,
    amountMax: amountMax ?? null,
    currency: currency ?? null,
    notes: notes ?? null,
    // Pricing must be explicitly approved before an agent may state it.
    approved: raw.approved === true,
  };
  return parsed;
}

export type { PricingInput };

/**
 * The Business Brain application service.
 *
 * Responsibilities:
 * - Validate all input at the application boundary.
 * - Resolve authorization from the authenticated user id on every call.
 * - Enforce claim safety so user-entered text is never silently trusted.
 * - Assemble the deterministic context snapshot for future agents.
 *
 * The service never exposes storage errors to callers.
 */
export class BusinessBrainService {
  constructor(private readonly repo: BrainRepository) {}

  /**
   * Confirm the caller may act in this workspace.
   *
   * `userId` always comes from the resolved session, never from the request
   * body, so a client cannot assert membership.
   */
  private guard(workspaceId: EntityId, userId: EntityId): Result<true, BrainError> {
    if (!workspaceId || typeof workspaceId !== "string" || workspaceId.trim() === "") {
      return err(brainError("VALIDATION_ERROR", "workspace id is required"));
    }
    if (!userId || typeof userId !== "string") {
      return err(brainError("UNAUTHORIZED", "authentication required"));
    }
    const auth = this.repo.authorize(workspaceId, userId);
    if (!auth.ok) return err(fromStorage(auth.error.code, "workspace not found"));
    return ok(true);
  }

  // --- Company (Phase 1 business profile) ---

  getCompany(workspaceId: EntityId, userId: EntityId): Result<BusinessProfile | null, BrainError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;

    const profile = this.repo.getBusinessProfileFor(workspaceId, userId);
    if (!profile.ok) return err(fromStorage(profile.error.code, "company not found"));
    return ok(profile.value);
  }

  upsertCompany(
    workspaceId: EntityId,
    userId: EntityId,
    input: unknown,
  ): Result<BusinessProfile, BrainError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;

    const issues = new Issues();
    const raw = (input ?? {}) as Record<string, unknown>;
    const name = requireString(issues, "name", raw.name, LIMITS.shortText);
    const description = requireString(issues, "description", raw.description, LIMITS.longText);
    const website = optionalUrl(issues, "website", raw.website);
    const type = optionalString(issues, "type", raw.type, LIMITS.shortText);
    const market = optionalString(issues, "market", raw.market, LIMITS.shortText);
    const industry = optionalString(issues, "industry", raw.industry, LIMITS.shortText);
    const size = optionalString(issues, "size", raw.size, LIMITS.shortText);
    if (issues.length > 0) return err(fail(issues));
    if (!name || !description) return err(fail(issues));

    const existing = this.repo.getBusinessProfileFor(workspaceId, userId);
    if (!existing.ok) return err(fromStorage(existing.error.code, "company not found"));

    if (existing.value) {
      // Update in place: the company stays a single canonical record.
      const patch: Parameters<BrainRepository["updateBusinessProfile"]>[1] = {
        workspaceId,
        name,
        description,
      };
      if (website !== undefined) patch.website = website;
      if (type !== undefined) patch.type = type;
      if (market !== undefined) patch.market = market;
      if (industry !== undefined) patch.industry = industry;
      if (size !== undefined) patch.size = size;
      const updated = this.repo.updateBusinessProfile(existing.value.id, patch);
      if (!updated.ok) return err(fromStorage(updated.error.code, "company update failed"));
      return ok(updated.value);
    }

    const created = this.repo.createBusinessProfile({
      workspaceId,
      ownerId: userId,
      name,
      description,
      website: website ?? null,
      type: type ?? null,
      market: market ?? null,
      industry: industry ?? null,
      size: size ?? null,
    });
    if (!created.ok) return err(fromStorage(created.error.code, "company creation failed"));
    return ok(created.value);
  }

  // --- Offers ---

  createOffer(workspaceId: EntityId, userId: EntityId, input: unknown): Result<Offer, BrainError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;

    const issues = new Issues();
    const raw = (input ?? {}) as Record<string, unknown>;
    const name = requireString(issues, "name", raw.name, LIMITS.shortText);
    const description = requireString(issues, "description", raw.description, LIMITS.longText);
    const targetCustomer = optionalString(
      issues,
      "targetCustomer",
      raw.targetCustomer,
      LIMITS.longText,
    );
    const problemSolved = optionalString(
      issues,
      "problemSolved",
      raw.problemSolved,
      LIMITS.longText,
    );
    const outcome = optionalString(issues, "outcome", raw.outcome, LIMITS.longText);
    const deliveryModel = optionalString(
      issues,
      "deliveryModel",
      raw.deliveryModel,
      LIMITS.shortText,
    );
    const status =
      raw.status === undefined ? null : requireEnum(issues, "status", raw.status, OFFER_STATUSES);
    const pricing = parsePricing(issues, raw.pricing);
    if (issues.length > 0) return err(fail(issues));
    if (!name || !description) return err(fail(issues));

    const created = this.repo.createOffer({
      workspaceId,
      userId,
      name,
      description,
      targetCustomer: targetCustomer ?? null,
      problemSolved: problemSolved ?? null,
      outcome: outcome ?? null,
      deliveryModel: deliveryModel ?? null,
      pricing: pricing ?? null,
      status: status ?? "draft",
    });
    if (!created.ok) return err(fromStorage(created.error.code, "offer creation failed"));
    return ok(created.value);
  }

  listOffers(workspaceId: EntityId, userId: EntityId): Result<Offer[], BrainError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;
    const offers = this.repo.listOffers(workspaceId, userId);
    if (!offers.ok) return err(fromStorage(offers.error.code, "offers unavailable"));
    return ok(offers.value);
  }

  getOffer(id: EntityId, userId: EntityId): Result<Offer, BrainError> {
    if (!id || typeof id !== "string") {
      return err(brainError("VALIDATION_ERROR", "offer id is required"));
    }
    const offer = this.repo.getOffer(id, userId);
    if (!offer.ok) return err(fromStorage(offer.error.code, "offer not found"));
    return ok(offer.value);
  }

  updateOffer(id: EntityId, userId: EntityId, input: unknown): Result<Offer, BrainError> {
    if (!id || typeof id !== "string") {
      return err(brainError("VALIDATION_ERROR", "offer id is required"));
    }
    const issues = new Issues();
    const raw = (input ?? {}) as Record<string, unknown>;
    const patch: Parameters<BrainRepository["updateOffer"]>[1] = { userId };

    const name = optionalString(issues, "name", raw.name, LIMITS.shortText);
    const description = optionalString(issues, "description", raw.description, LIMITS.longText);
    const targetCustomer = optionalString(
      issues,
      "targetCustomer",
      raw.targetCustomer,
      LIMITS.longText,
    );
    const problemSolved = optionalString(
      issues,
      "problemSolved",
      raw.problemSolved,
      LIMITS.longText,
    );
    const outcome = optionalString(issues, "outcome", raw.outcome, LIMITS.longText);
    const deliveryModel = optionalString(
      issues,
      "deliveryModel",
      raw.deliveryModel,
      LIMITS.shortText,
    );
    setOptional(patch, "name", name);
    setOptional(patch, "description", description);
    setOptional(patch, "targetCustomer", targetCustomer);
    setOptional(patch, "problemSolved", problemSolved);
    setOptional(patch, "outcome", outcome);
    setOptional(patch, "deliveryModel", deliveryModel);
    if (raw.status !== undefined) {
      const status = requireEnum(issues, "status", raw.status, OFFER_STATUSES);
      if (status) patch.status = status;
    }
    if (raw.pricing !== undefined) {
      const pricing = parsePricing(issues, raw.pricing);
      if (pricing !== undefined) patch.pricing = pricing;
    }
    if (issues.length > 0) return err(fail(issues));

    const updated = this.repo.updateOffer(id, patch);
    if (!updated.ok) return err(fromStorage(updated.error.code, "offer not found"));
    return ok(updated.value);
  }

  deleteOffer(id: EntityId, userId: EntityId): Result<void, BrainError> {
    if (!id || typeof id !== "string") {
      return err(brainError("VALIDATION_ERROR", "offer id is required"));
    }
    const removed = this.repo.deleteOffer(id, userId);
    if (!removed.ok) return err(fromStorage(removed.error.code, "offer not found"));
    return ok(undefined);
  }

  // --- ICP ---

  upsertIcp(workspaceId: EntityId, userId: EntityId, input: unknown): Result<Icp, BrainError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;

    const issues = new Issues();
    const raw = (input ?? {}) as Record<string, unknown>;
    const patch: Parameters<BrainRepository["upsertIcp"]>[2] = {};
    if (raw.industries !== undefined)
      setOptionalList(
        patch,
        "industries",
        requireStringList(issues, "industries", raw.industries) ?? undefined,
      );
    if (raw.companySizes !== undefined)
      setOptionalList(
        patch,
        "companySizes",
        requireStringList(issues, "companySizes", raw.companySizes) ?? undefined,
      );
    if (raw.geographies !== undefined)
      setOptionalList(
        patch,
        "geographies",
        requireStringList(issues, "geographies", raw.geographies) ?? undefined,
      );
    if (raw.businessModels !== undefined)
      setOptionalList(
        patch,
        "businessModels",
        requireStringList(issues, "businessModels", raw.businessModels) ?? undefined,
      );
    if (raw.characteristics !== undefined)
      setOptionalList(
        patch,
        "characteristics",
        requireStringList(issues, "characteristics", raw.characteristics) ?? undefined,
      );
    if (raw.disqualifiers !== undefined)
      setOptionalList(
        patch,
        "disqualifiers",
        requireStringList(issues, "disqualifiers", raw.disqualifiers) ?? undefined,
      );
    setOptional(patch, "notes", optionalString(issues, "notes", raw.notes, LIMITS.longText));
    if (issues.length > 0) return err(fail(issues));

    const saved = this.repo.upsertIcp(workspaceId, userId, patch);
    if (!saved.ok) return err(fromStorage(saved.error.code, "icp save failed"));
    return ok(saved.value);
  }

  getIcp(workspaceId: EntityId, userId: EntityId): Result<Icp | null, BrainError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;
    const icp = this.repo.getIcp(workspaceId, userId);
    if (!icp.ok) return err(fromStorage(icp.error.code, "icp unavailable"));
    return ok(icp.value);
  }

  // --- Personas ---

  createPersona(
    workspaceId: EntityId,
    userId: EntityId,
    input: unknown,
  ): Result<Persona, BrainError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;

    const issues = new Issues();
    const raw = (input ?? {}) as Record<string, unknown>;
    const title = requireString(issues, "title", raw.title, LIMITS.shortText);
    const responsibilities =
      raw.responsibilities === undefined
        ? undefined
        : (requireStringList(issues, "responsibilities", raw.responsibilities) ?? undefined);
    const painPoints =
      raw.painPoints === undefined
        ? undefined
        : (requireStringList(issues, "painPoints", raw.painPoints) ?? undefined);
    const goals =
      raw.goals === undefined
        ? undefined
        : (requireStringList(issues, "goals", raw.goals) ?? undefined);
    const buyingContext = optionalString(
      issues,
      "buyingContext",
      raw.buyingContext,
      LIMITS.longText,
    );
    if (issues.length > 0) return err(fail(issues));
    if (!title) return err(fail(issues));

    const created = this.repo.createPersona(workspaceId, userId, {
      title,
      responsibilities: responsibilities ?? [],
      painPoints: painPoints ?? [],
      goals: goals ?? [],
      buyingContext: buyingContext ?? null,
    });
    if (!created.ok) return err(fromStorage(created.error.code, "persona creation failed"));
    return ok(created.value);
  }

  listPersonas(workspaceId: EntityId, userId: EntityId): Result<Persona[], BrainError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;
    const personas = this.repo.listPersonas(workspaceId, userId);
    if (!personas.ok) return err(fromStorage(personas.error.code, "personas unavailable"));
    return ok(personas.value);
  }

  updatePersona(id: EntityId, userId: EntityId, input: unknown): Result<Persona, BrainError> {
    if (!id || typeof id !== "string") {
      return err(brainError("VALIDATION_ERROR", "persona id is required"));
    }
    const issues = new Issues();
    const raw = (input ?? {}) as Record<string, unknown>;
    const patch: Parameters<BrainRepository["updatePersona"]>[1] = { userId };
    setOptional(patch, "title", optionalString(issues, "title", raw.title, LIMITS.shortText));
    if (raw.responsibilities !== undefined)
      setOptionalList(
        patch,
        "responsibilities",
        requireStringList(issues, "responsibilities", raw.responsibilities) ?? [],
      );
    if (raw.painPoints !== undefined)
      setOptionalList(
        patch,
        "painPoints",
        requireStringList(issues, "painPoints", raw.painPoints) ?? [],
      );
    if (raw.goals !== undefined)
      setOptionalList(patch, "goals", requireStringList(issues, "goals", raw.goals) ?? []);
    setOptional(
      patch,
      "buyingContext",
      optionalString(issues, "buyingContext", raw.buyingContext, LIMITS.longText),
    );
    if (issues.length > 0) return err(fail(issues));

    const updated = this.repo.updatePersona(id, patch);
    if (!updated.ok) return err(fromStorage(updated.error.code, "persona not found"));
    return ok(updated.value);
  }

  deletePersona(id: EntityId, userId: EntityId): Result<void, BrainError> {
    if (!id || typeof id !== "string") {
      return err(brainError("VALIDATION_ERROR", "persona id is required"));
    }
    const removed = this.repo.deletePersona(id, userId);
    if (!removed.ok) return err(fromStorage(removed.error.code, "persona not found"));
    return ok(undefined);
  }

  // --- Positioning ---

  upsertPositioning(
    workspaceId: EntityId,
    userId: EntityId,
    input: unknown,
  ): Result<Positioning, BrainError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;

    const issues = new Issues();
    const raw = (input ?? {}) as Record<string, unknown>;
    const statement = requireString(issues, "statement", raw.statement, LIMITS.longText);
    const differentiators =
      raw.differentiators === undefined
        ? undefined
        : (requireStringList(issues, "differentiators", raw.differentiators) ?? undefined);
    const approvedValuePropositions =
      raw.approvedValuePropositions === undefined
        ? undefined
        : (requireStringList(issues, "approvedValuePropositions", raw.approvedValuePropositions) ??
          undefined);
    const competitorContext =
      raw.competitorContext === undefined
        ? undefined
        : (requireStringList(issues, "competitorContext", raw.competitorContext) ?? undefined);
    if (issues.length > 0) return err(fail(issues));
    if (!statement) return err(fail(issues));

    // Only fields the caller actually supplied are changed, so a partial edit
    // cannot silently wipe existing context.
    const patch: Parameters<BrainRepository["upsertPositioning"]>[2] = { statement };
    setOptionalList(patch, "differentiators", differentiators);
    setOptionalList(patch, "approvedValuePropositions", approvedValuePropositions);
    setOptionalList(patch, "competitorContext", competitorContext);
    const saved = this.repo.upsertPositioning(workspaceId, userId, patch);
    if (!saved.ok) return err(fromStorage(saved.error.code, "positioning save failed"));
    return ok(saved.value);
  }

  getPositioning(workspaceId: EntityId, userId: EntityId): Result<Positioning | null, BrainError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;
    const positioning = this.repo.getPositioning(workspaceId, userId);
    if (!positioning.ok) return err(fromStorage(positioning.error.code, "positioning unavailable"));
    return ok(positioning.value);
  }

  // --- Brand voice ---

  upsertBrandVoice(
    workspaceId: EntityId,
    userId: EntityId,
    input: unknown,
  ): Result<BrandVoice, BrainError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;

    const issues = new Issues();
    const raw = (input ?? {}) as Record<string, unknown>;
    const tone = requireStringList(issues, "tone", raw.tone);
    const style = optionalString(issues, "style", raw.style, LIMITS.longText);
    const terminology =
      raw.terminology === undefined
        ? undefined
        : (requireStringList(issues, "terminology", raw.terminology) ?? undefined);
    const constraints =
      raw.constraints === undefined
        ? undefined
        : (requireStringList(issues, "constraints", raw.constraints) ?? undefined);
    if (issues.length > 0) return err(fail(issues));
    if (!tone) return err(fail(issues));

    // Same partial-update semantics as positioning: omitted fields are preserved.
    const patch: Parameters<BrainRepository["upsertBrandVoice"]>[2] = { tone };
    setOptional(patch, "style", style);
    setOptionalList(patch, "terminology", terminology);
    setOptionalList(patch, "constraints", constraints);
    const saved = this.repo.upsertBrandVoice(workspaceId, userId, patch);
    if (!saved.ok) return err(fromStorage(saved.error.code, "brand voice save failed"));
    return ok(saved.value);
  }

  getBrandVoice(workspaceId: EntityId, userId: EntityId): Result<BrandVoice | null, BrainError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;
    const voice = this.repo.getBrandVoice(workspaceId, userId);
    if (!voice.ok) return err(fromStorage(voice.error.code, "brand voice unavailable"));
    return ok(voice.value);
  }

  // --- Claims ---

  createClaim(workspaceId: EntityId, userId: EntityId, input: unknown): Result<Claim, BrainError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;

    const issues = new Issues();
    const raw = (input ?? {}) as Record<string, unknown>;
    const text = requireString(issues, "text", raw.text, LIMITS.claimText);
    const category = requireEnum(issues, "category", raw.category, CLAIM_CATEGORIES);
    // A caller may mark a claim restricted or leave it unverified, but may
    // never create one as approved — approval is a separate, attributed act.
    const status =
      raw.status === undefined
        ? null
        : requireEnum(issues, "status", raw.status, ["unverified", "restricted"] as const);
    const sourceNote = optionalString(issues, "sourceNote", raw.sourceNote, LIMITS.longText);
    if (issues.length > 0) return err(fail(issues));
    if (!text || !category) return err(fail(issues));

    const created = this.repo.createClaim({
      workspaceId,
      userId,
      text,
      category,
      status: status ?? "unverified",
      sourceNote: sourceNote ?? null,
    });
    if (!created.ok) return err(fromStorage(created.error.code, "claim creation failed"));
    return ok(created.value);
  }

  listClaims(
    workspaceId: EntityId,
    userId: EntityId,
    filter?: { status?: Claim["status"] },
  ): Result<Claim[], BrainError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;

    const status = filter?.status;
    if (status !== undefined && !(CLAIM_STATUSES as readonly string[]).includes(status)) {
      return err(
        brainError("VALIDATION_ERROR", `status must be one of: ${CLAIM_STATUSES.join(", ")}`),
      );
    }
    const claims = this.repo.listClaims(workspaceId, userId, status ? { status } : undefined);
    if (!claims.ok) return err(fromStorage(claims.error.code, "claims unavailable"));
    return ok(claims.value);
  }

  updateClaim(id: EntityId, userId: EntityId, input: unknown): Result<Claim, BrainError> {
    if (!id || typeof id !== "string") {
      return err(brainError("VALIDATION_ERROR", "claim id is required"));
    }
    const issues = new Issues();
    const raw = (input ?? {}) as Record<string, unknown>;
    const patch: Parameters<BrainRepository["updateClaim"]>[1] = { userId };
    setOptional(patch, "text", optionalString(issues, "text", raw.text, LIMITS.claimText));
    if (raw.category !== undefined) {
      const category = requireEnum(issues, "category", raw.category, CLAIM_CATEGORIES);
      if (category) patch.category = category;
    }
    setOptional(
      patch,
      "sourceNote",
      optionalString(issues, "sourceNote", raw.sourceNote, LIMITS.longText),
    );
    if (raw.status !== undefined) {
      // Setting `approved` here is rejected outright: approval must be an
      // explicit, attributed action so approval status is never incidental.
      const status = requireEnum(issues, "status", raw.status, [
        "unverified",
        "restricted",
      ] as const);
      if (status) patch.status = status;
    }
    if (issues.length > 0) return err(fail(issues));

    const updated = this.repo.updateClaim(id, patch);
    if (!updated.ok) return err(fromStorage(updated.error.code, "claim not found"));
    return ok(updated.value);
  }

  /** Approve a claim. The approver is the authenticated user, never the client. */
  approveClaim(id: EntityId, userId: EntityId): Result<Claim, BrainError> {
    if (!id || typeof id !== "string") {
      return err(brainError("VALIDATION_ERROR", "claim id is required"));
    }
    const approved = this.repo.approveClaim(id, userId);
    if (!approved.ok) return err(fromStorage(approved.error.code, "claim not found"));
    return ok(approved.value);
  }

  deleteClaim(id: EntityId, userId: EntityId): Result<void, BrainError> {
    if (!id || typeof id !== "string") {
      return err(brainError("VALIDATION_ERROR", "claim id is required"));
    }
    const removed = this.repo.deleteClaim(id, userId);
    if (!removed.ok) return err(fromStorage(removed.error.code, "claim not found"));
    return ok(undefined);
  }

  /**
   * The agent-facing Business Brain interface.
   *
   * Returns a deterministic, structured snapshot for one workspace. Callers
   * are future agents; they must never touch storage directly. Authorization
   * is resolved from `userId`, and unapproved pricing is withheld so an agent
   * cannot state price the business has not cleared.
   */
  getBusinessContext(workspaceId: EntityId, userId: EntityId): Result<BusinessContext, BrainError> {
    const guard = this.guard(workspaceId, userId);
    if (!guard.ok) return guard;

    const company = this.repo.getBusinessProfileFor(workspaceId, userId);
    if (!company.ok) return err(fromStorage(company.error.code, "company unavailable"));
    const offers = this.repo.listOffers(workspaceId, userId);
    if (!offers.ok) return err(fromStorage(offers.error.code, "offers unavailable"));
    const icp = this.repo.getIcp(workspaceId, userId);
    if (!icp.ok) return err(fromStorage(icp.error.code, "icp unavailable"));
    const personas = this.repo.listPersonas(workspaceId, userId);
    if (!personas.ok) return err(fromStorage(personas.error.code, "personas unavailable"));
    const positioning = this.repo.getPositioning(workspaceId, userId);
    if (!positioning.ok) return err(fromStorage(positioning.error.code, "positioning unavailable"));
    const brandVoice = this.repo.getBrandVoice(workspaceId, userId);
    if (!brandVoice.ok) return err(fromStorage(brandVoice.error.code, "brand voice unavailable"));
    const claims = this.repo.listClaims(workspaceId, userId);
    if (!claims.ok) return err(fromStorage(claims.error.code, "claims unavailable"));

    const context: BusinessContext = {
      workspaceId,
      company: company.value
        ? {
            name: company.value.name,
            description: company.value.description,
            website: company.value.website,
            type: company.value.type,
            market: company.value.market,
            industry: company.value.industry,
            size: company.value.size,
          }
        : null,
      offers: offers.value.map((offer) => ({
        name: offer.name,
        description: offer.description,
        targetCustomer: offer.targetCustomer,
        problemSolved: offer.problemSolved,
        outcome: offer.outcome,
        deliveryModel: offer.deliveryModel,
        status: offer.status,
        // Unapproved pricing is withheld rather than passed through.
        pricing:
          offer.pricing && offer.pricing.approved
            ? {
                model: offer.pricing.model,
                amountMin: offer.pricing.amountMin,
                amountMax: offer.pricing.amountMax,
                currency: offer.pricing.currency,
                notes: offer.pricing.notes,
              }
            : null,
      })),
      icp: icp.value
        ? {
            industries: icp.value.industries,
            companySizes: icp.value.companySizes,
            geographies: icp.value.geographies,
            businessModels: icp.value.businessModels,
            characteristics: icp.value.characteristics,
            disqualifiers: icp.value.disqualifiers,
            notes: icp.value.notes,
          }
        : null,
      personas: personas.value.map((p) => ({
        title: p.title,
        responsibilities: p.responsibilities,
        painPoints: p.painPoints,
        goals: p.goals,
        buyingContext: p.buyingContext,
      })),
      positioning: positioning.value
        ? {
            statement: positioning.value.statement,
            differentiators: positioning.value.differentiators,
            approvedValuePropositions: positioning.value.approvedValuePropositions,
            competitorContext: positioning.value.competitorContext,
          }
        : null,
      brandVoice: brandVoice.value
        ? {
            tone: brandVoice.value.tone,
            style: brandVoice.value.style,
            terminology: brandVoice.value.terminology,
            constraints: brandVoice.value.constraints,
          }
        : null,
      claims: {
        approved: [],
        unverified: [],
        restricted: [],
      },
    };

    for (const claim of claims.value) {
      const entry = { id: claim.id, text: claim.text, category: claim.category };
      if (claim.status === "approved") context.claims.approved.push(entry);
      else if (claim.status === "restricted") context.claims.restricted.push(entry);
      else context.claims.unverified.push(entry);
    }

    return ok(context);
  }
}

export type { User };
