import { describe, expect, it } from "vitest";
import { auditDetail } from "./detail";

const bool = (v: boolean) => (v ? "yes" : "no");

describe("auditDetail", () => {
  it("joins scalars, renders booleans through the callback, skips name and nulls", () => {
    expect(
      auditDetail({ name: "Acme", reason: "complaints", note: null, notified: true }, bool),
    ).toBe("reason complaints · notified yes");
  });

  it("collapses a from/to plan pair to an arrow", () => {
    expect(
      auditDetail(
        { from: { plan: "free", planQuota: null }, to: { plan: "pro", planQuota: 100000 } },
        bool,
      ),
    ).toBe("free → pro");
  });

  it("is empty for no data", () => {
    expect(auditDetail(null, bool)).toBe("");
  });
});
