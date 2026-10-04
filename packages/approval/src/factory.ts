import type { EntityId } from "@dealora/db";

import { ApprovalService } from "./service.js";
import type { ApprovalDraftReader, ApprovalDraftSnapshot, ApprovalRepository } from "./types.js";

/**
 * Convenience factory wiring the Approval service to the concrete store.
 *
 * Application code may construct the service with any {@link ApprovalRepository}
 * plus a draft reader, which keeps the domain decoupled from storage: the domain
 * never learns that any of them is a JSON document.
 *
 * The draft reader is deliberately narrow. Approval reads a draft's version,
 * subject, body, warnings and the renderer's context digest — enough to show a
 * reviewer exactly what they are approving and to re-derive the preview digest —
 * and nothing else. It never sees the evidence behind a draft, never re-renders
 * anything, and never touches a provider.
 */
export function createApprovalService(
  repo: ApprovalRepository,
  drafts: ApprovalDraftReader,
  clock?: () => Date,
): ApprovalService {
  return new ApprovalService(repo, drafts, clock);
}

/**
 * Narrow a stored draft to the fields the approval boundary reads.
 *
 * `warnings` travels with it on purpose: what the renderer declined to state is
 * part of what a reviewer is approving, and an approval that hid the warnings
 * would not be an informed one.
 */
export function toApprovalDraftSnapshot(draft: {
  id: EntityId;
  workspaceId: EntityId;
  version: number;
  subject: string;
  body: string;
  warnings: string[];
  contextDigest: string;
}): ApprovalDraftSnapshot {
  return {
    id: draft.id,
    workspaceId: draft.workspaceId,
    version: draft.version,
    subject: draft.subject,
    body: draft.body,
    warnings: [...draft.warnings],
    contextDigest: draft.contextDigest,
  };
}
