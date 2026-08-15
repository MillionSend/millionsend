import { describe, expect, it } from "vitest";
import { pickActive } from "@/lib/nav";

const AUDIENCE_TABS = [
  "/audience",
  "/audience/properties",
  "/audience/segments",
  "/audience/topics",
];

describe("pickActive (Audience tab highlight)", () => {
  it("keeps Contacts active on /audience and every per-audience URL", () => {
    expect(pickActive("/audience", AUDIENCE_TABS)).toBe("/audience");
    expect(pickActive("/audience/abc-123", AUDIENCE_TABS)).toBe("/audience");
    expect(pickActive("/audience/abc-123/contacts/c-9", AUDIENCE_TABS)).toBe("/audience");
  });

  it("lets a nested section beat its parent prefix", () => {
    expect(pickActive("/audience/segments", AUDIENCE_TABS)).toBe("/audience/segments");
    expect(pickActive("/audience/segments/new", AUDIENCE_TABS)).toBe("/audience/segments");
    expect(pickActive("/audience/topics", AUDIENCE_TABS)).toBe("/audience/topics");
  });

  it("returns undefined off-section", () => {
    expect(pickActive("/emails", AUDIENCE_TABS)).toBeUndefined();
  });
});
