import {
  accountMailCard,
  BREAKER_SES_COMPLAINT_RATE,
  BREAKER_WINDOWS_HOURS,
  inertText,
  type MailContent,
  type RegionDecision,
  SES_COMPLAINT_ALERT_RATE,
  SES_COMPLAINT_PAUSE_RATE,
  SES_COMPLAINT_REVIEW_RATE,
} from "@millionsend/core";

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

type Contributor = { team: string; hardBounced: number; complained: number };

/** The teams behind a region's events, under the line that introduces them; nothing when none. */
const teamLines = (lead: string, contributors: Contributor[]) =>
  contributors.length === 0
    ? []
    : [
        lead,
        ...contributors.map(
          (c) => `${inertText(c.team)}: ${c.hardBounced} hard bounces, ${c.complained} complaints`,
        ),
      ];

const weekTeams = `Teams behind the hard bounces and complaints of the last ${BREAKER_WINDOWS_HOURS[1] / 24} days:`;

const sesLines = `SES reviews an account from ${percent(SES_COMPLAINT_REVIEW_RATE)} and pauses its sending at ${percent(SES_COMPLAINT_PAUSE_RATE)}`;

export function regionPausedMail(input: {
  region: string;
  reason: NonNullable<RegionDecision["reason"]>;
  contributors: Contributor[];
  url: string;
}): MailContent {
  const { reason } = input;
  const windowed = "windowHours" in reason;
  return layout({
    subject: `Broadcasts paused in ${input.region}: ${windowed ? "platform" : "SES"} ${metricLabel(reason.metric)} rate at ${percent(reason.rate)}`,
    paragraphs: [
      windowed
        ? `Across every team sending from ${input.region}, the ${metricLabel(reason.metric)} rate over the last ${reason.windowHours} hours is ${percent(reason.rate)} (${reason.events} of ${reason.sent} sends), at or over the breaker's ${percent(reason.limit)} line, set short of SES's own review line for the whole account.`
        : `SES measures the account's complaint rate in ${input.region} at ${percent(reason.rate)}, at or over the breaker's ${percent(reason.limit)} line. ${sesLines}.`,
      "Broadcasts in this region are held until the rate drops back under the line; transactional email keeps flowing.",
      ...teamLines(
        windowed ? "Teams behind the events in that window:" : weekTeams,
        input.contributors,
      ),
    ],
    button: { label: "Open console", url: input.url },
    footnote: "Sent to the instance operator when a region breaker trips.",
  });
}

export function sesComplaintsMail(input: {
  region: string;
  rate: number;
  contributors: Contributor[];
  url: string;
}): MailContent {
  return layout({
    subject: `SES complaint rate in ${input.region} at ${percent(input.rate)}`,
    paragraphs: [
      `SES measures the account's complaint rate in ${input.region} at ${percent(input.rate)}. ${sesLines}; broadcasts in this region pause on their own at ${percent(BREAKER_SES_COMPLAINT_RATE)}.`,
      ...teamLines(weekTeams, input.contributors),
    ],
    button: { label: "Open console", url: input.url },
    footnote: `Sent to the instance operator when SES's complaint rate in a region reaches ${percent(SES_COMPLAINT_ALERT_RATE)}, at most once a day.`,
  });
}

export function regionResumedMail(input: { region: string; url: string }): MailContent {
  return layout({
    subject: `Broadcasts resumed in ${input.region}`,
    paragraphs: [
      `The platform's hard-bounce rate in ${input.region} is back under the line over both the 24-hour and 7-day windows, and so is SES's own complaint rate. Held broadcasts resume on their own.`,
    ],
    button: { label: "Open console", url: input.url },
    footnote: "Sent to the instance operator when a region breaker clears.",
  });
}
