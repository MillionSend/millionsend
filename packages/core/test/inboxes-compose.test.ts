import { describe, expect, it } from "vitest";
import {
  forwardDate,
  forwardedMessage,
  forwardSubject,
  msgIds,
  REFERENCES_MAX,
  replyHeaders,
  replyRecipients,
  replySubject,
  withThreadToken,
} from "../src/inboxes/compose.js";
import { outgoingSecretValues } from "../src/receiving/codes.js";

const TOKEN = "<ms1.AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB@inbound.acme.test>";

describe("threading headers", () => {
  it("reads only <msg-id> tokens, each once, in order", () => {
    expect(msgIds("<a@x> junk <b@y>\r\nX-Injected: 1 <a@x>")).toEqual(["<a@x>", "<b@y>"]);
    expect(msgIds(["<a@x>", "<c@z>"])).toEqual(["<a@x>", "<c@z>"]);
    expect(msgIds(undefined)).toEqual([]);
    expect(msgIds(`<${"a".repeat(1000)}@x>`)).toEqual([]);
  });

  it("answers the parent: In-Reply-To its Message-ID, References its own plus it, room left for the token", () => {
    const parentRefs = Array.from({ length: 30 }, (_, i) => `<r${i}@x>`);
    const h = replyHeaders({ messageId: "<parent@x>", references: parentRefs });
    expect(h["In-Reply-To"]).toBe("<parent@x>");
    const refs = msgIds(h.References);
    expect(refs).toHaveLength(REFERENCES_MAX - 1);
    expect(refs.at(-1)).toBe("<parent@x>");
    expect(replyHeaders({ messageId: null, references: [] })).toEqual({});
  });

  it("leads References with the thread token, replacing a header of any case, capped at 20", () => {
    const headers = withThreadToken(
      { references: Array.from({ length: 25 }, (_, i) => `<r${i}@x>`).join(" "), "X-A": "1" },
      TOKEN,
    );
    expect(Object.keys(headers)).toEqual(["X-A", "References"]);
    const refs = msgIds(headers.References);
    expect(refs[0]).toBe(TOKEN);
    expect(refs).toHaveLength(REFERENCES_MAX);
    expect(refs.at(-1)).toBe("<r24@x>");
    expect(msgIds(withThreadToken({ References: TOKEN }, TOKEN).References)).toEqual([TOKEN]);
  });
});

describe("subjects and the forward quote", () => {
  it("prefixes Re: and Fwd: once", () => {
    expect(replySubject("Invoice")).toBe("Re: Invoice");
    expect(replySubject("RE: Invoice")).toBe("RE: Invoice");
    expect(replySubject(null)).toBe("Re:");
    expect(forwardSubject("Invoice")).toBe("Fwd: Invoice");
    expect(forwardSubject("Fw: Invoice")).toBe("Fw: Invoice");
  });

  it("dates the quote the way the forwarded block shows it, in UTC", () => {
    expect(forwardDate(new Date("2026-08-05T14:03:11.229Z"))).toBe("Wed, Aug 5, 2026 at 2:03 PM");
  });

  it("quotes the original under the marker, after the note, in both parts", () => {
    const original = {
      from: "Ada <ada@example.org>",
      date: new Date("2026-08-05T14:03:11Z"),
      subject: "Plans",
      to: ["support@acme.test"],
      html: "<p>See <b>attached</b></p>",
      text: "See attached",
    };
    const out = forwardedMessage({ html: null, text: "FYI <team>" }, original);
    expect(out.text).toBe(
      "FYI <team>\n\n---------- Forwarded message ---------\nFrom: Ada <ada@example.org>\nDate: Wed, Aug 5, 2026 at 2:03 PM\nSubject: Plans\nTo: support@acme.test\n\nSee attached",
    );
    expect(out.html).toContain('FYI &lt;team&gt;<br><br><div class="gmail_quote">');
    expect(out.html).toContain("From: Ada &lt;ada@example.org&gt;");
    expect(out.html).toContain("<p>See <b>attached</b></p></div>");
    const textOnly = forwardedMessage({ html: null, text: null }, { ...original, html: null });
    expect(textOnly.html).toBeNull();
    expect(textOnly.text.startsWith("---------- Forwarded message ---------")).toBe(true);
  });
});

describe("replyRecipients", () => {
  const inbound = {
    direction: "inbound" as const,
    from: "ada@example.org",
    replyTo: [] as string[],
    to: ["support@acme.test", "Bob <bob@example.org>"],
    cc: ["carol@example.org"],
  };
  const own = ["support@acme.test"];

  it("answers the sender, or its Reply-To; never copies bcc", () => {
    expect(replyRecipients({ target: inbound, replyAll: false, own, cc: [], bcc: [] })).toEqual({
      to: ["ada@example.org"],
      cc: [],
      bcc: [],
    });
    expect(
      replyRecipients({
        target: { ...inbound, replyTo: ["help@example.org"] },
        replyAll: false,
        own,
        cc: [],
        bcc: ["audit@acme.test"],
      }),
    ).toEqual({ to: ["help@example.org"], cc: [], bcc: ["audit@acme.test"] });
  });

  it("reply_all copies the other recipients to cc, the inbox's own address and duplicates aside", () => {
    expect(
      replyRecipients({
        target: inbound,
        replyAll: true,
        own,
        cc: ["ADA@example.org", "dan@example.org"],
        bcc: [],
      }),
    ).toEqual({
      to: ["ada@example.org"],
      cc: ["Bob <bob@example.org>", "carol@example.org", "dan@example.org"],
      bcc: [],
    });
  });

  it("answers mail the inbox sent to its own recipients, and reply_all copies its cc", () => {
    expect(
      replyRecipients({
        target: { direction: "outbound", to: ["x@example.org"], cc: ["y@example.org"] },
        replyAll: true,
        own,
        cc: [],
        bcc: [],
      }),
    ).toEqual({ to: ["x@example.org"], cc: ["y@example.org"], bcc: [] });
  });
});

describe("outgoingSecretValues", () => {
  it("normalizes codes as ingest stores them: uppercase, no separators, prefix dropped", () => {
    const values = outgoingSecretValues(
      "Your code",
      "Use 482 913 or G-123456 or xk7-92f, or XK7-92F.",
      null,
    );
    expect(values).toEqual(expect.arrayContaining(["482913", "123456", "XK792F"]));
  });

  it("takes links without their fragment and the tokens inside them", () => {
    const token = "a1B2c3D4e5F6g7H8i9J0k1L2";
    const values = outgoingSecretValues(
      "Sign in",
      null,
      `<p><a href="https://app.example.com/magic/${token}?u=1#frag">Sign in</a></p>`,
    );
    expect(values).toEqual(
      expect.arrayContaining([`https://app.example.com/magic/${token}?u=1`, token]),
    );
    expect(values.some((v) => v.includes("#frag"))).toBe(false);
  });

  it("takes token-like runs from plain text and nothing from plain prose", () => {
    expect(outgoingSecretValues("Hi", `key=${"Zx9".repeat(8)} done`, null)).toContain(
      "Zx9".repeat(8),
    );
    expect(outgoingSecretValues("Hello there", "See you soon.", null)).toEqual([]);
  });
});
