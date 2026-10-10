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

export type WorkflowRunStatus = "pending" | "running" | "paused" | "succeeded" | "failed" | "cancelled";

export interface WorkflowRun {
  readonly id: string;
  readonly workflowId: string;
  readonly status: WorkflowRunStatus;
  readonly state: WorkflowRunState;
}

export interface WorkflowRunState {
  readonly currentNodeId: string | null;
  readonly nodeStates: Readonly<Record<string, "pending" | "running" | "succeeded" | "failed" | "skipped">>;
}

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
