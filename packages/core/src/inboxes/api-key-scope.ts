/**
 * Every route an inbox-scoped key may call. `:own` must be the key's inbox
 * id; `:address` is its id or any address, which the handler resolves only
 * within the key's inbox; `:id` is any one segment.
 */
const ALLOWED = [
  "GET /inboxes",
  "GET /inboxes/:address",
  "GET /inboxes/:own/safety",
  "GET /inboxes/:own/agent",
  "GET /inboxes/:own/labels",
  "GET /inboxes/:own/codes/latest",
  "POST /inboxes/:own/labels",
  "PATCH /inboxes/:own/labels/:id",
  "DELETE /inboxes/:own/labels/:id",
  "GET /inboxes/:own/threads",
  "GET /inboxes/:own/threads/search",
  "GET /inboxes/:own/threads/:id",
  "PATCH /inboxes/:own/threads/:id",
  "DELETE /inboxes/:own/threads/:id",
  "GET /inboxes/:own/threads/:id/emails",
  "GET /inboxes/:own/threads/:id/emails/:id",
  "POST /inboxes/:own/threads/:id/emails/:id/reply",
  "POST /inboxes/:own/threads/:id/emails/:id/forward",
  "GET /inboxes/:own/drafts",
  "POST /inboxes/:own/drafts",
  "GET /inboxes/:own/drafts/:id",
  "PATCH /inboxes/:own/drafts/:id",
  "DELETE /inboxes/:own/drafts/:id",
  "POST /inboxes/:own/drafts/:id/send",
  "GET /emails/receiving",
  "GET /emails/receiving/:id",
  "GET /emails/receiving/:id/attachments",
  "GET /emails/receiving/:id/attachments/:id",
  "POST /emails/receiving/:id/reply",
  "POST /emails/receiving/:id/forward",
  "POST /emails",
  "POST /emails/batch",
].map((route) => {
  const [method = "", path = ""] = route.split(" ");
  return { method, segments: path.slice(1).split("/") };
});

function decoded(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * Whether an inbox-scoped key may call `method path`. An allow-list: any
 * route not admitted here, including every route added later, is refused.
 */
export function inboxKeyAllows(method: string, path: string, inboxId: string): boolean {
  const verb = method.toUpperCase();
  const own = inboxId.toLowerCase();
  const segments = path.split("/").slice(1).map(decoded);
  if (path[0] !== "/" || segments.some((s) => s === null || s === "")) return false;
  return ALLOWED.some(
    (route) =>
      route.method === verb &&
      route.segments.length === segments.length &&
      route.segments.every((pattern, n) => {
        const segment = segments[n] as string;
        if (pattern === ":id") return true;
        if (pattern === ":own") return segment.toLowerCase() === own;
        if (pattern === ":address") return segment.toLowerCase() === own || segment.includes("@");
        return pattern === segment;
      }),
  );
}
