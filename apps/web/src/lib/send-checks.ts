import { mailDomain } from "./format";

export type CheckTone = "warn" | "ok" | "info";

/** One row of the send dialog's checklist: a catalog key under compose.checks and its placeholders. */
export interface SendCheck {
  key: string;
  tone: CheckTone;
  params: Record<string, string | number>;
}

export interface SendCheckInput {
  subject: string;
  /** The body as plain text, as the send's text part carries it. */
  text: string;
  fromName: string | null;
  address: string;
  domain: {
    name: string;
    shared: boolean;
    verified: boolean;
    dmarc: "none" | "quarantine" | "reject" | null;
  } | null;
  recipientDomain: string | null;
  /** Whether the inbox and the recipient's domain have mail between them; null while not known. */
  contactBefore: boolean | null;
}

const wordCount = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

/** One token with an @ and a dotted host: enough to name a domain worth asking about. */
const ADDRESS_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/** The host of the first address typed into a To field, lowercased; null until one is complete. */
export function firstRecipientDomain(to: string): string | null {
  const first = to.split(/[,\s]+/).find((token) => ADDRESS_RE.test(token));
  return first ? mailDomain(first) : null;
}

/**
 * What a recipient's filters and a person reading the mail would notice,
 * in the order the dialog lists them. Nothing here blocks a send. Domain
 * rows share the "domain" key prefix: the collapsed all-clear row quotes
 * whichever applies.
 */
export function sendChecks(input: SendCheckInput): SendCheck[] {
  const subject = input.subject.trim();
  const bodyWords = wordCount(input.text);
  const name = input.fromName?.trim() || null;
  const checks: SendCheck[] = [
    wordCount(subject) < 2
      ? {
          key: "subjectShort",
          tone: "warn",
          params: { test: /^teste?\b/i.test(subject) ? "yes" : "no" },
        }
      : { key: "subjectOk", tone: "ok", params: {} },
    bodyWords < 8 || !input.text.trim().includes("\n")
      ? { key: "messageShort", tone: "warn", params: { n: bodyWords } }
      : { key: "messageOk", tone: "ok", params: {} },
    name
      ? { key: "senderName", tone: "ok", params: { name, address: input.address } }
      : { key: "noSenderName", tone: "warn", params: {} },
  ];
  const domain = input.domain;
  if (domain) {
    const params = { domain: domain.name };
    checks.push(
      domain.shared
        ? { key: "domainShared", tone: "ok", params }
        : !domain.verified
          ? { key: "domainUnverified", tone: "warn", params }
          : domain.dmarc === null
            ? { key: "domainNoDmarc", tone: "warn", params }
            : { key: "domainAligned", tone: "ok", params: { ...params, policy: domain.dmarc } },
    );
  }
  if (input.recipientDomain && input.contactBefore === false) {
    checks.push({ key: "firstContact", tone: "info", params: { domain: input.recipientDomain } });
  }
  return checks;
}
