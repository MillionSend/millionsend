import type { AccountMailEntry, AccountMailKind, MailPhraseKey } from "../account-mail.js";

export const en = {
  welcome: {
    subject: "Welcome to MillionSend",
    body: [
      "Hi {name}, your account is ready.",
      "First add a sending domain and publish its DNS records; sends go out the moment it verifies.",
      "Then create an API key under API keys — it is shown once, and it is what the SDKs, SMTP and the MCP server send with.",
    ],
    button: "Add a domain",
    muted: ["Docs: {docsUrl}"],
  },
  password_changed: {
    subject: "Your MillionSend password was changed",
    body: [
      "The password for {email} was just changed and every other session was signed out.",
      "If this was you, nothing to do. If it wasn't, reset it now — that signs out whoever did it — and review your API keys and connected apps.",
    ],
    button: "Reset password",
  },
  "mcp.connected": {
    subject: "An app is connected to your MillionSend account",
    body: [
      "You allowed {app} to act on {team} through the MillionSend MCP server with these permissions: {scopes}.",
      "It can do there what you can do, in your name, until you revoke it.",
    ],
    button: "Review connected apps",
    muted: ["Didn't authorize this? Revoke it now."],
    extra: { allTeams: "all your teams" },
  },
  "api_key.created": {
    subject: "A new API key was created",
    body: [
      '{actor} created the API key "{name}" ({prefix}…{last4}, {permission}{scope}) in {team}.',
      "Anyone holding it can send from the team's verified domains. Not expected? Revoke it under API keys.",
    ],
    button: "Open API keys",
    extra: {
      scope: ", limited to {domain}",
      full_access: "full access",
      sending_access: "sending access",
      apiKeyActor: "an API key",
      mcpActor: "an MCP client",
      systemActor: "MillionSend",
    },
  },
  "webhook.secret_rotated": {
    subject: "A webhook signing secret was rotated",
    body: ["{actor} rotated the signing secret of {url} in {team}.", "{deadline}"],
    button: "Open the endpoint",
    extra: {
      overlap:
        "The previous secret keeps verifying until {until}; switch the receiver before then or its deliveries start failing.",
      immediately:
        "The previous secret stopped verifying at once; deliveries fail until the receiver uses the new one.",
    },
  },
  "member.joined": {
    subject: "A new member joined your team",
    body: [
      "{name} ({email}) accepted the invitation and is now {role} of {team}.",
      "Members send and read logs; admins also manage domains, keys and webhooks. Remove them under Settings → Team if that's wrong.",
    ],
    button: "Open team settings",
    extra: { member: "a member", admin: "an admin", owner: "an owner" },
  },
  "domain.verified": {
    subject: "Your domain is verified",
    body: [
      "The DNS records for {domain} check out and it can send from any address on it — API, SMTP and broadcasts.",
      "We keep re-checking the records and will tell you if one disappears.",
    ],
    button: "Open domain",
  },
  "domain.lost": {
    subject: "A domain lost its verification",
    body: [
      "A required DNS record for {domain} (DKIM or MAIL FROM) no longer resolves, so sends from it are refused until it's back — API calls fail and scheduled broadcasts stop at send time.",
      "Restore the record at your DNS host; verification returns on its own at the next check or when you press Verify.",
    ],
    button: "Open domain",
  },
  "domain.lost.identity": {
    subject: "A domain lost its verification",
    body: [
      "SES has given up on {domain}: its identity is gone, or its DKIM records stayed missing past the 72-hour window. Sends from it are refused; add the domain again to keep sending from it.",
    ],
    button: "Open domains",
  },
  "broadcast.sent": {
    subject: "Your broadcast went out to {count} recipients",
    body: [
      '"{subject}" was handed to {count} contacts of {team}; suppressed and unsubscribed addresses were skipped.{failed}',
      "Opens, clicks and bounces appear on the broadcast page as they arrive.",
    ],
    button: "Open broadcast",
    extra: { failed: " {n} could not be sent." },
  },
  "broadcast.sending": {
    subject: "Your broadcast is going out over {days} days",
    body: [
      "{first} of {count} emails went out in the first wave; the rest follows as capacity frees, the last about {finishesAt}.",
      "Sends above the daily sending capacity are spread over the following days; {team}'s transactional email is not held behind them.",
    ],
    button: "Open broadcast",
    muted: [
      "You get this once per broadcast that takes more than one day. The finish time is an estimate and can shift.",
    ],
  },
  "broadcast.held_quota": {
    subject: "{parked} of {count} broadcast recipients are waiting for the quota",
    body: [
      "{sent} emails went out; {parked} are parked because {team} reached its quota of {limit}.",
      "{release}",
    ],
    button: "Review your plan",
    extra: {
      releaseDaily:
        "They go out after the reset at {resetsAt} UTC, or within minutes of a higher plan.",
      releaseMonthly:
        "They go out when the period renews on {date}, as soon as overage is turned on in Billing, or within minutes of a higher plan.",
    },
  },
  "broadcast.held": {
    subject: "Your broadcast is waiting to send",
    body: [
      '"{name}" is waiting to send. Delivery is paused for now and resumes automatically, so you don\'t need to do anything; transactional email keeps flowing.',
      "You'll get the usual sent report when it's done.",
    ],
    button: "Open broadcast",
  },
  "quota.warning": {
    subject: "80% of today's sending quota used",
    body: [
      "{team} has used {used} of its {limit} emails for today.",
      "Sends keep going out until {tolerance} past the quota; after that they queue until the quota resets at {resetsAt}. A higher plan raises the daily quota immediately.",
    ],
    button: "Review your plan",
    muted: ["You get this once per day when a team you own nears its quota."],
  },
  "quota.reached": {
    subject: "Today's sending quota reached",
    body: [
      "{team} has used its {limit} emails for today ({used} accepted).",
      "{headroom} more still go out today (sends pass until {tolerance} past the quota); anything past that is queued and sent after the quota resets at {resetsAt}. A higher plan raises the daily quota immediately and releases queued mail within minutes.",
    ],
    button: "Review your plan",
    muted: ["You get this once per day when a team you own reaches its quota."],
  },
  "quota.paused": {
    subject: "Sending paused until the quota resets",
    body: [
      "{team} has used {used} emails today, {tolerance} past its {limit} quota, so new sends are queued instead of sent.",
      "Queued mail goes out after the quota resets at {resetsAt}. A higher plan raises the daily quota immediately and releases the queue within minutes.",
    ],
    button: "Review your plan",
    muted: ["You get this once per day when a team you own passes the ceiling of its quota."],
  },
  "quota.monthly_warning": {
    subject: "80% of this period's sending quota used",
    body: [
      "{team} has used {used} of the {limit} emails included in its plan this billing period, which renews on {renewsAt}.",
      "{advice}",
    ],
    button: "Review your plan",
    muted: ["You get this once per billing period when a team you own nears its quota."],
    extra: {
      overage:
        "Sends past the quota bill at your plan's overage rate and show on the next invoice. A higher plan includes more emails at a lower rate.",
      noOverage:
        "At the quota, new API sends are refused and broadcasts park until the period renews. Turn on overage in Billing to keep sending past it, or move to a higher plan.",
    },
  },
  "quota.monthly_reached": {
    subject: "This period's sending quota reached",
    body: [
      "{team} has used the {limit} emails included in its plan this billing period ({used} accepted).",
      "{advice}",
    ],
    button: "Review your plan",
    muted: ["You get this once per billing period when a team you own reaches its quota."],
    extra: {
      overage:
        "Sends past the quota now bill at your plan's overage rate and show on the next invoice. They stop at {hardCap} times the included volume ({stopAt}) until the period renews on {renewsAt}; a higher plan includes more emails at a lower rate.",
      noOverage:
        "New API sends are refused until the period renews on {renewsAt} or overage is turned on in Billing; broadcasts park until then. A higher plan raises the quota immediately and releases parked mail within minutes.",
    },
  },
  "deliverability.warning": {
    subject: "Your {metric} is at risk",
    body: [
      "{team}'s {metric} over the last {days} days is {rate}, above the {limit} risk line. Sending continues, but broadcasts are slowed while it stays there.",
      "{advice}",
    ],
    button: "Open metrics",
    muted: ["You get this once per episode; it clears when the rate drops back under the line."],
    extra: {
      bounce: "hard-bounce rate",
      complaint: "complaint rate",
      bounceAdvice:
        "Hard bounces come from addresses that do not exist. Remove old or unverified addresses from your lists; every bounced address is already on your suppression list.",
      complaintAdvice:
        "Complaints come from recipients who did not expect the email. Send only to people who opted in, keep the unsubscribe link visible, and pause lists that have not heard from you in months.",
    },
  },
  "deliverability.paused": {
    subject: "Sending paused ({metric})",
    body: [
      "{team}'s {metric} over the last {days} days reached {rate}, at or above the {limit} pause line. New sends are refused until it recovers.",
      "The pause lifts on its own once the rate over the window drops back under the line. Clean the recipient list first, or the next sends will trip it again.",
    ],
    button: "Open metrics",
    muted: ["You get this once per episode."],
    extra: { bounce: "hard-bounce rate", complaint: "complaint rate" },
  },
  "webhook.failing": {
    subject: "Webhook deliveries are failing",
    body: [
      "The last {streak} deliveries to {url} failed on every retry, so {team} is missing events.",
      "Check that the receiver is up, answers 2xx quickly, and verifies with the current signing secret. Retries continue on their own; after {disableAfter} failed deliveries in a row the endpoint is disabled.",
    ],
    button: "Open the endpoint",
    muted: ["You get this once per episode; it clears when a delivery succeeds again."],
  },
  "webhook.auto_disabled": {
    subject: "A webhook endpoint was disabled after repeated failures",
    body: [
      "{url} was disabled automatically after {after} deliveries in a row failed on every retry. Events are no longer queued for it.",
      "Fix the receiver, then re-enable the endpoint from its page. Events that happen while it is disabled are not replayed.",
    ],
    button: "Open the endpoint",
    muted: ["You get this each time an endpoint of a team you own is disabled automatically."],
  },
  "webhook.backlog": {
    subject: "Webhook deliveries are backing up",
    body: [
      "{queued} deliveries to {url} are waiting; the oldest has been due for {age}. The receiver is slow, rate-limiting, or failing, so events reach it late.",
      "Deliveries older than 24 hours are dropped. Speed up the receiver, or subscribe the endpoint only to the events it needs.",
    ],
    button: "Open the endpoint",
    muted: ["You get this at most once per day per endpoint."],
    extra: { moreThan: "More than {n}" },
  },
  "billing.payment_failed": {
    subject: "Payment failed for your {plan} plan",
    body: [
      "We couldn't charge the card on file for {team}'s {plan} plan.",
      "{retry} For now {team} keeps its {plan} plan ({cap}). If the invoice stays unpaid, Stripe cancels the subscription and {team} returns to Free ({freeCap} emails a day).",
    ],
    button: "Pay the invoice",
    muted: ["Or update the card from Billing: {billingUrl}"],
    extra: {
      retryOn: "Stripe retries on {date}.",
      noRetry: "Stripe is not retrying on its own.",
    },
  },
  "billing.plan_activated": {
    subject: "Your team is on {plan}",
    body: [
      "Your subscription is active: {plan} allows {cap}, and mail parked over the old cap no longer waits on it.",
      "Receipts and invoices come from Stripe; the subscription is managed from Billing.",
    ],
    button: "Open billing",
  },
  "billing.plan_changed": {
    subject: "Your team moved from {old} to {new}",
    body: [
      "{team} is now on {new}, which allows {cap}. On a lower cap, sends already accepted are unaffected; past the new cap, daily plans wait for the next UTC day and monthly plans either bill overage (when it is on) or refuse new API sends until the period renews.",
      "Proration shows on the next Stripe invoice.",
    ],
    button: "Open billing",
  },
  "billing.cancel_scheduled": {
    subject: "Your {plan} plan ends on {date}",
    body: [
      "{team} stays on {plan} until {date}; after that it returns to Free ({freeCap} emails a day).",
      "Changed your mind? Resume the plan from Billing before then and nothing changes.",
    ],
    button: "Open billing",
  },
  "billing.cancel_reminder": {
    subject: "Reminder: your {plan} plan ends on {date}",
    body: [
      "On {date} {team} returns to Free: {freeCap} emails a day, and anything over the cap waits for the next day.",
      "Resume the plan from Billing to stay on {plan} ({cap}).",
    ],
    button: "Open billing",
  },
  "billing.downgraded": {
    subject: "Your team is now on Free",
    body: [
      "The {plan} plan ended on {date}. From today {team} is on Free: up to {freeCap} emails a day, anything over waits for the next UTC day, and broadcasts over the cap go out in parts.",
      "Verified domains, contacts and API keys are untouched. Pick a plan again from Billing whenever you need more.",
    ],
    button: "Open billing",
  },
  "team.broadcasts_paused": {
    subject: "Broadcasts paused for your team",
    body: [
      "The instance operator paused broadcasts for {team}: {reason}",
      "Transactional email keeps flowing through the API and SMTP. Scheduled broadcasts wait, and new ones cannot be sent, until the operator resumes them. Reply to this email if you have questions.",
    ],
    button: "Open broadcasts",
    extra: {
      complaints: "the complaint rate passed 0.1% over the last 7 days.",
      report: "an abuse report was received.",
      manual: "see the note below.",
      note: "Note from the operator: {note}",
    },
  },
  "team.suspended": {
    subject: "Your team is suspended",
    body: [
      "The instance operator suspended {team}: {reason}",
      "Every send is refused and broadcasts are on hold. API keys, domains, contacts and history stay as they are, and a reinstated team sends again within a minute. Reply to this email to resolve it.",
    ],
    button: "Open dashboard",
    extra: {
      reputation:
        "its bounce or complaint rates threaten the sending reputation the platform shares.",
      non_payment: "an invoice stayed unpaid.",
      manual: "see the note below.",
      note: "Note from the operator: {note}",
    },
  },
  "team.reinstated": {
    subject: "Your team is reinstated",
    body: [
      "The instance operator reinstated {team}. Sends go out again, and held broadcasts resume on their own within 15 minutes.",
    ],
    button: "Open dashboard",
  },
  "monitor.alert": {
    subject: "Content monitor: a team needs a look",
    body: [
      "The content monitor's risk for {team} reached {risk} ({tier} tier, {samples} samples judged in the last 7 days, {flagged} over the flag line). The model reads a sample of accepted mail; this alert by itself pauses and holds nothing.",
      "Open the review page to see the sampled verdicts, the content checks and the team's history, and decide. This notice repeats at most once a day per team while the risk stays over the line.",
    ],
    button: "Open review",
  },
  "monitor.broadcasts_paused": {
    subject: "Content monitor paused a team's broadcasts",
    body: [
      "{team} is in the new tier, its monitor risk reached {risk} and a sampled message scored {score}. Under the pause policy its broadcasts are now on hold; transactional mail still flows.",
      "The team sees broadcasts as paused pending review. Open the review page to read the verdicts and resume, suspend or clear.",
    ],
    button: "Open review",
  },
  "monitor.team_held": {
    subject: "Content monitor held a team for review",
    body: [
      "{team} is in the new tier and a sampled message scored {score} ({verdict}). {rule} Under the hold policy every send of the team is now refused or parked: the API and SMTP refuse, queued mail and broadcasts wait, and its SES tenant is disabled where tenants are on. The sampled message itself had already gone out when it was judged.",
      "The owner sees sending as paused pending review and is not emailed. Open the review page to release the team, which sends the held mail, or to suspend it for phishing.",
    ],
    button: "Open review",
    extra: {
      score: "This one verdict held the team: the hold score is {line}.",
      repeat:
        "This verdict held the team as its phishing-type verdict number {n} at or above {line} in its first week of sending.",
    },
  },
  "monitor.degraded": {
    subject: "Content monitor: {rate} of samples went unjudged in the last hour",
    body: [
      "{unjudged} of {samples} samples drawn in the last hour came back unjudged ({provider} · {model}). Sending is unaffected: an unjudged sample changes no risk, opens no flag and holds no mail.",
      "Common causes are a throttled or unreachable provider, an invalid or revoked API key, or answers the monitor could not read. The console's Health card charts the unjudged share.",
    ],
    button: "Open console",
    muted: [
      "Sent to the instance operator at most once every six hours while the share stays over 20% or the provider keeps rejecting the API key.",
    ],
  },
} as const satisfies Record<AccountMailKind, AccountMailEntry>;

/** Sentences several kinds share, filled by the builders. */
export const enPhrases = {
  capUpToDay: "up to {n} emails a day",
  capUpToMonth: "up to {n} emails a month",
  capNone: "with no sending cap",
} as const satisfies Record<MailPhraseKey, string>;
