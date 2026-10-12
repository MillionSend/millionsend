import type { OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import type { ApiDeps, Env } from "../app.js";

/** /inboxes/** (Resend's Inboxes beta plus MillionSend's safety, quarantine and codes). */
export function registerInboxRoutes(
  _app: OpenAPIHono<Env>,
  _deps: ApiDeps,
  _opts: { requireFullAccess: MiddlewareHandler<Env> },
): void {
  void "INBOX_CONTRACT_STUB";
}
