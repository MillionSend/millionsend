import { z } from "zod";

/**
 * The wire contract between the MX (apps/mx, PROCESS=mx) and the app's
 * internal MX API. Both sides import it, and it must import nothing but zod:
 * the MX boots with only its MX_* variables, no app configuration and no
 * database (see apps/mx/src/env.ts).
 *
 * Per RCPT TO the MX POSTs a RcptRequest to {MX_INGEST_URL}/rcpt and gets a
 * RcptResponse with HTTP 200. After DATA it POSTs the raw message
 * (application/octet-stream) to {MX_INGEST_URL}/deliver with the envelope in
 * MX_ENVELOPE_HEADER; HTTP 200 means stored durably (the MX replies 250),
 * MX_DELIVER_PERMANENT_STATUS and MX_DELIVER_TEMPORARY_STATUS carry an
 * SmtpReply the MX relays as is, and anything else (another status, a
 * timeout, a network error) is MX_TEMPORARY_FAILURE. Every call carries
 * `Authorization: Bearer <MX_INGEST_SECRET>`.
 */

/** Where the API mounts the internal MX endpoints: MX_INGEST_URL is the API's public origin plus this. */
export const MX_INGEST_PATH = "/internal/mx";
export const MX_RCPT_PATH = "/rcpt";
export const MX_DELIVER_PATH = "/deliver";

/** MX_INGEST_SECRET's minimum length, on the app and on the MX alike. */
export const MX_INGEST_SECRET_MIN_LENGTH = 32;

/** Largest message the MX accepts (its SMTP SIZE) and the app stores: 40 MiB. */
export const MAX_RECEIVED_MESSAGE_BYTES = 40 * 1024 * 1024;

/** Most envelope recipients one delivery may carry. */
export const MAX_DELIVER_RECIPIENTS = 100;

/**
 * Most bytes the envelope recipients of one delivery may add up to. The
 * envelope travels base64url-encoded in a single request header, and Node's
 * HTTP server refuses requests whose headers pass 16 KiB in total; at this
 * budget the encoded header stays near 13 KiB in the worst case. Catch-all
 * domains accept any local part, so the MX enforces it at RCPT time (452,
 * the sender retries the rest in another transaction).
 */
export const MAX_ENVELOPE_RECIPIENT_BYTES = 8 * 1024;

/** The header that carries the DeliverEnvelope on POST /deliver, as base64url JSON. */
export const MX_ENVELOPE_HEADER = "x-millionsend-envelope";

/** /deliver answers that carry an SmtpReply for the MX to relay. */
export const MX_DELIVER_PERMANENT_STATUS = 422;
export const MX_DELIVER_TEMPORARY_STATUS = 429;

const ip = z.union([z.ipv4(), z.ipv6()]);
const address = z.string().min(3).max(320);
/** The reverse-path without angle brackets; "" is the null sender <> of bounces. */
const reversePath = z.string().max(320);

export const rcptRequestSchema = z.object({
  recipient: address,
  mailFrom: reversePath,
  clientIp: ip,
  helo: z.string().max(255),
});
export type RcptRequest = z.infer<typeof rcptRequestSchema>;

/**
 * An SMTP reply the MX writes to the client verbatim, so the text is
 * printable ASCII on one line: anything else would let the app (or a value
 * that reached it) inject reply lines into the session.
 */
export const smtpReplySchema = z.object({
  code: z.number().int().min(400).max(599),
  enhanced: z.string().regex(/^[45]\.\d{1,3}\.\d{1,3}$/),
  message: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[\x20-\x7e]+$/),
});
export type SmtpReply = z.infer<typeof smtpReplySchema>;

/** How long the MX may reuse an answer for the recipient's domain. */
const ttlSeconds = z.number().int().min(0).max(3600);

export const rcptResponseSchema = z.union([
  z.object({ accept: z.literal(true), ttlSeconds }),
  smtpReplySchema.extend({ accept: z.literal(false), ttlSeconds }),
]);
export type RcptResponse = z.infer<typeof rcptResponseSchema>;

/** The reply whenever the app cannot answer: the sender keeps the message and retries for days. */
export const MX_TEMPORARY_FAILURE: SmtpReply = {
  code: 451,
  enhanced: "4.3.0",
  message: "Temporary local problem, please try again later",
};

/** mailauth's verdict vocabulary, lowercase. */
export const AUTH_RESULTS = [
  "pass",
  "fail",
  "softfail",
  "neutral",
  "none",
  "temperror",
  "permerror",
  "policy",
] as const;
export type AuthResult = (typeof AUTH_RESULTS)[number];

const authResult = z.enum(AUTH_RESULTS);

/**
 * One verdict per check, as Resend reads them. DKIM folds every signature
 * into one: pass when a signature aligned with From passed, policy when only
 * others did, otherwise the first signature's result, none without one.
 * DMARC reads none under a p=none policy once SPF or DKIM passed.
 */
export const authVerdictsSchema = z.object({
  spf: authResult,
  dkim: authResult,
  dmarc: authResult,
  arc: authResult,
});
export type AuthVerdicts = z.infer<typeof authVerdictsSchema>;

export const deliverEnvelopeSchema = z.object({
  mailFrom: reversePath,
  recipients: z
    .array(address)
    .min(1)
    .max(MAX_DELIVER_RECIPIENTS)
    .refine(
      (list) => list.reduce((sum, r) => sum + r.length, 0) <= MAX_ENVELOPE_RECIPIENT_BYTES,
      "recipients exceed the envelope byte budget",
    ),
  clientIp: ip,
  helo: z.string().max(255),
  /** Null when the session never upgraded with STARTTLS. */
  tls: z
    .object({ protocol: z.string().max(32), cipher: z.string().max(128) })
    .partial()
    .nullable(),
  auth: authVerdictsSchema,
  receivedAt: z.iso.datetime({ offset: true }),
});
export type DeliverEnvelope = z.infer<typeof deliverEnvelopeSchema>;

export function encodeEnvelopeHeader(envelope: DeliverEnvelope): string {
  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
}

/** The envelope a /deliver request carries, or null when the header is missing or malformed. */
export function decodeEnvelopeHeader(value: string | null | undefined): DeliverEnvelope | null {
  if (!value) return null;
  try {
    const parsed = deliverEnvelopeSchema.safeParse(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
