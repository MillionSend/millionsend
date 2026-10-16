import { describe, expect, it } from "vitest";
import { errorClassAndCode, errorSummary } from "../src/error-summary.js";

describe("errorSummary", () => {
  it("names the driver's cause, never the query or its parameters", () => {
    const cause = Object.assign(new Error('duplicate key value violates unique constraint "x"'), {
      code: "23505",
    });
    const query = new Error(
      'Failed query: insert into "user" values ($1)\nparams: victim@example.com',
      { cause },
    );
    expect(errorSummary(query)).toBe('23505 duplicate key value violates unique constraint "x"');
    expect(errorSummary(new Error("Failed query: select $1\nparams: victim@example.com"))).toBe(
      "query failed",
    );
  });

  it("keeps a plain message, bounded, and names nothing it cannot read", () => {
    expect(errorSummary(new Error("socket hang up"))).toBe("socket hang up");
    expect(errorSummary(new Error("x".repeat(1000)))).toHaveLength(300);
    expect(errorSummary("victim@example.com")).toBe("unknown error");
    expect(errorSummary(undefined)).toBe("unknown error");
  });
});

describe("errorClassAndCode", () => {
  it("names the outer class and the first code down the cause chain, never a message", () => {
    const driver = Object.assign(new Error("duplicate key value: victim@example.com"), {
      code: "23505",
    });
    const query = new Error("Failed query: insert ...\nparams: victim@example.com", {
      cause: driver,
    });
    expect(errorClassAndCode(query)).toEqual(["Error", "23505"]);
    const wrapped = new TypeError("outer", { cause: new Error("middle", { cause: driver }) });
    expect(errorClassAndCode(wrapped)).toEqual(["TypeError", "23505"]);
    expect(errorClassAndCode(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toEqual([
      "Error",
      "ECONNRESET",
    ]);
  });

  it("answers an empty code when none is a string, and a plain class for a non-error", () => {
    expect(errorClassAndCode(new Error("x"))).toEqual(["Error", ""]);
    expect(errorClassAndCode(Object.assign(new Error("x"), { code: 42 }))).toEqual(["Error", ""]);
    expect(errorClassAndCode("victim@example.com")).toEqual(["error", ""]);
    expect(errorClassAndCode(undefined)).toEqual(["error", ""]);
  });
});
