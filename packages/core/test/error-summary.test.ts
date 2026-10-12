import { describe, expect, it } from "vitest";
import { errorSummary } from "../src/error-summary.js";

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
