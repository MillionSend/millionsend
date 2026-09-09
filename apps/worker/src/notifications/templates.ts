import { accountMailCard, type MailContent, QUOTA_TOLERANCE } from "@millionsend/core";

export type { MailContent };

/**
 * Owner notices on the shared account-mail card: the notice names its button
 * and one muted footnote, and the text version reads "Button: url".
 */
function layout(input: {
  subject: string;
  paragraphs: string[];
  button: { label: string; url: string };
  footnote: string;
}): MailContent {
  return {
    subject: input.subject,
    ...accountMailCard({
      paragraphs: input.paragraphs,
      button: input.button.label,
      url: input.button.url,
      muted: [input.footnote],
    }),
  };
}

const percent = (rate: number) => `${(rate * 100).toFixed(2)}%`;
const tolerance = `${Math.round(QUOTA_TOLERANCE * 100)}%`;
const resetTime = (at: Date) => `${at.toISOString().slice(11, 16)} UTC`;
const metricName = (metric: "bounce" | "complaint") =>
  metric === "bounce" ? "hard-bounce rate" : "complaint rate";

export function quotaWarningMail(input: {
  team: string;
  used: number;
  limit: number;
  resetsAt: Date;
  url: string;
}): MailContent {
  return layout({
    subject: `${input.team}: 80% of today's sending quota used`,
    paragraphs: [
      `${input.team} has used ${input.used} of its ${input.limit} emails for today.`,
      `Sends keep going out until ${tolerance} past the quota; after that they queue until the quota resets at ${resetTime(input.resetsAt)}. A higher plan raises the daily quota immediately.`,
    ],
    button: { label: "Review your plan", url: input.url },
    footnote: "You get this once per day when a team you own nears its quota.",
  });
}

export function quotaReachedMail(input: {
  team: string;
  used: number;
  limit: number;
  ceiling: number;
  resetsAt: Date;
  url: string;
}): MailContent {
  const headroom = Math.max(0, input.ceiling - input.used);
  return layout({
    subject: `${input.team}: today's sending quota reached`,
    paragraphs: [
      `${input.team} has used its ${input.limit} emails for today (${input.used} accepted).`,
      `${headroom} more still go out today (sends pass until ${tolerance} past the quota); anything past that is queued and sent after the quota resets at ${resetTime(input.resetsAt)}. A higher plan raises the daily quota immediately and releases queued mail within minutes.`,
    ],
    button: { label: "Review your plan", url: input.url },
    footnote: "You get this once per day when a team you own reaches its quota.",
  });
}

export function quotaPausedMail(input: {
  team: string;
  used: number;
  limit: number;
  resetsAt: Date;
  url: string;
}): MailContent {
  return layout({
    subject: `${input.team}: sending paused until the quota resets`,
    paragraphs: [
      `${input.team} has used ${input.used} emails today, ${tolerance} past its ${input.limit} quota, so new sends are queued instead of sent.`,
      `Queued mail goes out after the quota resets at ${resetTime(input.resetsAt)}. A higher plan raises the daily quota immediately and releases the queue within minutes.`,
    ],
    button: { label: "Review your plan", url: input.url },
    footnote: "You get this once per day when a team you own passes the ceiling of its quota.",
  });
}

export function deliverabilityWarningMail(input: {
  team: string;
  metric: "bounce" | "complaint";
  rate: number;
  limit: number;
  windowDays: number;
  url: string;
}): MailContent {
  return layout({
    subject: `${input.team}: ${metricName(input.metric)} at risk`,
    paragraphs: [
      `${input.team}'s ${metricName(input.metric)} over the last ${input.windowDays} days is ${percent(input.rate)}, above the ${percent(input.limit)} risk line. Sending continues, but broadcasts are slowed while it stays there.`,
      input.metric === "bounce"
        ? "Hard bounces come from addresses that do not exist. Remove old or unverified addresses from your lists; every bounced address is already on your suppression list."
        : "Complaints come from recipients who did not expect the email. Send only to people who opted in, keep the unsubscribe link visible, and pause lists that have not heard from you in months.",
    ],
    button: { label: "Open metrics", url: input.url },
    footnote: "You get this once per episode; it clears when the rate drops back under the line.",
  });
}

export function deliverabilityPausedMail(input: {
  team: string;
  metric: "bounce" | "complaint";
  rate: number;
  limit: number;
  windowDays: number;
  url: string;
}): MailContent {
  return layout({
    subject: `${input.team}: sending paused (${metricName(input.metric)})`,
    paragraphs: [
      `${input.team}'s ${metricName(input.metric)} over the last ${input.windowDays} days reached ${percent(input.rate)}, at or above the ${percent(input.limit)} pause line. New sends are refused until it recovers.`,
      "The pause lifts on its own once the rate over the window drops back under the line. Clean the recipient list first, or the next sends will trip it again.",
    ],
    button: { label: "Open metrics", url: input.url },
    footnote: "You get this once per episode.",
  });
}

