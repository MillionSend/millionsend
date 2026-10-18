import { describe, expect, it } from "vitest";
import { firstRecipientDomain, type SendCheckInput, sendChecks } from "@/lib/send-checks";

const own = { name: "acme.example", shared: false, verified: true, dmarc: "reject" as const };
const good: SendCheckInput = {
  subject: "Your order shipped",
  text: "Hi Ana,\n\nYour order left the warehouse this morning.\n\nThanks,\nMo",
  fromName: "Mo at Acme",
  address: "mo@acme.example",
  domain: own,
  recipientDomain: "example.com",
  contactBefore: true,
};

describe("sendChecks", () => {
  it("finds nothing worth a look in a message that reads like a person's", () => {
    const rows = sendChecks(good);
    expect(rows).toEqual([
      { key: "subjectOk", tone: "ok", params: {} },
      { key: "messageOk", tone: "ok", params: {} },
      { key: "senderName", tone: "ok", params: { name: "Mo at Acme", address: "mo@acme.example" } },
      { key: "domainAligned", tone: "ok", params: { domain: "acme.example", policy: "reject" } },
    ]);
    expect(rows.filter((row) => row.tone === "warn")).toHaveLength(0);
  });

  it("flags a one-word subject, and Test by name in either language", () => {
    expect(sendChecks({ ...good, subject: "Hello" })[0]).toEqual({
      key: "subjectShort",
      tone: "warn",
      params: { test: "no" },
    });
    expect(sendChecks({ ...good, subject: " test " })[0]?.params).toEqual({ test: "yes" });
    expect(sendChecks({ ...good, subject: "Teste" })[0]?.params).toEqual({ test: "yes" });
    expect(sendChecks({ ...good, subject: "Testing 1 2" })[0]?.key).toBe("subjectOk");
  });

  it("flags a short or single-line message with its word count", () => {
    expect(sendChecks({ ...good, text: "Hi,\n\nThanks" })[1]).toEqual({
      key: "messageShort",
      tone: "warn",
      params: { n: 2 },
    });
    const oneLine = "Your order left the warehouse this morning and should be there on Monday";
    expect(sendChecks({ ...good, text: oneLine })[1]?.key).toBe("messageShort");
  });

  it("warns without a sender name, a blank one included", () => {
    expect(sendChecks({ ...good, fromName: null })[2]).toEqual({
      key: "noSenderName",
      tone: "warn",
      params: {},
    });
    expect(sendChecks({ ...good, fromName: "  " })[2]?.key).toBe("noSenderName");
  });

  it("reads the domain's standing, and has no row without a domain", () => {
    const domainRow = (domain: SendCheckInput["domain"]) => sendChecks({ ...good, domain })[3];
    const params = { domain: "acme.example" };
    expect(domainRow({ ...own, shared: true, dmarc: null })).toEqual({
      key: "domainShared",
      tone: "ok",
      params,
    });
    expect(domainRow({ ...own, dmarc: null })).toEqual({
      key: "domainNoDmarc",
      tone: "warn",
      params,
    });
    expect(domainRow({ ...own, verified: false, dmarc: null })).toEqual({
      key: "domainUnverified",
      tone: "warn",
      params,
    });
    expect(sendChecks({ ...good, domain: null })).toHaveLength(3);
  });

  it("notes a first contact only once the history is known to be empty", () => {
    expect(sendChecks({ ...good, contactBefore: false }).at(-1)).toEqual({
      key: "firstContact",
      tone: "info",
      params: { domain: "example.com" },
    });
    expect(sendChecks({ ...good, contactBefore: null })).toHaveLength(4);
    expect(sendChecks({ ...good, recipientDomain: null, contactBefore: false })).toHaveLength(4);
  });

  it("counts the warnings over every row, the info row included", () => {
    const rows = sendChecks({
      subject: "",
      text: "",
      fromName: null,
      address: "mo@acme.example",
      domain: { ...own, verified: false },
      recipientDomain: "example.com",
      contactBefore: false,
    });
    expect(rows).toHaveLength(5);
    expect(rows.filter((row) => row.tone === "warn")).toHaveLength(4);
  });
});

describe("firstRecipientDomain", () => {
  it("reads the host of the first token that is an address", () => {
    expect(firstRecipientDomain("")).toBeNull();
    expect(firstRecipientDomain("ana@")).toBeNull();
    expect(firstRecipientDomain("nope, Ana@Example.com beto@acme.example")).toBe("example.com");
  });
});
