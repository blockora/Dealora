/**
 * @dealora/agent — the Phase 18 Agent System's public surface.
 *
 * Importing this package gives a caller the declarations, the lifecycle rules
 * and the registry service. It does not give a caller a way to run an agent:
 * there is no runner, no dispatcher, no tool invoker and no model client
 * exported here, because Phase 18 declares agents rather than executing them.
 */

export type {
  AgentCostLimit,
  AgentDeclaration,
  AgentError,
  AgentErrorCode,
  AgentEvaluationMetric,
  AgentEvaluationMetricView,
  AgentId,
  AgentMemoryLayer,
  AgentModelConfig,
  AgentPermissionView,
  AgentPolicyView,
  AgentRegistryEvent,
  AgentRegistryEventKind,
  AgentRegistryRepository,
  AgentRegistryRow,
  AgentRegistryView,
  AgentState,
  AgentToolId,
  AgentToolView,
  AgentTransitionView,
  AgentUsableState,
  RegisteredAgent,
  StorageResult,
} from "./types.js";

export {
  AGENT_DECLARATIONS,
  AGENT_EVALUATION_METRICS,
  AGENT_IDS,
  AGENT_MEMORY_LAYERS,
  AGENT_NEVER_DOES,
  AGENT_PERMISSIONS,
  AGENT_PROMOTION_RULE,
  AGENT_REFUSED_TRANSITIONS,
  AGENT_REQUIRED_FIELDS,
  AGENT_RULE_VERSION,
  AGENT_STATE_ORDER,
  AGENT_TOOLS,
  AGENT_TRANSITIONS,
  MEETABLE_AGENT_STATES,
  agentError,
  agentOrder,
  declarationFor,
  isAgentEvaluationMetric,
  isAgentId,
  isAgentState,
  toolFor,
} from "./rules.js";

export type { TransitionAllowed, TransitionDecision, TransitionRefusal } from "./engine.js";

export {
  decideTransition,
  derivePolicyView,
  deriveRegisteredAgent,
  deriveRegistryView,
  isUsable,
  sortRegistryEvents,
  stateFor,
  transitionAllowed,
} from "./engine.js";

export { AgentService } from "./service.js";

export type { AgentRegistryLookup } from "./factory.js";
export { createAgentService } from "./factory.js";
