/**
 * Store integration for the Experiment Engine: the structural lookup the
 * service reads through, adapted from the concrete repository.
 *
 * The tenant boundary lives inside the store for every method — each one
 * re-runs its own workspace check with the caller's identity — so this wiring
 * cannot widen a scope; it only names which methods exist. The service sees
 * structurally narrowed rows, never a whole workspace, user or session.
 */

import type { CostEvent, ConversationClassification, Meeting, OutboundAction } from "@dealora/db";

import { ExperimentService } from "./service.js";
import type {
  ExperimentArmRow,
  ExperimentEventRow,
  ExperimentLookup,
  ExperimentRow,
  StorageResult,
} from "./types.js";

/** The minimum the Experiment Engine needs from storage. Every call is scoped. */
export interface ExperimentStoreAdapter {
  authorize(workspaceId: string, userId: string): StorageResult<unknown>;
  createExperiment(input: {
    readonly workspaceId: string;
    readonly userId: string;
    readonly name: string;
    readonly metric: string;
    readonly durationDays: number;
  }): StorageResult<ExperimentRow>;
  getExperiment(input: {
    readonly workspaceId: string;
    readonly userId: string;
    readonly experimentId: string;
  }): StorageResult<ExperimentRow | null>;
  listExperiments(
    workspaceId: string,
    userId: string,
    filter?: { readonly status?: string },
  ): StorageResult<readonly ExperimentRow[]>;
  addExperimentArm(input: {
    readonly workspaceId: string;
    readonly userId: string;
    readonly experimentId: string;
    readonly draftId: string;
    readonly label: string;
  }): StorageResult<ExperimentArmRow>;
  listExperimentArms(
    workspaceId: string,
    userId: string,
    experimentId: string,
  ): StorageResult<readonly ExperimentArmRow[]>;
  startExperiment(input: {
    readonly workspaceId: string;
    readonly userId: string;
    readonly experimentId: string;
  }): StorageResult<ExperimentRow>;
  closeExperiment(input: {
    readonly workspaceId: string;
    readonly userId: string;
    readonly experimentId: string;
  }): StorageResult<ExperimentRow>;
  cancelExperiment(input: {
    readonly workspaceId: string;
    readonly userId: string;
    readonly experimentId: string;
    readonly reason: string | null;
  }): StorageResult<ExperimentRow>;
  listExperimentEvents(
    workspaceId: string,
    userId: string,
    experimentId: string,
  ): StorageResult<readonly ExperimentEventRow[]>;

  listAccounts(
    workspaceId: string,
    userId: string,
  ): StorageResult<readonly { id: string; status: string }[]>;
  listContacts(
    workspaceId: string,
    userId: string,
  ): StorageResult<readonly { id: string; accountId: string; status: string }[]>;
  listQualifications(
    workspaceId: string,
    userId: string,
  ): StorageResult<readonly { accountId: string; version: number; state: string }[]>;
  listOutboundActions(
    workspaceId: string,
    userId: string,
  ): StorageResult<readonly OutboundAction[]>;
  listConversationClassifications(
    workspaceId: string,
    userId: string,
  ): StorageResult<readonly ConversationClassification[]>;
  listMeetings(workspaceId: string, userId: string): StorageResult<readonly Meeting[]>;
  listCostEvents(
    workspaceId: string,
    userId: string,
    filter?: { readonly executionKind?: string },
  ): StorageResult<readonly CostEvent[]>;
}

/** Wire the Experiment Engine to storage. */
export function createExperimentService(store: ExperimentStoreAdapter): ExperimentService {
  const lookup: ExperimentLookup = {
    authorize: (workspaceId, userId) => store.authorize(workspaceId, userId),
    createExperiment: (input) => store.createExperiment(input),
    getExperiment: (input) => store.getExperiment(input),
    listExperiments: (workspaceId, userId, filter) =>
      store.listExperiments(workspaceId, userId, filter),
    addExperimentArm: (input) => store.addExperimentArm(input),
    listExperimentArms: (workspaceId, userId, experimentId) =>
      store.listExperimentArms(workspaceId, userId, experimentId),
    startExperiment: (input) => store.startExperiment(input),
    closeExperiment: (input) => store.closeExperiment(input),
    cancelExperiment: (input) => store.cancelExperiment(input),
    listExperimentEvents: (workspaceId, userId, experimentId) =>
      store.listExperimentEvents(workspaceId, userId, experimentId),

    listAccounts: (workspaceId, userId) => store.listAccounts(workspaceId, userId),
    listContacts: (workspaceId, userId) => store.listContacts(workspaceId, userId),
    listQualifications: (workspaceId, userId) => store.listQualifications(workspaceId, userId),
    listOutboundActions: (workspaceId, userId) => store.listOutboundActions(workspaceId, userId),
    listConversationClassifications: (workspaceId, userId) =>
      store.listConversationClassifications(workspaceId, userId),
    listMeetings: (workspaceId, userId) => store.listMeetings(workspaceId, userId),
    listCostEvents: (workspaceId, userId, filter) =>
      store.listCostEvents(workspaceId, userId, filter),
  };

  return new ExperimentService(lookup);
}
