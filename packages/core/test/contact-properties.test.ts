import { expect, it } from "vitest";
import { contactPropertiesChange, storedPropertyValue } from "../src/contact-properties.js";

it("reports a change only for own keys: inherited names never count", () => {
  expect(contactPropertiesChange({ plan: "pro" }, { plan: "pro" })).toBe(false);
  expect(contactPropertiesChange({ plan: "pro" }, { plan: "free" })).toBe(true);
  expect(contactPropertiesChange({}, { plan: "pro" })).toBe(true);
  expect(contactPropertiesChange({ plan: "pro" }, {}, ["plan"])).toBe(true);
  // "toString" is inherited from Object.prototype, not stored on the contact.
  expect(contactPropertiesChange({}, {}, ["toString"])).toBe(false);
  expect(contactPropertiesChange({}, { toString: "x" })).toBe(true);
  // An own key whose value is the inherited method's string form still differs.
  expect(contactPropertiesChange({}, { constructor: "Object" })).toBe(true);
});

it("stores a value as its key's type takes it, or says what it must be", () => {
  expect(storedPropertyValue(undefined, " soon ")).toEqual({ ok: true, stored: " soon " });
  expect(storedPropertyValue("string", 3)).toEqual({ ok: true, stored: "3" });
  expect(storedPropertyValue("number", " 3 ")).toEqual({ ok: true, stored: " 3 " });
  expect(storedPropertyValue("date", " 2026-01-08 ")).toEqual({ ok: true, stored: "2026-01-08" });
  for (const value of ["", "many", "Infinity"]) {
    expect(storedPropertyValue("number", value)).toEqual({ ok: false, mustBe: "number" });
  }
  // "3" is a count, never 1970.
  for (const value of ["", "soon", "3", "2026-02-30"]) {
    expect(storedPropertyValue("date", value)).toEqual({ ok: false, mustBe: "date" });
  }
});
