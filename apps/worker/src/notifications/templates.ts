import { EMAIL_WORDMARK_URL, escapeHtml } from "@millionsend/core";

export interface MailContent {
  subject: string;
  html: string;
  text: string;
}

const MUTED = 'style="font-size:13px;line-height:1.5;color:#52525b;margin:24px 0 0"';

/** The one system-mail layout: wordmark, white card, paragraphs, one button. */
function layout(input: {
  subject: string;
  paragraphs: string[];
  button: { label: string; url: string };
  footnote: string;
}): MailContent {
  const url = escapeHtml(input.button.url);
  const body = input.paragraphs
    .map(
      (p) =>
        `<p style="font-size:14px;line-height:1.5;color:#18181b;margin:0 0 12px">${escapeHtml(p)}</p>`,
    )
    .join("\n    ");
  const html = `<div style="background:#f4f4f5;padding:32px 16px;font-family:-apple-system,'Segoe UI',Roboto,sans-serif">
  <div style="max-width:440px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px">
    <img src="${EMAIL_WORDMARK_URL}" width="174" height="24" alt="MillionSend" style="display:block;height:24px;width:auto;margin:0 0 24px;border:0">
    ${body}
    <a href="${url}" style="display:inline-block;background:#18181b;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;border-radius:8px;padding:12px 20px;margin-top:12px">${escapeHtml(input.button.label)}</a>
    <p ${MUTED}>${escapeHtml(input.footnote)}</p>
  </div>
</div>`;
  const text = `${input.paragraphs.join("\n\n")}\n\n${input.button.label}: ${input.button.url}\n\n${input.footnote}\n`;
  return { subject: input.subject, html, text };
}

const percent = (rate: number) => `${(rate * 100).toFixed(2)}%`;
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
      `Sends keep going out until 10% past the quota; after that they queue until the quota resets at ${input.resetsAt.toISOString().slice(11, 16)} UTC.`,
    ],
    button: { label: "Review your plan", url: input.url },
    footnote: "You get this once per day when a team you own nears its quota.",
  });
}

export function quotaReachedMail(input: {
  team: string;
  used: number;
  limit: number;
  resetsAt: Date;
  url: string;
}): MailContent {
  return layout({
    subject: `${input.team}: today's sending quota reached`,
    paragraphs: [
      `${input.team} has used its ${input.limit} emails for today (${input.used} accepted).`,
      `Up to 10% more still go out today; anything past that is queued and sent after the quota resets at ${input.resetsAt.toISOString().slice(11, 16)} UTC. A higher plan raises the daily quota immediately.`,
    ],
    button: { label: "Review your plan", url: input.url },
    footnote: "You get this once per day when a team you own reaches its quota.",
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
