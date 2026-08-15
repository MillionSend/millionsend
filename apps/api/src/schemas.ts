import { z } from "@hono/zod-openapi";
import { DAY_MS, extractAddrSpec } from "@millionsend/core";

/**
 * Wire-compatible with Resend's documented /emails surface
 * (docs/resend-compatibility.md): field names, shapes, and error format must
 * not drift — the contract test runs the official `resend` SDK against us.
 */

const emailAddress = z.string().refine((v) => z.email().safeParse(extractAddrSpec(v)).success, {
  message: "must be a valid email address (display names allowed)",
});

const recipientList = z
  .union([emailAddress, z.array(emailAddress).min(1).max(50)])
  .transform((v) => (Array.isArray(v) ? v : [v]));

export const sendEmailRequestSchema = z
  .object({
    from: emailAddress.openapi({ example: "Acme <onboarding@acme.dev>" }),
    to: recipientList.openapi({ example: ["delivered@resend.dev"] }),
    subject: z.string().min(1),
    html: z.string().optional(),
    text: z.string().optional(),
    cc: recipientList.optional(),
    bcc: recipientList.optional(),
    reply_to: recipientList.optional(),
    // Capped at 30 days ahead (Resend's own limit). Also keeps a scheduled
    // send from outliving the default body-retention window.
    scheduled_at: z.iso
      .datetime({ offset: true })
      .refine((v) => new Date(v).getTime() <= Date.now() + 30 * DAY_MS, {
        message: "scheduled_at cannot be more than 30 days in the future",
      })
      .optional(),
    tags: z.array(z.object({ name: z.string().min(1), value: z.string() })).optional(),
    // Accepted into the schema so we can reject loudly instead of silently
    // stripping — "never an incompatible subset" (docs/resend-compatibility.md).
    attachments: z.array(z.unknown()).optional(),
  })
  .refine((v) => v.html !== undefined || v.text !== undefined, {
    message: "Either html or text must be provided",
  })
  .openapi("SendEmailRequest");

export type SendEmailRequest = z.infer<typeof sendEmailRequestSchema>;

export const sendEmailResponseSchema = z.object({ id: z.uuid() }).openapi("SendEmailResponse");

export const getEmailResponseSchema = z
  .object({
    object: z.literal("email"),
    id: z.uuid(),
    from: z.string(),
    to: z.array(z.string()),
    cc: z.array(z.string()).nullable(),
    bcc: z.array(z.string()).nullable(),
    reply_to: z.array(z.string()).nullable(),
    subject: z.string(),
    html: z.string().nullable(),
    text: z.string().nullable(),
    created_at: z.string(),
    scheduled_at: z.string().nullable(),
    last_event: z.string(),
  })
  .openapi("GetEmailResponse");

export const errorSchema = z
  .object({
    statusCode: z.number(),
    name: z.string(),
    message: z.string(),
  })
  .openapi("ErrorResponse");

/**
 * Audiences/contacts. The resend SDK (v6+) reaches this surface through two
 * prefixes: `resend.audiences.*` hits /segments (object: "segment") while
 * `resend.contacts.*` hits /audiences/{id}/contacts (and /segments/{id}/contacts
 * for list) — both prefixes serve the same handlers, so `object` is a string.
 */

export const createAudienceRequestSchema = z
  .object({ name: z.string().min(1) })
  .openapi("CreateAudienceRequest");

export const audienceResponseSchema = z
  .object({
    object: z.string(),
    id: z.uuid(),
    name: z.string(),
    created_at: z.string().optional(),
  })
  .openapi("AudienceResponse");

export const listAudiencesResponseSchema = z
  .object({
    object: z.literal("list"),
    data: z.array(z.object({ id: z.uuid(), name: z.string(), created_at: z.string() })),
    has_more: z.boolean(),
  })
  .openapi("ListAudiencesResponse");

export const removeAudienceResponseSchema = z
  .object({ object: z.string(), id: z.uuid(), deleted: z.literal(true) })
  .openapi("RemoveAudienceResponse");

export const createContactRequestSchema = z
  .object({
    // Bare addr-spec only — a contact record is an address, not a mailbox
    // with display name.
    email: z.email(),
    first_name: z.string().optional(),
    last_name: z.string().optional(),
    unsubscribed: z.boolean().optional(),
  })
  .openapi("CreateContactRequest");

export const updateContactRequestSchema = z
  .object({
    first_name: z.string().nullable().optional(),
    last_name: z.string().nullable().optional(),
    unsubscribed: z.boolean().optional(),
  })
  .openapi("UpdateContactRequest");

export const contactIdResponseSchema = z
  .object({ object: z.literal("contact"), id: z.uuid() })
  .openapi("ContactIdResponse");

const contactSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  first_name: z.string().nullable(),
  last_name: z.string().nullable(),
  created_at: z.string(),
  unsubscribed: z.boolean(),
});

export const getContactResponseSchema = contactSchema
  .extend({ object: z.literal("contact") })
  .openapi("GetContactResponse");

export const listContactsResponseSchema = z
  .object({ object: z.literal("list"), data: z.array(contactSchema), has_more: z.boolean() })
  .openapi("ListContactsResponse");

export const removeContactResponseSchema = z
  .object({ object: z.literal("contact"), contact: z.uuid(), deleted: z.literal(true) })
  .openapi("RemoveContactResponse");
