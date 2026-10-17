import { describe, expect, it } from "vitest";
import { inboxKeyAllows } from "../src/inboxes/api-key-scope.js";

const OWN = "6f1c2d3e-4a5b-4c6d-8e7f-90a1b2c3d4e5";
const OTHER = "0b9c8d7e-6f5a-4b3c-9d2e-1f0a9b8c7d6e";
const T = "11111111-2222-4333-8444-555555555555";
const E = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

describe("inboxKeyAllows", () => {
  it("admits every allow-listed route of the key's own inbox", () => {
    const allowed: [string, string][] = [
      ["GET", "/inboxes"],
      ["GET", `/inboxes/${OWN}`],
      ["GET", "/inboxes/bot%40acme.test"],
      ["GET", "/inboxes/bot@acme.test"],
      ["GET", `/inboxes/${OWN}/safety`],
      ["GET", `/inboxes/${OWN}/agent`],
      ["GET", `/inboxes/${OWN}/labels`],
      ["POST", `/inboxes/${OWN}/labels`],
      ["PATCH", `/inboxes/${OWN}/labels/${T}`],
      ["DELETE", `/inboxes/${OWN}/labels/${T}`],
      ["GET", `/inboxes/${OWN}/codes/latest`],
      ["POST", `/inboxes/${OWN}/quarantine/${E}/release`],
      ["GET", `/inboxes/${OWN}/threads`],
      ["GET", `/inboxes/${OWN}/threads/search`],
      ["GET", `/inboxes/${OWN}/threads/${T}`],
      ["PATCH", `/inboxes/${OWN}/threads/${T}`],
      ["DELETE", `/inboxes/${OWN}/threads/${T}`],
      ["GET", `/inboxes/${OWN}/threads/${T}/emails`],
      ["GET", `/inboxes/${OWN}/threads/${T}/emails/${E}`],
      ["POST", `/inboxes/${OWN}/threads/${T}/emails/${E}/reply`],
      ["POST", `/inboxes/${OWN}/threads/${T}/emails/${E}/forward`],
      ["GET", `/inboxes/${OWN}/drafts`],
      ["POST", `/inboxes/${OWN}/drafts`],
      ["GET", `/inboxes/${OWN}/drafts/${T}`],
      ["PATCH", `/inboxes/${OWN}/drafts/${T}`],
      ["DELETE", `/inboxes/${OWN}/drafts/${T}`],
      ["POST", `/inboxes/${OWN}/drafts/${T}/send`],
      ["GET", "/emails/receiving"],
      ["GET", `/emails/receiving/${E}`],
      ["GET", `/emails/receiving/${E}/attachments`],
      ["GET", `/emails/receiving/${E}/attachments/${T}`],
      ["POST", `/emails/receiving/${E}/reply`],
      ["POST", `/emails/receiving/${E}/forward`],
      ["POST", "/emails"],
      ["POST", "/emails/batch"],
    ];
    for (const [method, path] of allowed) {
      expect(inboxKeyAllows(method, path, OWN), `${method} ${path}`).toBe(true);
    }
    // Ids compare regardless of case, as Postgres compares uuids.
    expect(inboxKeyAllows("get", `/inboxes/${OWN.toUpperCase()}/threads`, OWN)).toBe(true);
  });

  it("refuses another inbox, owner-only inbox routes and every other surface", () => {
    const refused: [string, string][] = [
      // Another inbox, through every family.
      ["GET", `/inboxes/${OTHER}`],
      ["GET", `/inboxes/${OTHER}/threads`],
      ["GET", `/inboxes/${OTHER}/threads/${T}/emails/${E}`],
      ["POST", `/inboxes/${OTHER}/drafts`],
      ["GET", `/inboxes/${OTHER}/codes/latest`],
      ["POST", `/inboxes/${OTHER}/quarantine/${E}/release`],
      // Exposure and approval stay with people and team keys.
      ["POST", "/inboxes"],
      ["PATCH", `/inboxes/${OWN}`],
      ["DELETE", `/inboxes/${OWN}`],
      ["PATCH", `/inboxes/${OWN}/safety`],
      ["PATCH", `/inboxes/${OWN}/agent`],
      ["GET", `/inboxes/${OWN}/quarantine`],
      ["POST", `/inboxes/${OWN}/drafts/${T}/reject`],
      ["DELETE", `/emails/receiving/${E}`],
      // The rest of the API.
      ["GET", "/emails"],
      ["GET", `/emails/${E}`],
      ["PATCH", `/emails/${E}`],
      ["POST", `/emails/${E}/cancel`],
      ["GET", "/domains"],
      ["POST", "/api-keys"],
      ["GET", "/api-keys"],
      ["GET", "/webhooks"],
      ["GET", "/contacts"],
      ["GET", "/usage"],
      ["GET", "/segments"],
      ["GET", "/broadcasts"],
      // A method the table never names, and a route added later.
      ["HEAD", "/inboxes"],
      ["PUT", `/inboxes/${OWN}/labels/${T}`],
      ["GET", `/inboxes/${OWN}/threads/${T}/emails/${E}/attachments`],
      // Shapes that must not slip through.
      ["GET", "/inboxes/"],
      ["GET", `/inboxes/${OWN}/`],
      ["GET", `/inboxes//${OWN}`],
      ["GET", `/inboxes/${OWN}%2F..%2F${OTHER}/threads`],
      ["GET", "/inboxes/%E0%A4%A/threads"],
      ["GET", "inboxes"],
    ];
    for (const [method, path] of refused) {
      expect(inboxKeyAllows(method, path, OWN), `${method} ${path}`).toBe(false);
    }
  });
});
