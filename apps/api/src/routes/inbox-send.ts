import type { OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import type { ApiDeps, Env } from "../app.js";

/** Inbox replies, forwards and drafts, the receiving reply and forward, and draft rejection. */
export function registerInboxSendRoutes(
  _app: OpenAPIHono<Env>,
  _deps: ApiDeps,
  _opts: { requireFullAccess: MiddlewareHandler<Env> },
): void {
  void "INBOX_CONTRACT_STUB";
}
