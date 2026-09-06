import { isUuid } from "./log-body-links";

export const LOG_SOURCE_KINDS = ["api_key", "mcp"] as const;
export type LogSourceKind = (typeof LOG_SOURCE_KINDS)[number];

/** A logs "source" filter: a whole kind of caller, or one caller of that kind. */
export interface LogSource {
  kind: LogSourceKind;
  /** An API key id or an OAuth client id; null selects the whole kind. */
  callerId: string | null;
}

/**
 * The source filter travels as one string, URL param and router input
 * alike: "api_key" | "mcp" for a kind, "api_key:<uuid>" | "mcp:<client id>"
 * for one caller. URL params are untrusted, so anything else reads as null
 * (a malformed key id would otherwise reach postgres as a uuid literal).
 */
export function parseLogSource(value: string): LogSource | null {
  const colon = value.indexOf(":");
  const kind = colon < 0 ? value : value.slice(0, colon);
  const callerId = colon < 0 ? null : value.slice(colon + 1);
  if (!(LOG_SOURCE_KINDS as readonly string[]).includes(kind) || callerId === "") return null;
  if (kind === "api_key" && callerId !== null && !isUuid(callerId)) return null;
  return { kind: kind as LogSourceKind, callerId };
}

export function encodeLogSource(kind: LogSourceKind, callerId?: string): string {
  return callerId === undefined ? kind : `${kind}:${callerId}`;
}
