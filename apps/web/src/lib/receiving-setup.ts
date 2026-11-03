import type { LiveDnsStatus } from "@/lib/dns-record-status";

/**
 * What a domain picked for an inbox still needs before mail reaches it, from
 * its stored state and a live read of its MX record. Turning receiving on
 * only flips a flag; the MX record is what moves a domain's mail, so a domain
 * whose mail already goes to another server is never one click from losing it.
 */
export type ReceivingStep =
  | "unverified"
  | "checking"
  | "enable"
  | "unknown"
  | "elsewhere"
  | "add_mx"
  | "live";

export function receivingStep(p: {
  verified: boolean;
  receiving: boolean;
  /** The live MX verdict; undefined until the check answers. */
  mx: LiveDnsStatus | undefined;
  /** Whether the user turned receiving on or checked DNS in this dialog. */
  acted: boolean;
}): ReceivingStep | null {
  if (!p.verified) return "unverified";
  if (p.mx === "mismatch") return "elsewhere";
  if (!p.receiving)
    return p.mx === undefined ? "checking" : p.mx === "unknown" ? "unknown" : "enable";
  if (p.mx === "missing") return "add_mx";
  // A domain already receiving when the dialog opened needs no card; one set
  // up here keeps it until the record reads live.
  if (!p.acted) return null;
  return p.mx === "found" ? "live" : p.mx === "unknown" ? "unknown" : null;
}

/** The host that gets a domain's mail first, from a mismatch's "priority host" lines (lowest first). */
export function lowestMxHost(found: string | undefined): string | null {
  return found?.split("\n")[0]?.split(" ")[1] ?? null;
}

/** The domains catalog key for a refused setReceiving, by tRPC error code. */
export function receivingErrorKey(code: string | undefined): string {
  return code === "FORBIDDEN"
    ? "detail.receiving.adminOnly"
    : code === "PRECONDITION_FAILED"
      ? "detail.receiving.errorNotVerified"
      : code === "CONFLICT"
        ? "detail.receiving.errorTaken"
        : "detail.receiving.error";
}

/** The `focus` value that opens a domain's page on its Enable receiving switch. */
export const RECEIVING_FOCUS = "receiving";

/** A domain's page, opened on its Enable receiving switch. */
export function domainReceivingHref(id: string): string {
  return `/domains/${id}?focus=${RECEIVING_FOCUS}`;
}
