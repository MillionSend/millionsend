import { z } from "@hono/zod-openapi";
import { extractAddrSpec } from "@millionsend/core";

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
      .refine((v) => new Date(v).getTime() <= Date.now() + 30 * 24 * 60 * 60 * 1000, {
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
