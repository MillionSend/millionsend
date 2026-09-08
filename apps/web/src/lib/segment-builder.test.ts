import { describe, expect, it } from "vitest";
import { buildSegmentFilter, fieldPickerValue, filterToRows, rowComplete } from "./segment-builder";

describe("fieldPickerValue", () => {
  it("keeps fields and named properties, and falls back to the free-form entry for a blank key", () => {
    expect(fieldPickerValue("email")).toBe("email");
    expect(fieldPickerValue("property:plan")).toBe("property:plan");
    expect(fieldPickerValue("property:")).toBe("property");
  });
});

describe("rowComplete + buildSegmentFilter", () => {
  it("drops half-filled rows and nulls the value of presence ops", () => {
    const rows = [
      { field: "property:plan", op: "equals", value: " free " },
      { field: "property:", op: "equals", value: "x" },
      { field: "email", op: "contains", value: "" },
      { field: "unsubscribed", op: "is_false", value: "" },
    ];
    expect(rows.map(rowComplete)).toEqual([true, false, false, true]);
    const filter = buildSegmentFilter("any", rows);
    expect(filter).toEqual({
      match: "any",
      conditions: [
        { field: "property:plan", op: "equals", value: "free" },
        { field: "unsubscribed", op: "is_false", value: null },
      ],
    });
    expect(filterToRows(filter)).toEqual([
      { field: "property:plan", op: "equals", value: "free" },
      { field: "unsubscribed", op: "is_false", value: "" },
    ]);
  });
});
