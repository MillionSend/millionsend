// core is server-only, so the browser keeps the two numbers it needs here.
/** Mirrors WEBHOOK_BACKLOG_COUNT (packages/core/src/webhooks.ts): the server stops counting a queue here; past it reads as "10k+". */
export const QUEUE_COUNT_CAP = 10_000;
/**
 * A backlog whose earliest row has been due this long gets a notice strip.
 * Earlier than the owner mail (WEBHOOK_BACKLOG_AGE_MS): the page is where a
 * lag of minutes belongs, the inbox is for one of hours.
 */
export const BACKLOG_AGE_MS = 3_600_000;
