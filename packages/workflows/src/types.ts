export const WORKFLOW_NODE_KINDS = [
  "trigger",
  "research",
  "condition",
  "agent",
  "approval",
  "action",
  "wait",
] as const;

export type WorkflowNodeKind = (typeof WORKFLOW_NODE_KINDS)[number];

export interface WorkflowNode {
  readonly id: string;
  readonly kind: WorkflowNodeKind;
  readonly name?: string;
  readonly config?: Readonly<Record<string, unknown>>;
}

export interface WorkflowEdge {
  readonly from: string;
  readonly to: string;
}

export interface WorkflowDefinition {
  readonly id: string;
  readonly name: string;
  readonly nodes: readonly WorkflowNode[];
  readonly edges: readonly WorkflowEdge[];
}

export type WorkflowRunStatus = "pending" | "running" | "paused" | "waiting" | "failed" | "completed" | "stopped";
export type WorkflowStepStatus = "pending" | "running" | "succeeded" | "failed" | "waiting" | "paused";

export interface WorkflowStepState {
  readonly status: WorkflowStepStatus;
  readonly attempts: number;
}

export interface WorkflowRunState {
  readonly status: WorkflowRunStatus;
  readonly currentNodeId: string | null;
  readonly steps: Readonly<Record<string, WorkflowStepState>>;
}

export type WorkflowRunAction =
  | { readonly type: "start" }
  | { readonly type: "succeed_step" }
  | { readonly type: "fail_step" }
  | { readonly type: "wait_step" }
  | { readonly type: "pause" }
  | { readonly type: "resume" }
  | { readonly type: "stop" }
  | { readonly type: "retry" };

export type WorkflowErrorCode = "VALIDATION_ERROR" | "NOT_FOUND" | "CONFLICT" | "UNAVAILABLE";

export interface WorkflowError {
  readonly code: WorkflowErrorCode;
  readonly message: string;
  readonly details?: readonly { readonly field: string; readonly message: string }[];
}

export interface WorkflowValidationIssue {
  readonly field: string;
  readonly message: string;
}

export type WorkflowTransitionResult =
  | { readonly ok: true; readonly state: WorkflowRunState }
  | { readonly ok: false; readonly error: WorkflowError };
