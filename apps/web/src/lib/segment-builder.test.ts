import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";
import en from "../../messages/en/audience.json";
import pt from "../../messages/pt-BR/audience.json";
import {
  buildSegmentFilter,
  defaultOp,
  fieldPickerValue,
  filterToRows,
  OPS_BY_KIND,
  opsFor,
  rowComplete,
  valueKind,
} from "./segment-builder";

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

describe("date ops", () => {
  it("offers them on created_at and on date properties, keeping text ops on the property", () => {
    expect(opsFor("created_at")).toEqual(["before", "after", "in_last_days", "not_in_last_days"]);
    expect(opsFor("property:last_login")).not.toContain("in_last_days");
    const dated = opsFor("property:last_login", true);
    expect(dated.slice(0, 4)).toEqual(["before", "after", "in_last_days", "not_in_last_days"]);
    expect(dated).toContain("is_not_set");
    expect(defaultOp("property:last_login", true)).toBe("before");
    // A base text field never turns into a date field.
    expect(opsFor("email", true)).not.toContain("before");
  });

  it("takes a calendar date for before/after and a whole number of days up to 36500 for the rest", () => {
    expect(["before", "in_last_days", "is_set", "equals"].map(valueKind)).toEqual([
      "date",
      "days",
      "none",
      "text",
    ]);
    const row = (op: string, value: string) => ({ field: "property:last_login", op, value });
    expect(rowComplete(row("before", "2026-01-08"))).toBe(true);
    for (const days of ["1", " 30 ", "36500"]) {
      expect(rowComplete(row("in_last_days", days)), days).toBe(true);
    }
    for (const days of ["", "0", "1.5", "-3", "36501", "1e3"]) {
      expect(rowComplete(row("not_in_last_days", days)), days).toBe(false);
    }
  });
});

describe("op copy", () => {
  const segments = (locale: "en" | "pt-BR") =>
    createTranslator({
      locale,
      messages: { audience: locale === "en" ? en : pt },
      namespace: "audience.segments",
    });

  it("labels every op the builder offers, in both locales", () => {
    for (const catalog of [en, pt]) {
      for (const op of new Set(Object.values(OPS_BY_KIND).flat())) {
        expect(catalog.segments.op, op).toHaveProperty(op);
      }
    }
  });

  it("reads a pill's day count as a phrase", () => {
    expect(segments("en")("builder.days", { count: 1 })).toBe("1 day");
    expect(segments("en")("builder.daysAgo", { count: 36_500 })).toBe("36,500 days ago");
    expect(segments("pt-BR")("builder.days", { count: 30 })).toBe("30 dias");
    expect(segments("pt-BR")("builder.daysAgo", { count: 1 })).toBe("1 dia");
  });
});
