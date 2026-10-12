/**
 * Whether an inbox-scoped key may call `method path`. An allow-list: any
 * route not admitted here, including every route added later, is refused.
 */
export function inboxKeyAllows(_method: string, _path: string, _inboxId: string): boolean {
  throw new Error("INBOX_CONTRACT_STUB");
}
