import { describe, expect, it } from "vitest";
import {
  type AuthDetail,
  type DeliverEnvelope,
  decodeEnvelopeHeader,
  deliverEnvelopeSchema,
  encodeEnvelopeHeader,
  MAX_ALIGNED_DKIM_DOMAINS,
  MAX_ENVELOPE_RECIPIENT_BYTES,
  MX_TEMPORARY_FAILURE,
  rcptRequestSchema,
  rcptResponseSchema,
  smtpReplySchema,
} from "../src/receiving/protocol.js";

const envelope: DeliverEnvelope = {
  mailFrom: "",
  recipients: ["agent@inbound.acme.test"],
  clientIp: "2001:db8::1",
  helo: "mail.sender.example",
  tls: null,
  auth: { spf: "none", dkim: "fail", dmarc: "none", arc: "none" },
  receivedAt: "2026-10-11T12:00:00.000Z",
};

describe("MX ↔ app wire contract", () => {
  it("round-trips the envelope header and refuses anything malformed", () => {
    expect(decodeEnvelopeHeader(encodeEnvelopeHeader(envelope))).toEqual(envelope);
    for (const bad of [
      undefined,
      "",
      "not-base64!",
      Buffer.from("{}").toString("base64url"),
      encodeEnvelopeHeader({ ...envelope, recipients: [] }),
      encodeEnvelopeHeader({ ...envelope, clientIp: "999.1.1.1" }),
      encodeEnvelopeHeader({ ...envelope, auth: { ...envelope.auth, spf: "maybe" as "pass" } }),
    ]) {
      expect(decodeEnvelopeHeader(bad)).toBeNull();
    }
  });

  it("keeps the encoded header under Node's 16 KiB header limit", () => {
    const local = "a".repeat(200);
    const recipients: string[] = [];
    while ((recipients.length + 1) * 220 <= MAX_ENVELOPE_RECIPIENT_BYTES) {
      recipients.push(`${local}${recipients.length}@inbound.example.test`.slice(0, 220));
    }
    const domain = (c: string) => `${c.repeat(249)}.com`;
    const authDetail: AuthDetail = {
      spf: { result: "temperror", domain: domain("s") },
      dkim: {
        aligned: Array.from({ length: MAX_ALIGNED_DKIM_DOMAINS }, (_, i) => domain(String(i))),
      },
      dmarc: { result: "permerror", policy: "quarantine", domain: domain("d") },
    };
    const biggest = {
      ...envelope,
      mailFrom: `${"m".repeat(300)}@x.example`.slice(0, 320),
      helo: "h".repeat(255),
      recipients,
      tls: { protocol: "p".repeat(32), cipher: "c".repeat(128) },
      authDetail,
    };
    const header = encodeEnvelopeHeader(biggest);
    expect(decodeEnvelopeHeader(header)).not.toBeNull();
    expect(header.length).toBeLessThan(14 * 1024);
    expect(
      decodeEnvelopeHeader(
        encodeEnvelopeHeader({ ...biggest, recipients: [...recipients, `${local}@x.test`] }),
      ),
    ).toBeNull();
  });

  it("carries authDetail optionally both ways: an old app ignores it, a new one does without it (S35)", () => {
    const authDetail: AuthDetail = {
      spf: { result: "pass", domain: "mail.sender.example" },
      dkim: { aligned: ["sender.example"] },
      dmarc: { result: "pass", policy: "none", domain: "sender.example" },
    };
    const header = encodeEnvelopeHeader({ ...envelope, authDetail });
    expect(decodeEnvelopeHeader(header)?.authDetail).toEqual(authDetail);
    // An app that predates authDetail parses the same header and drops it.
    const before = deliverEnvelopeSchema.omit({ authDetail: true });
    expect(before.safeParse(JSON.parse(Buffer.from(header, "base64url").toString())).success).toBe(
      true,
    );
    expect(decodeEnvelopeHeader(encodeEnvelopeHeader(envelope))?.authDetail).toBeUndefined();
    // A malformed detail is dropped, never a refused delivery the MX would retry forever.
    const bad = {
      ...authDetail,
      dkim: { aligned: ["UPPER.example", "a.example", "b.example", "c.example"] },
    };
    const decoded = decodeEnvelopeHeader(encodeEnvelopeHeader({ ...envelope, authDetail: bad }));
    expect(decoded).not.toBeNull();
    expect(decoded?.authDetail).toBeUndefined();
  });

  it("only lets single-line printable SMTP replies through", () => {
    expect(smtpReplySchema.safeParse(MX_TEMPORARY_FAILURE).success).toBe(true);
    expect(
      smtpReplySchema.safeParse({ code: 550, enhanced: "5.1.1", message: "ok\r\n250 smuggled" })
        .success,
    ).toBe(false);
    expect(smtpReplySchema.safeParse({ code: 250, enhanced: "2.0.0", message: "ok" }).success).toBe(
      false,
    );
  });

  it("parses both RCPT answers and the request", () => {
    expect(rcptResponseSchema.parse({ accept: true, ttlSeconds: 30 })).toEqual({
      accept: true,
      ttlSeconds: 30,
    });
    expect(
      rcptResponseSchema.parse({
        accept: false,
        code: 452,
        enhanced: "4.2.2",
        message: "over quota",
        ttlSeconds: 0,
      }),
    ).toMatchObject({ accept: false, code: 452 });
    expect(rcptResponseSchema.safeParse({ accept: false, ttlSeconds: 5 }).success).toBe(false);
    expect(
      rcptRequestSchema.safeParse({
        recipient: "a@b.test",
        mailFrom: "",
        clientIp: "192.0.2.1",
        helo: "x",
      }).success,
    ).toBe(true);
  });
});
