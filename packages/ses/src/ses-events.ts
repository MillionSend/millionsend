/**
 * Strict parsing of SES event-publishing payloads (the JSON inside a
 * verified SNS Notification's Message). Only fields the pipeline consumes
 * are extracted; the mapping from event to email row happens exclusively via
 * the server-recorded SES MessageId — never via any client-suppliable field.
 */

export type SesEventType =
  | "Send"
  | "Delivery"
  | "DeliveryDelay"
  | "Bounce"
  | "Complaint"
  | "Open"
  | "Click"
  | "Reject"
  | "Rendering Failure";

export interface ParsedSesEvent {
  eventType: SesEventType;
  sesMessageId: string;
  occurredAt: Date;
  bounce?: {
    bounceType: "Permanent" | "Transient" | "Undetermined";
    bounceSubType: string;
    recipients: string[];
    diagnosticCode?: string;
  };
  complaint?: {
    complaintFeedbackType?: string;
    recipients: string[];
  };
  delivery?: { smtpResponse?: string; processingTimeMillis?: number };
  click?: { link?: string };
  /** Raw payload subset persisted to email_events.data for debugging. */
  data: Record<string, unknown>;
}

const EVENT_TYPES: readonly SesEventType[] = [
  "Send",
  "Delivery",
  "DeliveryDelay",
  "Bounce",
  "Complaint",
  "Open",
  "Click",
  "Reject",
  "Rendering Failure",
];

export function parseSesEvent(raw: unknown): ParsedSesEvent | null {
  if (raw === null || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  // Event publishing uses eventType; legacy notifications use notificationType.
  const eventType = (obj.eventType ?? obj.notificationType) as SesEventType | undefined;
  if (!eventType || !EVENT_TYPES.includes(eventType)) return null;
  const mail = obj.mail as Record<string, unknown> | undefined;
  const sesMessageId = mail?.messageId;
  if (typeof sesMessageId !== "string" || sesMessageId.length === 0) return null;

  const timestampSource =
    (obj[camel(eventType)] as Record<string, unknown> | undefined)?.timestamp ?? mail?.timestamp;
  const occurredAt = typeof timestampSource === "string" ? new Date(timestampSource) : new Date();
  if (Number.isNaN(occurredAt.getTime())) return null;

  const parsed: ParsedSesEvent = {
    eventType,
    sesMessageId,
    occurredAt,
    data: { eventType },
  };

  if (eventType === "Bounce") {
    const b = obj.bounce as Record<string, unknown> | undefined;
    const bounceType = b?.bounceType;
    if (bounceType !== "Permanent" && bounceType !== "Transient" && bounceType !== "Undetermined") {
      return null;
    }
    const bounced = Array.isArray(b?.bouncedRecipients)
      ? (b.bouncedRecipients as Record<string, unknown>[])
      : [];
    const diagnosticCode = bounced[0]?.diagnosticCode;
    parsed.bounce = {
      bounceType,
      bounceSubType: typeof b?.bounceSubType === "string" ? b.bounceSubType : "Unknown",
      recipients: extractRecipients(b?.bouncedRecipients),
      ...(typeof diagnosticCode === "string" ? { diagnosticCode } : {}),
    };
    parsed.data.bounce = b;
  }
  if (eventType === "Complaint") {
    const c = obj.complaint as Record<string, unknown> | undefined;
    parsed.complaint = {
      recipients: extractRecipients(c?.complainedRecipients),
      ...(typeof c?.complaintFeedbackType === "string"
        ? { complaintFeedbackType: c.complaintFeedbackType }
        : {}),
    };
    parsed.data.complaint = c;
  }
  if (eventType === "Delivery") {
    const d = obj.delivery as Record<string, unknown> | undefined;
    parsed.delivery = {
      ...(typeof d?.smtpResponse === "string" ? { smtpResponse: d.smtpResponse } : {}),
      ...(typeof d?.processingTimeMillis === "number"
        ? { processingTimeMillis: d.processingTimeMillis }
        : {}),
    };
    parsed.data.delivery = d;
  }
  if (eventType === "Click") {
    const k = obj.click as Record<string, unknown> | undefined;
    parsed.click = { ...(typeof k?.link === "string" ? { link: k.link } : {}) };
    parsed.data.click = k;
  }
  return parsed;
}

function extractRecipients(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((r) =>
      r !== null && typeof r === "object"
        ? (r as { emailAddress?: unknown }).emailAddress
        : undefined,
    )
    .filter((e): e is string => typeof e === "string");
}

function camel(eventType: SesEventType): string {
  return eventType === "Rendering Failure"
    ? "failure"
    : eventType.charAt(0).toLowerCase() + eventType.slice(1).replace(" ", "");
}
