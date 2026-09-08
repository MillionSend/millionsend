// Mirrors WEBHOOK_BACKLOG_COUNT / WEBHOOK_BACKLOG_AGE_MS in packages/core/src/webhooks.ts:
// core is server-only, and these two numbers are all the browser needs.
/** The server stops counting a queue here; anything past it reads as "10k+". */
export const QUEUE_COUNT_CAP = 10_000;
/** A backlog whose earliest row has been due this long gets a notice strip. */
export const BACKLOG_AGE_MS = 3_600_000;
