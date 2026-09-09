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
    subject: "{app} is connected to your MillionSend account",
    body: [
      "You allowed {app} to act on {team} through the MillionSend MCP server with these permissions: {scopes}.",
      "It can do there what you can do, in your name, until you revoke it.",
    ],
    button: "Review connected apps",
    muted: ["Didn't authorize this? Revoke it now."],
    extra: { allTeams: "all your teams" },
  },
  "api_key.created": {
    subject: "New API key in {team}: {name}",
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
    subject: "Webhook secret rotated for {host}",
    body: [
      "{actor} rotated the signing secret of {url} in {team}.",
      "The previous secret keeps verifying until {until}; switch the receiver before then or its deliveries start failing.",
    ],
    button: "Open the endpoint",
    extra: { immediately: "now — it stopped verifying immediately" },
  },
  "member.joined": {
    subject: "{name} joined {team}",
    body: [
      "{name} ({email}) accepted the invitation and is now {role} of {team}.",
      "Members send and read logs; admins also manage domains, keys and webhooks. Remove them under Settings → Team if that's wrong.",
    ],
    button: "Open team settings",
    extra: { member: "a member", admin: "an admin", owner: "an owner" },
  },
  "domain.verified": {
    subject: "{domain} is verified",
    body: [
      "The DNS records for {domain} check out and it can send from any address on it — API, SMTP and broadcasts.",
      "We keep re-checking the records and will tell you if one disappears.",
    ],
    button: "Open domain",
  },
  "domain.lost": {
    subject: "{domain} lost its verification",
    body: [
      "A required DNS record for {domain} (DKIM or MAIL FROM) no longer resolves, so sends from it are refused until it's back — API calls fail and scheduled broadcasts stop at send time.",
      "Restore the record at your DNS host; verification returns on its own at the next check or when you press Verify.",
    ],
    button: "Open domain",
  },
  "domain.lost.identity": {
    subject: "{domain} lost its verification",
    body: [
      "The SES identity for {domain} no longer exists, so sends from it are refused. Add the domain again to keep sending from it.",
    ],
    button: "Open domains",
  },
  "broadcast.sent": {
    subject: '"{name}" went out to {count} recipients',
    body: [
      '"{subject}" was handed to {count} contacts of {team}; suppressed and unsubscribed addresses were skipped.',
      "Opens, clicks and bounces appear on the broadcast page as they arrive.",
    ],
    button: "Open broadcast",
  },
  "broadcast.held_quota": {
    subject: '"{name}": {parked} of {count} recipients are waiting for the quota',
    body: [
      "{sent} emails went out; {parked} are parked because {team} reached its daily quota of {limit}.",
      "They go out after the reset at {resetsAt} UTC, or within minutes of a higher plan.",
    ],
    button: "Review your plan",
  },
  "broadcast.held": {
    subject: '"{name}" is on hold',
    body: [
      'Sending from {region} is paused across the platform while bounce and complaint rates settle, so "{name}" waits instead of going out; transactional email keeps flowing.',
      "It resumes by itself — we re-check every 15 minutes — and you'll get the usual sent report when it's done.",
    ],
    button: "Open broadcast",
  },
  "billing.payment_failed": {
    subject: "Payment failed for {team}'s {plan} plan",
    body: [
      "We couldn't charge the card on file for {team}'s {plan} plan.",
      "{retry} Until then nothing changes and {team} keeps sending {cap}. If the retries keep failing, Stripe cancels the subscription and {team} returns to Free ({freeCap} emails a day).",
    ],
    button: "Pay the invoice",
    muted: ["Or update the card from Billing: {billingUrl}"],
    extra: {
      retryOn: "Stripe retries on {date}.",
      noRetry: "Stripe is not retrying on its own.",
    },
  },
  "billing.plan_activated": {
    subject: "{team} is on {plan}",
    body: [
      "Your subscription is active: {team} now sends {cap}, and anything parked over the old cap is released within minutes.",
      "Receipts and invoices come from Stripe; the subscription is managed from Billing.",
    ],
    button: "Open billing",
  },
  "billing.plan_changed": {
    subject: "{team} moved from {old} to {new}",
    body: [
      "From now on {team} sends {cap}. On a lower cap, sends already accepted are unaffected; anything over the new cap waits for the next UTC day.",
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
    subject: "{team}'s {plan} plan ends in 3 days",
    body: [
      "On {date} {team} returns to Free: {freeCap} emails a day, and anything over the cap waits for the next day.",
      "Resume the plan from Billing to keep sending {cap}.",
    ],
    button: "Open billing",
  },
  "billing.downgraded": {
    subject: "{team} is now on Free",
    body: [
      "The {plan} plan ended on {date}. From today {team} sends up to {freeCap} emails a day; anything over waits for the next UTC day, and broadcasts over the cap go out in parts.",
      "Verified domains, contacts and API keys are untouched. Pick a plan again from Billing whenever you need more.",
    ],
    button: "Open billing",
  },
} as const satisfies Record<AccountMailKind, AccountMailEntry>;

/** Sentences several kinds share, filled by the builders. */
export const enPhrases = {
  capUpTo: "up to {n} emails a day",
  capNone: "with no daily cap",
} as const satisfies Record<MailPhraseKey, string>;
