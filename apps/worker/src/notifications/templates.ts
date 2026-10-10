import { accountMailCard, inertText, type MailContent } from "@millionsend/core";

export type { MailContent };

/**
 * Operator notices on the shared account-mail card: the notice names its
 * button and one muted footnote, and the text version reads "Button: url".
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
        (c) => `${inertText(c.team)}: ${c.hardBounced} hard bounces, ${c.complained} complaints`,
      ),
    ],
    button: { label: "Open console", url: input.url },
    footnote: "Sent to the instance operator when a region breaker trips.",
  });
}

export function regionResumedMail(input: { region: string; url: string }): MailContent {
  return layout({
    subject: `Broadcasts resumed in ${input.region}`,
    paragraphs: [
      `The platform's bounce and complaint rates in ${input.region} are back under the line over both the 24-hour and 7-day windows. Held broadcasts resume on their own.`,
    ],
    button: { label: "Open console", url: input.url },
    footnote: "Sent to the instance operator when a region breaker clears.",
  });
}
