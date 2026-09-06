/**
 * The column set that empties an email's stored content while the row,
 * its events and its counters stay: the retention purge applies it on a
 * schedule, the send worker applies it at once to account mail whose body
 * carries a live credential.
 */
export function purgedEmailBodyColumns(at: Date) {
  return {
    bodyCiphertext: null,
    bodyIv: null,
    bodyWrappedDek: null,
    bodyKeyVersion: null,
    // Attachments are content on the same retention clock as the body.
    attachments: null,
    bodyPurgedAt: at,
  };
}
