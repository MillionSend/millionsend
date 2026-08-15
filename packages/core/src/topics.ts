/**
 * Topic subscription rule: an explicit override row wins; its absence falls
 * back to the topic's defaultSubscribed. Global unsubscribe is a separate gate
 * the caller applies on top of this.
 */
export function isSubscribedToTopic(
  override: boolean | null | undefined,
  defaultSubscribed: boolean,
): boolean {
  return override ?? defaultSubscribed;
}
