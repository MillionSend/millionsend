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
      "It can do there what you can do, in your name, {until}.",
    ],
    button: "Review connected apps",
    muted: ["Didn't authorize this? Revoke it now."],
    extra: {
      allTeams: "all your teams",
      untilDisconnected: "until you disconnect it",
      untilDate: "until {date}",
    },
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
    body: ["{progress}", "{team}'s transactional email doesn't wait behind this broadcast."],
    button: "Open broadcast",
    muted: [
      "You get this once per broadcast that takes more than one day. The finish time is an estimate and can shift.",
    ],
    extra: {
      wave: "{first} of {count} emails went out in the first wave. The rest follows as capacity frees up, and the last goes out about {finishesAt}.",
      warmup:
        "{domain} is warming up, so it sends a little more each day, most active contacts first. The last email goes out about {finishesAt}.",
    },
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
      releasePaused:
        "A payment is past due, so overage is paused. They go out within minutes of paying the failed invoice from Billing, or when the period renews on {date}.",
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
      overagePaused:
        "A payment is past due, so overage is paused: at the quota, new API sends are refused and broadcasts park until the failed invoice is paid. Update the card from Billing to lift it.",
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
      overagePaused:
        "A payment is past due, so overage is paused: new API sends are refused and broadcasts park until the failed invoice is paid. Update the card from Billing; parked mail goes out within minutes of the payment.",
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
  "warmup.paused": {
    subject: "Warm-up paused for your domain",
    body: [
      "{domain} stopped sending broadcasts after its last check. {signals}",
      "{waiting}",
      "Check who you're sending to, then resume from the domain's Warm-up tab.",
    ],
    button: "Open warm-up",
    extra: {
      delays: "Gmail delayed {pct} of the day's mail.",
      opens: "Gmail opens were {pct} of other inboxes'.",
      hardBounces: "{pct} of addresses bounced.",
      mailboxFull: "{pct} of mailboxes were full or inactive.",
      complaints: "{pct} of people marked it as spam.",
      "waiting.one": "1 email is waiting until you resume.",
      "waiting.other": "{n} emails are waiting until you resume.",
    },
  },
  "warmup.done": {
    subject: "Your domain is warmed up",
    body: [
      "{domain} sent {volume} emails in a day with healthy delivery. Warm-up is done, so its broadcasts now go out at normal speed.",
    ],
    button: "Open domain",
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
  "inbox.attention": {
    subject: "Your inboxes need a look",
    body: ["Today so far: {counts}.", "Review them in the dashboard."],
    button: "Review inboxes",
    extra: {
      "quarantined.one": "{n} email in quarantine",
      "quarantined.other": "{n} emails in quarantine",
      "drafts.one": "{n} draft waiting for approval",
      "drafts.other": "{n} drafts waiting for approval",
      "refused.one": "{n} send refused by your inbox rules",
      "refused.other": "{n} sends refused by your inbox rules",
    },
  },
  "billing.payment_failed": {
    subject: "Payment failed for your {plan} plan",
    body: [
      "We couldn't charge the card on file for {team}'s {plan} plan.",
      "{retry} For now {team} keeps its {plan} plan ({cap}){overage}. If the invoice stays unpaid, Stripe cancels the subscription and {team} returns to Free ({freeCap} emails a day).",
    ],
    button: "Pay the invoice",
    muted: ["Or update the card from Billing: {billingUrl}"],
    extra: {
      retryOn: "Stripe retries on {date}.",
      noRetry: "Stripe is not retrying on its own.",
      overagePaused:
        ", but overage is paused until the invoice is paid, so sends stop at the included volume",
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
      "A move up is charged at once for the rest of the period, with the overage used so far; a move down takes effect at renewal with no refund.",
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
    extra: {
      new: "new",
      probation: "probation",
      established: "established",
      trusted: "trusted",
      exempt: "exempt",
    },
  },
  "monitor.broadcasts_paused": {
    subject: "Content monitor paused a team's broadcasts",
    body: [
      "{team} is in the new tier: a sampled message scored {score} and its monitor risk is {risk}. Under the pause policy its broadcasts are now on hold; transactional mail still flows.",
      "The team sees broadcasts as paused pending review. Open the review page to read the verdicts and resume, suspend or clear.",
    ],
    button: "Open review",
  },
  "monitor.team_held": {
    subject: "Content monitor held a team for review",
    body: [
      "{team} is in the new tier and a sampled message scored {score} ({verdict}). {rule} Under the hold policy nothing of the team goes out: mail it sends through the API and SMTP is accepted and parked, queued mail and broadcasts wait, new broadcasts are refused, and its SES tenant is disabled where tenants are on. A message judged before it was sent waits with the rest; one judged after sending had already gone out.",
      "The owner is not emailed: the dashboard shows sending as paused pending review, and the API and SMTP answer as for any accepted send. Open the review page to release the team, which sends the held mail, or to suspend it for phishing.",
    ],
    button: "Open review",
    extra: {
      score: "This one verdict held the team: the hold score is {line}.",
      young_domain:
        "This one verdict held the team: it reached {line} while the team's sending domain was under 7 days old, or of unknown age.",
      young_link:
        "This one verdict held the team: it reached {line} on mail linking to a new destination registered under 7 days ago.",
      repeat:
        "This verdict held the team as its phishing-type verdict number {n} at or above {line} within 7 days.",
    },
  },
  "monitor.team_linked": {
    subject: "A new team matches a team suspended for phishing",
    body: [
      "{team} matches {linked}, a team you suspended for phishing, on its {matches}. {held}",
      "Open the review page to see what matched, then release the team or suspend it for phishing.",
    ],
    button: "Open review",
    extra: {
      held: "It is held for review: its mail waits until you decide, and its owner sees sending as paused pending review, with no email about it.",
      notHeld:
        "It is not held: a match holds a new team when it sends, and only when it includes an email address, a card or two kinds of evidence and the automatic hold is on.",
      display_name: "sender name",
      subject: "subject",
      sending_domain: "domain name",
      link_domain: "link domain",
      phone: "phone number",
      text_hash: "email text",
      card: "card",
      ip: "IP address",
      address: "email address",
    },
  },
  "monitor.degraded": {
    subject: "Content monitor: {rate} of samples went unjudged in the last hour",
    body: [
      "{unjudged} of {samples} samples drawn in the last hour came back unjudged ({provider} · {model}). An unjudged sample changes no risk and opens no flag. While the judge fails, a new team's mail from a sending domain under 7 days old, or of unknown age, waits: the judge is tried again for a few minutes, then the email waits for you on Trust & safety, where {parked} do now. Everything else is sent and judged afterwards.",
      "Common causes are a throttled or unreachable provider, an invalid or revoked API key, or answers the monitor could not read. The console's Health card charts the unjudged share.",
    ],
    button: "Open console",
    muted: [
      "Sent to the instance operator at most once every six hours while the share stays over 20%, the provider keeps rejecting the API key, or screening before sending gives up on mail.",
    ],
  },
  "monitor.destination_parked": {
    subject: "Content monitor parked mail to a new destination",
    body: [
      "{team} sent mail to a destination it had not used before ({domain}), and the judge scored it {score} ({verdict}). That mail waits on Trust & safety, where you release it, which sends it and makes the destination known to the team, or cancel it.",
      "The team is not held: the rest of its mail flows, and it is not told. Mail to the same destination is judged before sending until one is cleared.",
    ],
    button: "Open review list",
    muted: ["Sent to the instance operator at most once a day per team."],
  },
  "monitor.media_blocked": {
    subject: "Content monitor: the image reader refused an email's images",
    body: [
      "Amazon Bedrock refused to read the images in an email from {team} (HTTP 400). Bedrock answers this way when its abuse detection blocks an image, which includes child sexual abuse material. No preview of these images is kept.",
      "An email that had not been sent yet waits on Trust & safety until you release or cancel it; one judged after sending was already delivered. This alone does not hold the team, and the team is not told.",
    ],
    button: "Open review list",
    muted: ["Sent to the instance operator at most once a day per team."],
  },
  "monitor.destination_revoked": {
    subject: "Content monitor: mail to a cleared destination was judged as phishing",
    body: [
      "{team} sent mail to {domain}, a destination its earlier mail had cleared in the last week, and the judge scored it {score} ({verdict}) after it went out. The destination is no longer cleared: mail to it is judged before sending again and waits on Trust & safety on a phishing-type verdict, and no verdict clears it again. Releasing mail to it from the review list does.",
      "This alone does not hold the team: the rest of its mail flows, and it is not told.",
    ],
    button: "Open review list",
    muted: ["Sent to the instance operator at most once a day per team."],
  },
} as const satisfies Record<AccountMailKind, AccountMailEntry>;

/** Sentences several kinds share, filled by the builders. */
export const enPhrases = {
  capUpToDay: "up to {n} emails a day",
  capUpToMonth: "up to {n} emails a month",
  capNone: "with no sending cap",
} as const satisfies Record<MailPhraseKey, string>;