const metricLabel = (metric: "bounce" | "complaint") =>
  metric === "bounce" ? "hard-bounce" : "complaint";

export function regionPausedMail(input: {
  region: string;
  metric: "bounce" | "complaint";
  rate: number;
  limit: number;
  windowHours: number;
  sent: number;
  events: number;
  contributors: { team: string; hardBounced: number; complained: number }[];
  url: string;
}): MailContent {
  return layout({
    subject: `Broadcasts paused in ${input.region}: platform ${metricLabel(input.metric)} rate at ${percent(input.rate)}`,
    paragraphs: [
      `Across every team sending from ${input.region}, the ${metricLabel(input.metric)} rate over the last ${input.windowHours} hours is ${percent(input.rate)} (${input.events} of ${input.sent} sends), within 80% of SES's ${percent(input.limit)} review line for the whole account.`,
      "Broadcasts in this region are held until the rate drops back under the line; transactional email keeps flowing. Teams behind the events in the last 24 hours:",
      ...input.contributors.map(
        (c) => `${c.team}: ${c.hardBounced} hard bounces, ${c.complained} complaints`,
      ),
    ],
    button: { label: "Open dashboard", url: input.url },
    footnote: "Sent to the instance operator when a region breaker trips.",
  });
}

export function regionResumedMail(input: { region: string; url: string }): MailContent {
  return layout({
    subject: `Broadcasts resumed in ${input.region}`,
    paragraphs: [
      `The platform's bounce and complaint rates in ${input.region} are back under the line over both the 24-hour and 7-day windows. Held broadcasts resume on their own.`,
    ],
    button: { label: "Open dashboard", url: input.url },
    footnote: "Sent to the instance operator when a region breaker clears.",
  });
}

const host = (endpoint: string) => new URL(endpoint).host;
const age = (ms: number) =>
  ms >= 3_600_000
    ? `${Math.floor(ms / 3_600_000)} h`
    : `${Math.max(1, Math.floor(ms / 60_000))} min`;

export function webhookFailingMail(input: {
  team: string;
  endpoint: string;
  streak: number;
  disableAfter: number;
  url: string;
}): MailContent {
  return layout({
    subject: `${input.team}: webhook deliveries to ${host(input.endpoint)} are failing`,
    paragraphs: [
      `The last ${input.streak} deliveries to ${input.endpoint} failed on every retry, so ${input.team} is missing events.`,
      `Check that the receiver is up, answers 2xx quickly, and verifies with the current signing secret. Retries continue on their own; after ${input.disableAfter} failed deliveries in a row the endpoint is disabled.`,
    ],
    button: { label: "Open the endpoint", url: input.url },
    footnote: "You get this once per episode; it clears when a delivery succeeds again.",
  });
}

export function webhookAutoDisabledMail(input: {
  team: string;
  endpoint: string;
  after: number;
  url: string;
}): MailContent {
  return layout({
    subject: `${input.team}: webhook ${host(input.endpoint)} disabled after repeated failures`,
    paragraphs: [
      `${input.endpoint} was disabled automatically after ${input.after} deliveries in a row failed on every retry. Events are no longer queued for it.`,
      "Fix the receiver, then re-enable the endpoint from its page. Events that happen while it is disabled are not replayed.",
    ],
    button: { label: "Open the endpoint", url: input.url },
    footnote: "You get this each time an endpoint of a team you own is disabled automatically.",
  });
}

export function webhookBacklogMail(input: {
  team: string;
  endpoint: string;
  queued: number;
  /** Where the count stopped: past it the mail says "more than". */
  cap: number;
  oldestAgeMs: number;
  url: string;
}): MailContent {
  const queued =
    input.queued > input.cap
      ? `More than ${input.cap.toLocaleString("en-US")}`
      : String(input.queued);
  return layout({
    subject: `${input.team}: webhook deliveries to ${host(input.endpoint)} are backing up`,
    paragraphs: [
      `${queued} deliveries to ${input.endpoint} are waiting; the oldest has been due for ${age(input.oldestAgeMs)}. The receiver is slow, rate-limiting, or failing, so events reach it late.`,
      "Deliveries older than 24 hours are dropped. Speed up the receiver, or subscribe the endpoint only to the events it needs.",
    ],
    button: { label: "Open the endpoint", url: input.url },
    footnote: "You get this at most once per day per endpoint.",
  });
}
