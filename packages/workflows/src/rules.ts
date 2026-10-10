import { WORKFLOW_NODE_KINDS, type WorkflowDefinition, type WorkflowNode } from "./types.js";

export function hasUniqueNodeIds(nodes: readonly WorkflowNode[]): boolean {
  const ids = new Set<string>();
  for (const node of nodes) {
    if (ids.has(node.id)) return false;
    ids.add(node.id);
  }
  return true;
}

export function haveValidEdgeReferences(definition: Pick<WorkflowDefinition, "nodes" | "edges">): boolean {
  const ids = new Set(definition.nodes.map((node) => node.id));
  return definition.edges.every((edge) => ids.has(edge.from) && ids.has(edge.to));
}

export function haveNoDuplicateEdges(definition: Pick<WorkflowDefinition, "edges">): boolean {
  const edges = new Set<string>();
  for (const edge of definition.edges) {
    const key = JSON.stringify([edge.from, edge.to]);
    if (edges.has(key)) return false;
    edges.add(key);
  }
  return true;
}

export function haveValidNodeKinds(nodes: readonly { readonly kind: unknown }[]): boolean {
  return nodes.every((node) => typeof node.kind === "string" && (WORKFLOW_NODE_KINDS as readonly string[]).includes(node.kind));
}

export function validateWorkflowDefinition(value: unknown): readonly { field: string; message: string }[] {
  const issues: { field: string; message: string }[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [{ field: "workflow", message: "Must be an object." }];
  }
  const definition = value as Partial<WorkflowDefinition>;
  if (typeof definition.id !== "string" || definition.id.trim() === "") issues.push({ field: "id", message: "Must be a non-empty string." });
  if (typeof definition.name !== "string" || definition.name.trim() === "") issues.push({ field: "name", message: "Must be a non-empty string." });
  if (!Array.isArray(definition.nodes)) {
    issues.push({ field: "nodes", message: "Must be an array." });
  } else {
    if (!hasUniqueNodeIds(definition.nodes)) issues.push({ field: "nodes", message: "Node IDs must be unique." });
    if (!definition.nodes.every((node) => typeof node === "object" && node !== null && typeof node.id === "string" && node.id.trim() !== "")) issues.push({ field: "nodes", message: "Every node must have a non-empty ID." });
    if (!haveValidNodeKinds(definition.nodes)) issues.push({ field: "nodes", message: "Every node must have a valid kind." });
  }
  if (!Array.isArray(definition.edges)) {
    issues.push({ field: "edges", message: "Must be an array." });
  } else {
    if (!definition.edges.every((edge) => typeof edge === "object" && edge !== null && typeof edge.from === "string" && typeof edge.to === "string")) issues.push({ field: "edges", message: "Every edge must have string from and to references." });
    else {
      if (!haveValidEdgeReferences(definition as WorkflowDefinition)) issues.push({ field: "edges", message: "Every edge must reference existing nodes." });
      if (!haveNoDuplicateEdges(definition as WorkflowDefinition)) issues.push({ field: "edges", message: "Edges must be unique." });
    }
  }
  return issues;
}

export function isValidWorkflowDefinition(value: unknown): value is WorkflowDefinition {
  return validateWorkflowDefinition(value).length === 0;
}
