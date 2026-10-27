import {
  accountMailCard,
  BREAKER_SES_COMPLAINT_RATE,
  BREAKER_TEAM_WINDOW_DAYS,
  inertText,
  type MailContent,
  type RegionDecision,
  SES_COMPLAINT_ALERT_RATE,
  SES_COMPLAINT_PAUSE_RATE,
  SES_COMPLAINT_REVIEW_RATE,
  type SesEnforcementChange,
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

const monthTeams = `Teams behind the hard bounces and complaints about mail sent in the last ${BREAKER_TEAM_WINDOW_DAYS} days:`;

const sesLines = `SES reviews an account from ${percent(SES_COMPLAINT_REVIEW_RATE)} and pauses its sending at ${percent(SES_COMPLAINT_PAUSE_RATE)}`;

/** The month's complaints about mail no email row is left for, when there are any. */
const unmatchedLines = (unmatched: number) =>
  unmatched === 0
    ? []
    : [
        `SES also reported ${unmatched} complaint${unmatched === 1 ? "" : "s"} in the last ${BREAKER_TEAM_WINDOW_DAYS} days about mail with no email row left (expired, a deleted team's, or sent outside MillionSend), which no team above accounts for.`,
      ];

/** The names of teams, for a sentence: a lure in one stays inert. */
const teamList = (teams: readonly string[]) => teams.map((t) => inertText(t)).join(", ");

/** Whose broadcasts a pause holds: every team's, or the teams at the line and nobody else's. */
function pauseScope(heldTeams: readonly string[] | null, isCloud: boolean): string {
  if (heldTeams === null) {
    return "Every team's broadcasts in this region are held until the rate drops back under the line; transactional email keeps flowing.";
  }
  // Self-hosted, every team counts as paid and nobody is held for review.
  const who = isCloud ? "paid team" : "team";
  const line = `${percent(BREAKER_SES_COMPLAINT_RATE)} complaints over`;
  return [
    heldTeams.length === 0
      ? `No ${who} is at ${line} its own last ${BREAKER_TEAM_WINDOW_DAYS} days, so no broadcasts are held.`
      : `Only the broadcasts of the ${who}s at or over ${line} their own last ${BREAKER_TEAM_WINDOW_DAYS} days are held: ${teamList(heldTeams)}.`,
    ...(isCloud
      ? ["Free teams whose mail drew a complaint are held for review, named in a separate mail."]
      : []),
    `Every other team keeps sending, transactional email keeps flowing, and the pause lifts once the rate is back under ${percent(SES_COMPLAINT_ALERT_RATE)}.`,
  ].join(" ");
}

export function regionPausedMail(input: {
  region: string;
  reason: NonNullable<RegionDecision["reason"]>;
  contributors: Contributor[];
  /** The teams whose broadcasts the pause holds; null holds every team's. */
  heldTeams: readonly string[] | null;
  isCloud: boolean;
  /** Complaints about mail with no email row over the month. */
  unmatched: number;
  url: string;
}): MailContent {
  const { reason, heldTeams } = input;
  const windowed = "windowHours" in reason;
  const complaints = reason.metric === "complaint";
  return layout({
    subject: `Broadcasts paused in ${input.region}${heldTeams === null ? "" : ` for the teams drawing complaints`}: ${windowed ? "platform" : "SES"} ${metricLabel(reason.metric)} rate at ${percent(reason.rate)}`,
    paragraphs: [
      windowed
        ? `Across every team sending from ${input.region}, the ${metricLabel(reason.metric)} rate over the last ${reason.windowHours} hours is ${percent(reason.rate)} (${reason.events} of ${reason.sent} sends${complaints ? " to providers that report complaints" : ""}), at or over the breaker's ${percent(reason.limit)} line${complaints ? `. ${sesLines}.` : ", set short of SES's own review line for the whole account."}`
        : `SES measures the account's complaint rate in ${input.region} at ${percent(reason.rate)}, at or over the breaker's ${percent(reason.limit)} line. ${sesLines}.`,
      ...(windowed && complaints
        ? [
            "SES's own complaint rate wasn't available (reading it takes cloudwatch:GetMetricData in the instance's IAM policy), so the breaker estimated it from our own count of complaints, leaving out mail to providers that never report them, such as Gmail.",
          ]
        : []),
      pauseScope(heldTeams, input.isCloud),
      ...teamLines(monthTeams, input.contributors),
      ...unmatchedLines(input.unmatched),
    ],
    button: { label: "Open console", url: input.url },
    footnote: "Sent to the instance operator when a region breaker trips.",
  });
}

export function sesComplaintsMail(input: {
  region: string;
  rate: number;
  contributors: Contributor[];
  unmatched: number;
  url: string;
}): MailContent {
  return layout({
    subject: `SES complaint rate in ${input.region} at ${percent(input.rate)}`,
    paragraphs: [
      `SES measures the account's complaint rate in ${input.region} at ${percent(input.rate)}. ${sesLines}; at ${percent(BREAKER_SES_COMPLAINT_RATE)} the region's breaker holds the broadcasts of the teams drawing the complaints.`,
      ...teamLines(monthTeams, input.contributors),
      ...unmatchedLines(input.unmatched),
    ],
    button: { label: "Open console", url: input.url },
    footnote: `Sent to the instance operator when SES's complaint rate in a region is at or over ${percent(SES_COMPLAINT_ALERT_RATE)}, at most once a day.`,
  });
}

export function regionResumedMail(input: { region: string; url: string }): MailContent {
  return layout({
    subject: `Broadcasts resumed in ${input.region}`,
    paragraphs: [
      `The platform's hard-bounce rate in ${input.region} is back under the line over both the 24-hour and 7-day windows, and so is the complaint rate the breaker judges: SES's own, or our estimate of it while that isn't available (a pause the complaints tripped waits until it is under ${percent(SES_COMPLAINT_ALERT_RATE)}). Held broadcasts resume on their own; teams held for review stay held until you release them.`,
    ],
    button: { label: "Open console", url: input.url },
    footnote: "Sent to the instance operator when a region breaker clears.",
  });
}

const ENFORCEMENT_MEANING: Record<string, string> = {
  HEALTHY: "SES is not acting on the account.",
  PROBATION:
    "SES has put the account under review: it watches the bounce and complaint rates, and pauses the account's sending if they don't improve.",
  SHUTDOWN:
    "SES has paused the account's sending: every send in this region is refused until AWS lifts it.",
};

export function sesEnforcementMail(input: SesEnforcementChange & { url: string }): MailContent {
  return layout({
    subject: `SES account status in ${input.region}: ${input.to}`,
    paragraphs: [
      input.from === null
        ? `SES reports the account's enforcement status in ${input.region} as ${input.to}.`
        : `SES moved the account's enforcement status in ${input.region} from ${input.from} to ${input.to}.`,
      ENFORCEMENT_MEANING[input.to] ?? "Check the account in the SES console.",
    ],
    button: { label: "Open console", url: input.url },
    footnote:
      "Sent to the instance operator when SES changes the account's enforcement status in a region.",
  });
}

export function teamsHeldMail(input: {
  region: string;
  teams: readonly string[];
  url: string;
}): MailContent {
  return layout({
    subject: `Held for review after complaints in ${input.region}: ${input.teams.length} Free team${input.teams.length === 1 ? "" : "s"}`,
    paragraphs: [
      `The breaker in ${input.region} tripped on complaints, and mail these Free teams sent there in the last ${BREAKER_TEAM_WINDOW_DAYS} days drew at least one. Each is held for review: its mail waits and its broadcasts are refused until you release it on Trust & safety.`,
      ...input.teams.map((t) => inertText(t)),
    ],
    button: { label: "Open Trust & safety", url: input.url },
    footnote: "Sent to the instance operator when a region breaker holds Free teams for review.",
  });
}
