import { describe, expect, it } from "vitest";

import { err, isErr, isOk, ok, type Result } from "./index.js";

describe("ok", () => {
  it("wraps a value as a successful result", () => {
    const result = ok(42);

    expect(result).toEqual({ ok: true, value: 42 });
    expect(result.ok).toBe(true);
  });

  it("preserves non-primitive payloads by reference", () => {
    const payload = { claim: "company expanded into the EU" };
    const result = ok(payload);

    expect(result.value).toBe(payload);
  });
});

describe("err", () => {
  it("wraps a structured error as a failed result", () => {
    const error = { code: "UPSTREAM_TIMEOUT", retryable: true };
    const result = err(error);

    expect(result).toEqual({ ok: false, error });
    expect(result.ok).toBe(false);
  });
});

describe("type guards", () => {
  it("narrows to the success branch", () => {
    const result: Result<number, string> = ok(7);

    if (isOk(result)) {
      expect(result.value).toBe(7);
    } else {
      expect.unreachable("expected the success branch");
    }
  });

  it("narrows to the failure branch", () => {
    const result: Result<number, string> = err("upstream unavailable");

    if (isErr(result)) {
      expect(result.error).toBe("upstream unavailable");
    } else {
      expect.unreachable("expected the failure branch");
    }
  });

  it("keeps the two branches mutually exclusive", () => {
    const result: Result<number, string> = err("boom");

    expect(isOk(result)).toBe(false);
    expect(isErr(result)).toBe(true);
  });
});
