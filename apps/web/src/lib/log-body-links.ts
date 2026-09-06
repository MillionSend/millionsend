type Resource =
  | "contact"
  | "email"
  | "broadcast"
  | "segment"
  | "topic"
  | "webhook"
  | "domain"
  | "template"
  | "suppression";

const DETAIL_PATH: Record<Resource, string> = {
  contact: "/audience/contacts",
  segment: "/audience/segments",
  topic: "/audience/topics",
  email: "/emails",
  broadcast: "/broadcasts",
  webhook: "/webhooks",
  domain: "/domains",
  template: "/templates",
  suppression: "/emails/suppressions",
};

/** API collection (first path segment) → what its ids denote; null for collections without a dashboard page. */
const COLLECTION = new Map<string, Resource | null>([
  ["contacts", "contact"],
  ["audiences", "segment"],
  ["segments", "segment"],
  ["emails", "email"],
  ["broadcasts", "broadcast"],
  ["topics", "topic"],
  ["webhooks", "webhook"],
  ["domains", "domain"],
  ["templates", "template"],
  ["suppressions", "suppression"],
  ["api-keys", null],
]);

/** Keys that name their resource wherever they sit. */
const EXPLICIT_KEY = new Map<string, Resource>([
  ["contact", "contact"],
  ["contact_id", "contact"],
  ["email_id", "email"],
  ["broadcast_id", "broadcast"],
  ["segment_id", "segment"],
  ["audience_id", "segment"],
  ["topic_id", "topic"],
  ["domain_id", "domain"],
  ["template_id", "template"],
  ["webhook_id", "webhook"],
]);

/** Arrays whose items are a resource of their own rather than the request's root; null blocks linking. */
const NESTED = new Map<string, Resource | null>([
  ["topics", "topic"],
  ["segments", "segment"],
  ["attachments", null],
]);

const UUID_RE = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export const isUuid = (value: string): boolean => UUID_RE.test(value);

function rootResource(requestPath: string): Resource | null {
  const [root, , sub] = requestPath.split("/").filter(Boolean);
  // A sub-collection lists the nested resource: /segments/{id}/contacts are
  // contacts, /contacts/{id}/topics are topics.
  if (sub === "contacts") return "contact";
  if (sub === "topics") return "topic";
  if (sub === "segments") return "segment";
  return COLLECTION.get(root ?? "") ?? null;
}

function resourceFor(requestPath: string, keyPath: readonly string[]): Resource | null {
  const key = keyPath.at(-1);
  if (key === undefined) return null;
  const explicit = EXPLICIT_KEY.get(key);
  if (explicit) return explicit;
  // A bare id string inside "topics": [...] / "segments": [...].
  const own = NESTED.get(key);
  if (own !== undefined) return own;
  if (key !== "id" && key !== "ids") return null;
  for (let i = keyPath.length - 2; i >= 0; i--) {
    const nested = NESTED.get(keyPath[i] ?? "");
    if (nested !== undefined) return nested;
  }
  return rootResource(requestPath);
}

/**
 * Dashboard page for a UUID found in a logged request/response body, or null
 * when the key and request path attribute it to nothing the dashboard shows.
 */
export function resourceHref(
  requestPath: string,
  keyPath: readonly string[],
  value: string,
): string | null {
  if (!isUuid(value)) return null;
  const resource = resourceFor(requestPath, keyPath);
  return resource ? `${DETAIL_PATH[resource]}/${value}` : null;
}
