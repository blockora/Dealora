/**
 * The adapters this repository ships for the standardized CRM interface
 * (ROADMAP.md §30).
 *
 * The honest default, exactly as Phase 11's email provider and Phase 13's
 * calendar provider established: the shipped adapter performs **no network
 * I/O at all** — it accepts a change-set and records it. No CRM credential
 * exists in this repository (§18's OAuth requirement stays open for the
 * first real adapter, ADR 0011), and an adapter that pretended to sync would
 * make the phase's central claim — *an approved change-set reached an
 * adapter and its confirmation is what made the sync executed* —
 * unverifiable.
 *
 * What it does prove is everything on DEALORA's side of the boundary: that
 * a change-set only reaches an adapter after a persisted human decision
 * bound to its digest, that the payload applied is the payload approved,
 * and that the confirmation the adapter returns is what moves a sync to
 * `executed`. It also de-duplicates on the idempotency key — re-applying
 * the same key returns the original reference rather than accepting a
 * second copy — which is what makes a retry after a failure safe.
 *
 * Registration is the vendor seam: `createIntegrationRegistry` accepts any
 * list of {@link IntegrationAdapter}s, product code resolves adapters only
 * by id, and a system with no adapter fails closed. Adding a real vendor is
 * a deployment decision, not a code change.
 */

import type { IntegrationPermissionScope } from "@dealora/db";

import type {
  CrmApplyRequest,
  CrmApplyResult,
  CrmChangeSetAdapter,
  IntegrationAdapter,
  IntegrationRegistry,
} from "./types.js";
import { INTEGRATION_SCOPE_CATALOG } from "./rules.js";

/** Every scope the published catalog defines — the sandbox can request all. */
const ALL_SCOPES: readonly IntegrationPermissionScope[] = INTEGRATION_SCOPE_CATALOG.map(
  (entry) => entry.scope,
);

/** What the sandbox records for each change-set it accepted. */
export interface SandboxCrmApplication {
  idempotencyKey: string;
  accountId: string;
  adapterId: string;
  operationCount: number;
  approvedBy: string;
  approvedAt: string;
  providerReference: string;
}

/**
 * The deterministic sandbox CRM adapter — the only CRM adapter shipped here.
 *
 * See the module docstring for why it is a sandbox. It de-duplicates on the
 * idempotency key, exposes what it accepted so a test can prove a change-set
 * genuinely reached the adapter rather than inferring it from the sync's own
 * status, and offers an explicit, test-driven refusal (`refuseNext`) so the
 * failure path runs against a real adapter rather than a hand-written result.
 */
export class SandboxCrmAdapter implements CrmChangeSetAdapter {
  readonly id = "sandbox_crm";
  readonly system = "crm" as const;
  readonly displayName = "Sandbox CRM";
  readonly scopes: readonly IntegrationPermissionScope[] = ALL_SCOPES;
  readonly sandbox = true;

  /** What the adapter accepted, keyed by idempotency key. */
  private readonly applied = new Map<string, SandboxCrmApplication>();
  private calls = 0;
  private refusal: {
    failureCode: "adapter_unavailable" | "adapter_rejected" | "invalid_change_set";
    message: string;
  } | null = null;

  /** Every change-set this adapter confirmed, in acceptance order. */
  appliedChangeSets(): SandboxCrmApplication[] {
    return [...this.applied.values()];
  }

  /** How many times `applyChangeSet` was actually called, refusals included. */
  callCount(): number {
    return this.calls;
  }

  /**
   * Refuse the next application with a chosen closed code — the honest way
   * to exercise the failure path against a real adapter, rather than
   * weakening the service until a mock fits.
   */
  refuseNext(
    failureCode: "adapter_unavailable" | "adapter_rejected" | "invalid_change_set",
    message: string,
  ): void {
    this.refusal = { failureCode, message };
  }

  async applyChangeSet(request: CrmApplyRequest): Promise<CrmApplyResult> {
    this.calls += 1;
    const existing = this.applied.get(request.idempotencyKey);
    if (existing !== undefined) {
      // The same logical sync, already accepted: report the original
      // reference rather than pretending a second copy went out.
      return {
        accepted: true,
        providerReference: existing.providerReference,
        failureCode: null,
        message: "already accepted",
      };
    }
    if (this.refusal !== null) {
      const refusal = this.refusal;
      this.refusal = null;
      return {
        accepted: false,
        providerReference: null,
        failureCode: refusal.failureCode,
        message: refusal.message,
      };
    }
    const providerReference = `sandbox-crm-${request.idempotencyKey}`;
    this.applied.set(request.idempotencyKey, {
      idempotencyKey: request.idempotencyKey,
      accountId: request.accountId,
      adapterId: request.adapterId,
      operationCount: request.changeSet.operations.length,
      approvedBy: request.approvedBy,
      approvedAt: request.approvedAt,
      providerReference,
    });
    return {
      accepted: true,
      providerReference,
      failureCode: null,
      message: "accepted by the sandbox adapter",
    };
  }
}

/**
 * A CRM adapter that refuses everything with a chosen code.
 *
 * Exists so the failure paths are tested against a real
 * {@link CrmChangeSetAdapter}, not against a hand-written result object:
 * this is the only way to prove that a refusal never becomes `executed`.
 */
export class FailingCrmAdapter implements CrmChangeSetAdapter {
  readonly id = "failing_crm";
  readonly system = "crm" as const;
  readonly displayName = "Failing CRM (test double)";
  readonly scopes: readonly IntegrationPermissionScope[] = ALL_SCOPES;
  readonly sandbox = true;

  private calls = 0;

  constructor(
    private readonly failureCode:
      "adapter_unavailable" | "adapter_rejected" | "invalid_change_set" = "adapter_unavailable",
    private readonly message = "the adapter is unavailable",
  ) {}

  callCount(): number {
    return this.calls;
  }

  async applyChangeSet(): Promise<CrmApplyResult> {
    this.calls += 1;
    return {
      accepted: false,
      providerReference: null,
      failureCode: this.failureCode,
      message: this.message,
    };
  }
}

/**
 * Build the adapter registry from a deployment's registration list.
 *
 * Validates the invariants the service relies on: ids are unique (a
 * duplicate id would make "resolve by id" ambiguous, which is exactly how a
 * vendor could silently shadow another), every adapter's system and scopes
 * come from the published vocabularies, and an adapter claiming the `crm`
 * system must actually implement the CRM apply interface — checked by the
 * `crm()` narrowing rather than by trust.
 *
 * An empty list is a legitimate deployment: nothing connects, and every
 * sync path fails closed with "not configured".
 */
export function createIntegrationRegistry(
  adapters: readonly IntegrationAdapter[] = [],
): IntegrationRegistry {
  const byId = new Map<string, IntegrationAdapter>();
  for (const adapter of adapters) {
    if (byId.has(adapter.id)) {
      throw new Error(`duplicate integration adapter id: ${adapter.id}`);
    }
    byId.set(adapter.id, adapter);
  }
  return {
    list: () => [...byId.values()],
    get: (adapterId: string) => byId.get(adapterId) ?? null,
    crm: (adapterId: string) => {
      const found = byId.get(adapterId);
      return found !== undefined && found.system === "crm" && "applyChangeSet" in found
        ? (found as CrmChangeSetAdapter)
        : null;
    },
  };
}
