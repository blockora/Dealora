import { describe, expect, it } from "vitest";
import { transitionWorkflow, WORKFLOW_RETRY_LIMIT } from "./engine.js";
import type { WorkflowDefinition, WorkflowRunState } from "./types.js";

const definition: WorkflowDefinition = {
  id: "wf",
  name: "Test",
  nodes: [{ id: "a", kind: "trigger" }, { id: "b", kind: "action" }],
  edges: [{ from: "a", to: "b" }],
};
const running: WorkflowRunState = {
  status: "running",
  currentNodeId: "a",
  steps: { a: { status: "running", attempts: 1 }, b: { status: "pending", attempts: 0 } },
};

describe("workflow state transitions", () => {
  it("advances along a valid edge", () => {
    const result = transitionWorkflow(definition, running, { type: "succeed_step" });
    expect(result.ok && result.state).toMatchObject({ status: "running", currentNodeId: "b", steps: { a: { status: "succeeded" }, b: { status: "running" } } });
  });
  it("rejects an invalid step transition", () => {
    expect(transitionWorkflow(definition, { ...running, status: "waiting" }, { type: "succeed_step" })).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
  });
  it("protects terminal runs", () => {
    for (const status of ["completed", "failed", "stopped"] as const) {
      expect(transitionWorkflow(definition, { ...running, status }, { type: "stop" })).toMatchObject({ ok: false });
    }
  });
  it("pauses and resumes", () => {
    const paused = transitionWorkflow(definition, running, { type: "pause" });
    expect(paused.ok && paused.state).toMatchObject({ status: "paused", steps: { a: { status: "paused" } } });
    if (paused.ok) expect(transitionWorkflow(definition, paused.state, { type: "resume" })).toMatchObject({ ok: true, state: { status: "running", steps: { a: { status: "running" } } } });
  });
  it("stops a non-terminal run", () => expect(transitionWorkflow(definition, running, { type: "stop" })).toMatchObject({ ok: true, state: { status: "stopped" } }));
  it("allows retry when attempts remain", () => {
    const state = { ...running, currentNodeId: "a", steps: { ...running.steps, a: { status: "failed" as const, attempts: 1 } } };
    expect(transitionWorkflow(definition, state, { type: "retry" })).toMatchObject({ ok: true, state: { steps: { a: { status: "running", attempts: 2 } } } });
  });
  it("rejects retry when the retry limit is exhausted", () => {
    const state = { ...running, steps: { ...running.steps, a: { status: "failed" as const, attempts: WORKFLOW_RETRY_LIMIT } } };
    expect(transitionWorkflow(definition, state, { type: "retry" })).toMatchObject({ ok: false });
  });
  it("makes exhausted failure terminal", () => {
    const state = { ...running, steps: { ...running.steps, a: { status: "running" as const, attempts: WORKFLOW_RETRY_LIMIT } } };
    expect(transitionWorkflow(definition, state, { type: "fail_step" })).toMatchObject({ ok: true, state: { status: "failed", steps: { a: { status: "failed" } } } });
  });
  it("returns identical results for repeated deterministic inputs", () => {
    const first = transitionWorkflow(definition, running, { type: "succeed_step" });
    const second = transitionWorkflow(definition, running, { type: "succeed_step" });
    expect(first).toEqual(second);
  });
});
