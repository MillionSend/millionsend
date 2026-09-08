import { expect, it } from "vitest";
import { contactPropertiesChange } from "../src/contact-properties.js";

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
