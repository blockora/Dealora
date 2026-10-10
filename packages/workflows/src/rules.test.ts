import { describe, expect, it } from "vitest";
import {
  hasUniqueNodeIds,
  haveNoDuplicateEdges,
  haveValidEdgeReferences,
  haveValidNodeKinds,
  validateWorkflowDefinition,
} from "./rules.js";
import type { WorkflowDefinition } from "./types.js";

const valid: WorkflowDefinition = {
  id: "wf-1",
  name: "Example",
  nodes: [{ id: "start", kind: "trigger" }, { id: "finish", kind: "action" }],
  edges: [{ from: "start", to: "finish" }],
};

describe("workflow validation rules", () => {
  it("accepts a valid definition", () => expect(validateWorkflowDefinition(valid)).toEqual([]));
  it("detects duplicate node IDs", () => expect(hasUniqueNodeIds([{ id: "x", kind: "trigger" }, { id: "x", kind: "agent" }])).toBe(false));
  it("detects invalid edge references", () => expect(haveValidEdgeReferences({ ...valid, edges: [{ from: "start", to: "missing" }] })).toBe(false));
  it("detects duplicate edges", () => expect(haveNoDuplicateEdges({ edges: [{ from: "a", to: "b" }, { from: "a", to: "b" }] })).toBe(false));
  it("detects unsupported node kinds", () => expect(haveValidNodeKinds([{ kind: "unknown" }])).toBe(false));
  it("reports multiple definition violations", () => {
    const issues = validateWorkflowDefinition({ ...valid, nodes: [{ id: "x", kind: "wat" }, { id: "x", kind: "trigger" }], edges: [{ from: "x", to: "missing" }] });
    expect(issues.map(({ message }) => message)).toEqual(expect.arrayContaining([
      "Node IDs must be unique.",
      "Every node must have a valid kind.",
      "Every edge must reference existing nodes.",
    ]));
  });
});
