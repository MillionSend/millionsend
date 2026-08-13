import { z } from "@hono/zod-openapi";

/**
 * Wire-compatible with Resend's documented /emails surface
 * (docs/resend-compatibility.md): field names, shapes, and error format must
 * not drift — the contract test runs the official `resend` SDK against us.
 */

const recipientList = z
  .union([z.string(), z.array(z.string()).min(1).max(50)])
  .transform((v) => (Array.isArray(v) ? v : [v]));

export const sendEmailRequestSchema = z
  .object({
    from: z.string().min(3).openapi({ example: "Acme <onboarding@acme.dev>" }),
    to: recipientList.openapi({ example: ["delivered@resend.dev"] }),
    subject: z.string().min(1),
    html: z.string().optional(),
    text: z.string().optional(),
    cc: recipientList.optional(),
    bcc: recipientList.optional(),
    reply_to: recipientList.optional(),
    tags: z.array(z.object({ name: z.string().min(1), value: z.string() })).optional(),
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
