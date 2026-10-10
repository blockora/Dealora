import type {
  WorkflowDefinition,
  WorkflowError,
  WorkflowRunAction,
  WorkflowRunState,
  WorkflowStepState,
  WorkflowTransitionResult,
} from "./types.js";

/** Maximum total executions of one node, including its initial attempt. */
export const WORKFLOW_RETRY_LIMIT = 3;

function refusal(message: string, code: WorkflowError["code"] = "CONFLICT"): WorkflowTransitionResult {
  return { ok: false, error: { code, message } };
}

function errorFor(code: WorkflowError["code"], message: string): WorkflowError {
  return { code, message };
}

function copyState(state: WorkflowRunState, patch: Partial<WorkflowRunState>): WorkflowRunState {
  return { ...state, ...patch, steps: patch.steps ?? state.steps };
}

function currentStep(state: WorkflowRunState): WorkflowStepState | undefined {
  return state.currentNodeId === null ? undefined : state.steps[state.currentNodeId];
}

/**
 * Apply one deterministic control or step outcome to a workflow run.
 * No clocks, randomness, I/O or mutation are involved.
 */
export function transitionWorkflow(
  definition: WorkflowDefinition,
  state: WorkflowRunState,
  action: WorkflowRunAction,
  retryLimit = WORKFLOW_RETRY_LIMIT,
): WorkflowTransitionResult {
  if (!Number.isInteger(retryLimit) || retryLimit < 1) {
    return refusal("Retry limit must be a positive integer.", "VALIDATION_ERROR");
  }
  if (["completed", "failed", "stopped"].includes(state.status)) {
    return refusal(`Run in terminal state '${state.status}' cannot transition.`);
  }

  if (action.type === "stop") {
    return { ok: true, state: copyState(state, { status: "stopped" }) };
  }
  if (action.type === "pause") {
    if (state.status !== "running" && state.status !== "waiting") return refusal("Only a running or waiting run can be paused.");
    const steps = { ...state.steps };
    if (state.currentNodeId !== null && steps[state.currentNodeId]?.status === "running") {
      steps[state.currentNodeId] = { ...steps[state.currentNodeId]!, status: "paused" };
    }
    return { ok: true, state: copyState(state, { status: "paused", steps }) };
  }
  if (action.type === "resume") {
    if (state.status !== "paused") return refusal("Only a paused run can be resumed.");
    const steps = { ...state.steps };
    if (state.currentNodeId !== null && steps[state.currentNodeId]?.status === "paused") {
      steps[state.currentNodeId] = { ...steps[state.currentNodeId]!, status: "running" };
    }
    return { ok: true, state: copyState(state, { status: "running", steps }) };
  }

  if (action.type === "start") {
    if (state.status !== "pending") return refusal("Only a pending run can be started.");
    if (state.currentNodeId === null || !definition.nodes.some((node) => node.id === state.currentNodeId)) {
      return refusal("A start node must be selected from the workflow definition.", "VALIDATION_ERROR");
    }
    if (state.steps[state.currentNodeId] === undefined) return refusal("The current node has no step state.", "VALIDATION_ERROR");
    const steps = { ...state.steps, [state.currentNodeId]: { ...state.steps[state.currentNodeId]!, status: "running" } };
    return { ok: true, state: copyState(state, { status: "running", steps }) };
  }

  const nodeId = state.currentNodeId;
  const step = currentStep(state);
  if (nodeId === null || step === undefined) return refusal("The run has no current step.", "VALIDATION_ERROR");

  if (action.type === "retry") {
    if (state.status !== "running" || step.status !== "failed") return refusal("Retry requires a failed step in a running run.");
    if (step.attempts >= retryLimit) return refusal("The retry limit for this step is exhausted.");
    const steps = { ...state.steps, [nodeId]: { status: "running", attempts: step.attempts + 1 } };
    return { ok: true, state: copyState(state, { status: "running", steps }) };
  }

  if (state.status !== "running" || step.status !== "running") return refusal("Step outcomes require a running step in a running run.");
  const steps = { ...state.steps };
  if (action.type === "wait_step") {
    steps[nodeId] = { ...step, status: "waiting" };
    return { ok: true, state: copyState(state, { status: "waiting", steps }) };
  }
  if (action.type === "fail_step") {
    const failed = { ...step, status: "failed" as const };
    steps[nodeId] = failed;
    if (failed.attempts < retryLimit) {
      return { ok: true, state: copyState(state, { status: "running", steps }) };
    }
    return { ok: true, state: copyState(state, { status: "failed", steps }) };
  }
  if (action.type === "succeed_step") {
    steps[nodeId] = { ...step, status: "succeeded" };
    const next = definition.edges.find((edge) => edge.from === nodeId);
    if (next === undefined) return { ok: true, state: copyState(state, { status: "completed", steps }) };
    if (!definition.nodes.some((node) => node.id === next.to)) {
      return { ok: false, error: errorFor("VALIDATION_ERROR", "The next edge references an unknown node.") };
    }
    if (steps[next.to] === undefined) return refusal("The next node has no step state.", "VALIDATION_ERROR");
    steps[next.to] = { ...steps[next.to]!, status: "running" };
    return { ok: true, state: copyState(state, { status: "running", currentNodeId: next.to, steps }) };
  }
  return refusal("Unsupported workflow action.", "VALIDATION_ERROR");
}
