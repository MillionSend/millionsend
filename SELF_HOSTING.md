# Self-hosting MillionSend

MillionSend sends through your own AWS SES account. Two containers: Postgres and one
app container running the api (port 3001), worker, and web dashboard (port 3000).
All three ports are `.env`-tunable: `WEB_PORT` republishes the dashboard on another
host port, `PORT` moves the api, and `SMTP_PORT` moves the optional relay. If you
change where the dashboard is reachable, update `APP_BASE_URL` to match — it is
baked into unsubscribe and tracking links, and it is the only origin sign-in
accepts: a mismatched port fails login/signup with an "invalid origin" error.

Prerequisites: Docker with Compose; an AWS account with SES access in your chosen
region (sandbox accounts can only send to verified recipients — request production
access to send to anyone); a sending domain you control. Domain verification (DKIM
records) is done from the dashboard after boot.

<details open>
<summary><b>Quickstart (no clone)</b></summary>

One command, in an empty directory (Node 18+):

```sh
mkdir millionsend && cd millionsend
npx @millionsend/setup
```

The wizard detects what is already there and offers each step — create `.env`
from a built-in template with generated secrets, provision the AWS resources
and the S3 buckets for uploads and backups (both below), download the
standalone compose file, and `docker compose up -d`. Every step is skippable
and safe to re-run; `--dry-run` prints the full plan and touches nothing. On an install that is already set up, a terminal run opens on a menu of next steps instead of walking every step again.

Prefer doing it by hand? The manual equivalent runs the same multi-arch
prebuilt image:

```sh
mkdir millionsend && cd millionsend
curl -O https://raw.githubusercontent.com/MillionSend/millionsend/main/deploy/docker-compose.yml
curl -o .env https://raw.githubusercontent.com/MillionSend/millionsend/main/.env.example
```

In `.env` (everything else defaults to a working local setup):

- `MASTER_ENCRYPTION_KEY` and `BETTER_AUTH_SECRET` — `openssl rand -base64 32` each.
  The file now holds every secret the instance has: `chmod 600 .env`, and keep
  it out of version control and backups.
- `APP_BASE_URL` — the URL you open the dashboard at. The default
  `http://localhost:3000` works locally; set your real `https://` URL when exposing
  it, or sign-in is rejected as an untrusted origin.
- `UNSUBSCRIBE_BASE_URL` — optional own host for the hosted unsubscribe pages
  (`https://unsubscribe.example.com`, pointed at the same web process). Links in
  mail and the page's redirects use it, and that host serves the unsubscribe
  flow only, keeping link scanners off the dashboard's origin. Unset:
  `APP_BASE_URL`.
- `PUBLIC_API_URL` — only behind a reverse proxy that serves the API on its own
  hostname (the nginx section below); otherwise the API is assumed at port 3001
  of the dashboard host.
- `COMPOSE_PROFILES` — optional services, comma-separated: `docs` (the
  documentation site), `smtp` (the relay; mount a keypair first), `mx`
  (inbound mail; see "Receiving mail" below), `clamav` (virus scanning of
  received mail, same section), `backup` (scheduled dumps).
- `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` — from the AWS setup below, or rely
  on the default AWS credential chain. The worker paces each region at the lower
  of its own SES send rate and `SES_MAX_SEND_RATE` (or the Settings → Instance
  value), so a sandbox region needs no change.
- `AWS_REGIONS` — optional, comma-separated: serve several SES regions from one
  deployment, the first being the default; unset means the one region in
  `AWS_REGION`. See "Adding a region" below.

```sh
docker compose up -d
```

Migrations run automatically on boot. Dashboard: http://localhost:3000.
API: http://localhost:3001.

</details>

<details>
<summary><b>Upgrades</b></summary>

```sh
docker compose pull
docker compose up -d
```

Migrations run on boot, so that is the whole upgrade for a small instance. The compose file runs
`ghcr.io/millionsend/millionsend:latest`, the latest tagged release (`:1.2.3`
and `:1.2` tags exist alongside it; `:edge` follows `main`, where every build
passed the test suite first). To hold a version, set `MILLIONSEND_IMAGE`
in `.env` to a version tag or an immutable digest
(`ghcr.io/millionsend/millionsend@sha256:…`; `docker image ls --digests` shows
what is running) and `docker compose up -d`. The previous pin put back is the
rollback — with the caveat that schema migrations run forward only, so take a
dump before a big jump (Backups below); a rolled-back image may not start on a
newer schema. Upgrading from a release before v0.6.30: the metadata window
default drops from 365 to 30 days, and the first hourly purge after boot
deletes email rows older than that (counters and broadcast results stay). Set
`EMAIL_METADATA_RETENTION_DAYS=365` first if that history must remain.

Once tables are large (millions of emails or contacts), a migration that
rewrites or indexes them takes minutes. Migrations run in one transaction and
their locks block reads and writes on the tables they touch until it commits,
so that wait is downtime whether it happens at boot or before the swap. Run
it before the swap anyway, from a throwaway container, at a quiet hour: a
migration that fails leaves the old container serving instead of a container
that will not boot, and the boot-time pass then finds nothing pending:

```sh
docker compose pull && docker compose run --rm --no-deps millionsend migrate && docker compose up -d
```

Automatic upgrades, for a host that can only reach out (behind a CDN-only
firewall, say): a cron line is enough, since `up -d` recreates a container
only when its image changed.

```sh
( crontab -l 2>/dev/null; echo "*/5 * * * * cd /opt/millionsend && docker compose pull -q && docker compose up -d" ) | crontab -
```

</details>

<details>
<summary><b>From source</b></summary>

For contributors, or when you want to modify the code:

```sh
git clone https://github.com/MillionSend/millionsend.git
cd millionsend
cp .env.example .env   # fill it as in the quickstart
docker compose up --build -d
```

The root `docker-compose.yml` builds the image locally from the `Dockerfile`. To run
a clone against the published image instead:
`docker compose -f docker-compose.yml -f docker-compose.prebuilt.yml up -d`.

Without Docker (Node 24+, pnpm 11, local Postgres): `pnpm install`, point
`DATABASE_URL` at your Postgres, `pnpm --filter @millionsend/db db:migrate`, then run
`pnpm --filter @millionsend/api dev`, `pnpm --filter @millionsend/worker dev`, and
`pnpm --filter @millionsend/web dev` in separate terminals.

</details>

<details>
<summary><b>AWS setup</b></summary>

The AWS step of `npx @millionsend/setup` creates everything MillionSend needs in
AWS — IAM policy + user + access key, the SNS event topic, the SQS events queue
the worker long-polls, and the SES configuration set. The policy also carries the
`ses:*Tenant*` actions and `ses:UpdateReputationEntityCustomerManagedStatus`
behind `SES_TENANTS` (one SES tenant per team, disabled while the team is
suspended); a deployment set up before those existed re-runs the wizard, or
updates the `millionsend-ses` policy, before enabling the flag. It also
carries `cloudwatch:GetMetricData`, for SES's own complaint rate, and a
deployment set up before it updates the policy the same way. Without it, the
regional pause estimates that rate from the instance's own count, leaving out
mail to providers that never report complaints to SES, such as Gmail, and
judges the estimate on the same 0.4% line. An https
`APP_BASE_URL` additionally gets events pushed to your host; the queue works
without any public URL.

Run it anywhere Node 18+ and your AWS admin credentials live — laptop or server; the
MillionSend server never needs admin credentials. It verifies your AWS identity,
shows the plan, creates everything, and writes the `AWS_*` lines into the `.env` in
the current directory (no `.env` there → it prints them to paste where MillionSend
runs). `--dry-run` prints the full plan and exits.
`teardown` deletes everything the setup created, including all access keys of the
`millionsend` user, so a running server stops sending. Re-running is safe, but each
run mints a new access key — delete stale ones in the IAM console.
(`@millionsend/setup` is the self-host setup tool; `@millionsend/cli` is the end-user
CLI that talks to the MillionSend API — migrations from other providers.)

No Node on the server? The same CLI ships inside the image — run it from the
deploy directory, which it reads and writes as `/work` (the wizard writes
nothing outside it, so run it as yourself and the `.env` it creates is yours,
mode 600):
`docker run --rm -it --user "$(id -u):$(id -g)" -e HOME=/home/ms -v ~/.aws:/home/ms/.aws:ro -v "$PWD":/work -w /work ghcr.io/millionsend/millionsend:latest setup`.

Prefer not to run a CLI? The dashboard's Settings → SES page offers a CloudFormation
quick-create link and a pre-filled shell script that create the same resources.

</details>

<details>
<summary><b>Adding a region</b></summary>

One deployment can send through several SES regions. A domain lives in one
region, the one picked when it is added (to move it, delete it and add it
again); identities, the 24-hour quota, the send rate and the sandbox status
are all per region; every region's events land in the one SQS queue, because
SNS delivers across regions.

Run the wizard's `add-region` command where the `.env` lives — the deploy
directory, or on the server through the image with short-lived admin
credentials in the environment (nothing is stored):

```sh
npx @millionsend/setup add-region us-east-1
# or, on the server, from the deploy directory:
docker run --rm -it --user "$(id -u):$(id -g)" -e HOME=/home/ms \
  -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_SESSION_TOKEN \
  -v "$PWD":/work -w /work ghcr.io/millionsend/millionsend:latest setup add-region us-east-1
```

`npx @millionsend/setup add-region` needs `@millionsend/setup` 0.9.0 or
later; the image already carries it. Without a terminal (stdin piped), the
region argument is required and the confirmation needs an explicit `yes`
line: the command refuses to guess a region, and an empty answer means no.

The interactive wizard offers the same step as **Add a region** at its AWS
step. Run anywhere else, without a `.env`, the command asks for the install's
`SQS_QUEUE_URL`, `SNS_TOPIC_ARNS`, `AWS_REGIONS`, and optional `APP_BASE_URL`
(empty: queue only), then confirms before creating anything and prints the two
lines instead of writing them.

It keeps the IAM user, policy and access key (no new key), creates in the new
region the SNS topic, the SES configuration set with its event destination and
the bounce-only suppression setting, subscribes the topic to the existing
queue, and appends to `.env`:

```sh
AWS_REGIONS=sa-east-1,us-east-1   # the first entry stays the default region
SNS_TOPIC_ARNS=<first topic ARN>,<new topic ARN>
```

`AWS_REGION` and `SQS_QUEUE_URL` are left as they are. Restart the stack
(`docker compose up -d`): the region then appears in the add-domain form and on
Settings → SES, marked **Sandbox** until AWS grants production access there —
request it per region, as for the first one. While one region has production
access, a sandbox region is listed but not selectable in the form; a sandbox
region paces its own sends at its 1/s and holds only its own domains when its
24-hour quota is spent.

Pricing: since 2026-07-21 an SES account × region with no prior sending starts
on the Essentials plan ($0.16 per 1,000 messages instead of the à la carte
$0.10). After provisioning, the wizard reads the region's plan and, on
Essentials, asks whether to cancel it; nothing MillionSend uses needs a plan,
and a defaulted plan's cancellation takes effect immediately. By hand:
`aws sesv2 put-account-pricing-attributes --plan NONE --region <region>`.

Manual equivalent: in the new region, the SNS topic, the configuration set and
the suppression setting exactly as in "SES events" below; a `sqs`
subscription of that topic to the existing queue's ARN, and the queue's policy
extended so `sqs:SendMessage` is allowed from the new topic ARN as well; then
the two `.env` lines above and a restart.

</details>

<details>
<summary><b>SES events (bounces, complaints, deliveries)</b></summary>

The setup CLI always configures this: an SQS queue (`millionsend-events`) that
the worker long-polls, its URL in `.env` as `SQS_QUEUE_URL`. The queue buffers
events through restarts and needs no inbound reachability, so it is the transport
every deployment gets; a public https `APP_BASE_URL` additionally gets an SNS
subscription pushing to your host, and the app dedupes the two. `SNS_TOPIC_ARNS`
gates ingestion either way: events are only accepted from topics on that
allowlist. Keep `SQS_QUEUE_URL` set even after switching to an https
`APP_BASE_URL` — clearing it leaves events piling up in the queue.

Manual equivalent: an SNS standard topic (same region as SES) subscribed to
`https://<your-host>/ses/events` (or to an SQS queue whose policy lets the topic
send and whose URL is in `.env` as `SQS_QUEUE_URL`), its ARN in `.env` as
`SNS_TOPIC_ARNS`; an SES configuration set with an event destination pointing at
the topic (event types: Delivery, Delivery Delay, Bounce, Complaint, Reject,
Rendering Failure), its name in `.env` as `SES_CONFIGURATION_SET`. Do NOT
subscribe Open or Click: that makes SES rewrite every link and inject its own
pixel, while MillionSend tracks engagement itself. Restart after setting them. Without `SES_CONFIGURATION_SET`, sends go out without
a configuration set and emit no events.

The wizard also sets SES's account-level suppression list (per region, shared by every
team) to bounces only: a dead mailbox is dead for everyone, but a spam report is one
sender's problem and MillionSend suppresses it per team — on the SES list it would block
an unrelated team's mail to that person too. Provisioned by hand? Set it yourself:
`aws sesv2 put-account-suppression-attributes --suppressed-reasons BOUNCE`.

The https SNS subscription confirms itself once the app runs with
`SNS_TOPIC_ARNS` set; if it stays pending, use "Request confirmation" on it in
the SNS console. Same-account SQS subscriptions need no confirmation.

The subscription endpoint is `{APP_BASE_URL}/ses/events`, but the api process
serves that path, not the dashboard: a reverse proxy in front of the dashboard
hostname must route that one path to the api (the nginx section below does),
or the confirmation POST lands on the dashboard, 404s, and the subscription
stays pending with every bounce and delivery lost.

</details>

<details>
<summary><b>SMTP relay</b></summary>

A drop-in SMTP relay for software that speaks SMTP instead of HTTP — legacy apps,
CMS plugins, anything with an "SMTP settings" form. Messages go through the same
accept pipeline as `POST /emails`: same domain verification, suppression checks,
request logging, and delivery events.

Connection details:

- Host: wherever the `smtp` service is reachable (compose binds it to the Docker
  host's loopback interface by default).
- Port: `2587` (`SMTP_PORT` to change).
- Username: `millionsend` (fixed).
- Password: an `ms_` API key from the dashboard.
- Encryption: STARTTLS is offered (and required before AUTH) when
  `SMTP_TLS_CERT_PATH` and `SMTP_TLS_KEY_PATH` point at a PEM keypair. Without
  one, the relay refuses to start unless `SMTP_ALLOW_INSECURE_AUTH=true` is explicitly set
  for a trusted private network.

Before exposing the relay to the internet, give it a certificate — otherwise SMTP
AUTH sends the API key in plaintext. Any PEM keypair works; if you followed the
nginx section you already have one. Mount certbot's `live/<domain>` directory (the
symlink directory, not a copy, so a renewal lands at the same path) via
`docker-compose.override.yml`, and restart the relay after each renewal — it
reads the keypair when it starts (certbot:
`--deploy-hook 'docker compose -f /opt/millionsend/docker-compose.yml restart smtp'`):

```yaml
services:
  smtp:
    volumes:
      - /etc/letsencrypt/live/mail.example.com:/certs:ro
```

and in `.env`:

```sh
SMTP_TLS_CERT_PATH=/certs/fullchain.pem
SMTP_TLS_KEY_PATH=/certs/privkey.pem
```

For local-only plaintext testing, keep `SMTP_BIND_ADDRESS=127.0.0.1` and set
`SMTP_ALLOW_INSECURE_AUTH=true`. Never combine that flag with a public bind.

Nodemailer example:

```js
import nodemailer from "nodemailer";

const transport = nodemailer.createTransport({
  host: "localhost",
  port: 2587,
  auth: { user: "millionsend", pass: "ms_..." },
});

await transport.sendMail({
  from: "you@yourdomain.com",
  to: "someone@example.com",
  subject: "Hello",
  html: "<p>Sent over SMTP.</p>",
});
```

The `smtp` service is defined in both compose files behind the `smtp` profile,
so it stays off until asked for: once the keypair is mounted, add `smtp` to
`COMPOSE_PROFILES` in `.env` (comma-separated with any others) and
`docker compose up -d`.

</details>

<details>
<summary><b>Receiving mail (built-in MX, beta)</b></summary>

Point a domain's MX record at this instance and mail to its inboxes' addresses
(or, with the domain's catch-all on, to any address on it) is stored for the
team, listed under Inboxes → All received, and sent to `email.received`
webhooks (Resend's receiving API and payloads). The mail server is the `mx`
compose service (`PROCESS=mx`):

- It accepts mail only for domains a team turned receiving on for, so it is
  never an open relay. Anything else gets `550 5.1.1` during the session.
- It asks the app about each recipient, checks SPF, DKIM, DMARC and ARC, and
  hands every message (up to 40 MiB) to the API before it answers `250`. When
  the app cannot take it, the answer is `451` and the sender retries for days.
- It holds no database and none of the app's keys, offers no AUTH, and never
  sends mail: refusals happen in the SMTP session, so it causes no backscatter.

You need a hostname for it (`mx.example.com`) with an A record pointing at this
host's public IPv4 address, and inbound TCP 25 open (many providers block
outbound 25; inbound is usually open, but check yours).

1. In `.env`, set the hostname and a shared secret. The app needs both to
   enable receiving; the MX greets as that hostname and presents the secret.

   ```sh
   RECEIVING_MX_HOST=mx.example.com
   MX_INGEST_SECRET=          # openssl rand -hex 32
   COMPOSE_PROFILES=mx        # comma-separated with any others
   ```

2. Give the MX a certificate, so senders can use STARTTLS (without one, mail
   still arrives, unencrypted). A certbot deploy hook copies the keypair into
   `mx-tls/` next to `docker-compose.yml`, owned `root:1000` with mode 0640;
   the compose file adds the container's non-root user to group 1000 so it can
   read them without making them world-readable. With nginx from the section
   below on port
   80 (or `--standalone` instead of `--nginx` when port 80 is free):

   ```sh
   sudo install -d -m 0750 -o root -g 1000 /opt/millionsend/mx-tls
   sudo certbot certonly --nginx -d mx.example.com --deploy-hook \
     'install -m 0640 -o root -g 1000 "$RENEWED_LINEAGE/fullchain.pem" "$RENEWED_LINEAGE/privkey.pem" /opt/millionsend/mx-tls/'
   ```

   certbot saves the hook and runs it after every renewal, and the MX picks up
   the new files within five minutes, without a restart.

3. `docker compose up -d`, then `docker compose logs mx` should show
   `tls_loaded` and `listening`.

4. In the dashboard, open a verified domain, turn on **Receiving**, and add
   the MX record it shows (priority 10, pointing at `RECEIVING_MX_HOST`). Use
   a subdomain such as `inbound.example.com`: an MX record on the domain
   itself would route all of its mail here, mailboxes included. Then turn on
   **Catch-all** to take mail at every address, or create an inbox per
   address under Inboxes; with neither, the domain refuses all mail.

Notes:

- Port 25 is published on IPv4 only. Over IPv6, Docker's userland proxy hands
  every connection over with its own address, which breaks SPF and the
  per-address limits.
- The MX reaches the API on the compose network
  (`http://millionsend:<PORT>/internal/mx`). To run it on another host, use
  [`deploy/mx/docker-compose.yml`](deploy/mx/docker-compose.yml) with
  `MX_INGEST_URL=https://<your API origin>/internal/mx`, `MX_HOSTNAME`, and the
  same `MX_INGEST_SECRET`; behind nginx, the API's `client_max_body_size`
  must allow a 40 MiB delivery (the example below sets `60m`), and
  `large_client_header_buffers` a header line of about 13 KB (`16k`), since
  the delivery's envelope travels in one header.
- Limits, with their defaults: `MX_MAX_CLIENTS` (200),
  `MX_MAX_CONNECTIONS_PER_IP` (10), `MX_CONNECTIONS_PER_IP_PER_MINUTE` (60),
  `MX_MAX_RECIPIENTS` per message (50, at most 100), `MX_SOCKET_TIMEOUT_MS`
  (300000, idle), `MX_SESSION_TIMEOUT_MS` (600000) and `MX_MAX_BUFFERED_MB`
  (512, message bytes all sessions may hold at once; past it senders get
  `452` and retry). Under compose, set them in the `mx` service's
  `environment` in `docker-compose.override.yml`.
- Logs are one JSON object per line: envelope facts (domains, sizes,
  verdicts) and outcomes, never message content.
- When a release changes what the MX sends the app (such as the detailed
  authentication results it records per message), upgrade the app first and
  a separate MX after. Either order keeps mail flowing; the compose `mx`
  service runs the app's own image, so it moves with the app.
- Settings → Receiving shows the operator the MX host, the last message,
  today's count, virus scanning and the shared inbox domain.

**Shared inbox domain (optional).** Teams can create inboxes that need no DNS
of their own: each team gets a subdomain of `SHARED_INBOX_DOMAIN`
(`acme.agents.example`), and each inbox a random address there. Use a domain
of its own, not a subdomain of one your teams send from, so agent mail and
any abuse of it stay off your main domain's reputation; no team can add it,
or a name under it, as a sending domain.

1. DNS: `*.agents.example MX 10 <RECEIVING_MX_HOST>` (one wildcard covers
   every team) and `_dmarc.agents.example TXT "v=DMARC1; p=reject"`.
2. SES: verify `agents.example` as a domain identity with Easy DKIM in the
   default region (the first of `AWS_REGIONS`, or `AWS_REGION`) and publish
   its DKIM records. Mail from shared addresses has no team domain, so it
   goes out from that region and its default configuration set.
3. `.env`: `SHARED_INBOX_DOMAIN=agents.example`, then `docker compose up -d`.
   The app refuses to boot without `RECEIVING_MX_HOST`.
4. Check: `dig +short MX test.agents.example` prints your MX host; create an
   inbox with **Random address**, write to it, reply from it, and the reply
   should arrive with DKIM passing for `agents.example` and DMARC passing.

**Virus scanning (optional).** With `CLAMAV_HOST`, every received message is
scanned by ClamAV's clamd before it is stored; infected mail is held and its
downloads are blocked for good. Both compose files carry a `clamav` service:

```sh
COMPOSE_PROFILES=mx,clamav   # with any others
CLAMAV_HOST=clamav:3310
```

It runs `clamav/clamav-debian:1.4`, ClamAV's Debian image, built for amd64
and arm64 (the Alpine-based `clamav/clamav` is amd64 only), and keeps its
signatures current by itself in the `clamav-db` volume. Port 3310 stays on
the compose network: clamd's protocol has no authentication or encryption.
clamd holds its signatures in memory, over 1 GiB and about twice that while
it reloads them daily, and ClamAV recommends 4 GiB of RAM. A clamd elsewhere
works as `CLAMAV_HOST=host:port` (3310 by default) on a private network, with
a `StreamMaxLength` of at least 40 MB. When clamd can't answer (stopped,
loading, over 30 seconds), mail is delivered with
`virus_verdict: "processing_failed"` and a warning, and the failure goes to
error tracking.

**Screening agent inboxes.** Agent inboxes screen mail from outside senders
for prompt injection with the content monitoring judge (`ABUSE_JUDGE`, below):
on with the judge, rules alone without it. Screening counts apart from content
monitoring, under the same `MONITOR_TEAM_DAILY_CAP` and
`MONITOR_INSTANCE_DAILY_CAP` values plus 200 per inbox per day; past one, mail
that needs screening is quarantined, never delivered unscreened, and its
verdicts never touch a team's risk. Each screened message sends TypeSafe the
sender and its authentication results, the subject and visible text (codes
masked, addresses cut to their domain), the removed hidden text, link texts
and domains (never fetched) and attachment names: list that in your privacy
notice before turning the judge on.

</details>

<details>
<summary><b>Signup policy</b></summary>

The first user to register becomes the initial account — no configuration needed.
After that, registration is closed: anyone with an account can create API keys that
send through your SES account, so signup stays off unless you opt in with
`ALLOW_SIGNUP=true`. Keep port 3000 off the public internet unless you have opened
signup deliberately.

With `BLOCK_DISPOSABLE_EMAILS=true` (the cloud default), addresses on the
[disposable-email-domains](https://github.com/disposable-email-domains/disposable-email-domains)
list (public domain) are refused at sign-up, on invitations and on email changes; a
subdomain counts as its parent. Accounts that already use one keep working, and the
console tags them. The app ships the list; while the block is on, the worker refreshes
it daily from `raw.githubusercontent.com` and keeps the last good copy when a download
fails or the list grows or shrinks by more than a fifth in a day (that one is logged).
Consumer mailbox providers (Gmail, Outlook, Yahoo, iCloud, Proton, UOL, BOL, Terra and
the like) and public suffixes (`com.br`, `github.io`) are never refused, whatever the
list says.

</details>

<details>
<summary><b>Account mail, contacts and product updates</b></summary>

MillionSend's own emails go out from `AUTH_EMAIL_FROM` / `NOTIFICATIONS_EMAIL_FROM`: to a
person about their account (password reset, verification, welcome, a password-changed
receipt, an app granted access) and to a team's owners (invitations, quota and
deliverability notices, a domain verifying or losing its records, a new API key, a rotated
webhook secret, a member joining, a broadcast that went out or is held, billing on the
cloud). Broadcast reports go out as the broadcast finishes and billing notices from the
Stripe webhook itself; the other owner notices ride the ten-minute notification sweep. All
read in the language of the owner's contact in the team below, else English; each owner picks
which notices they get under **Settings → Notifications** (account mail and security receipts are
always sent). Verify the sender's domain under
**Domains** in a team and those emails are logged and measured there, tagged
`millionsend_system`. Password-reset, verification, invitation, subscription-confirm and
console-code emails lose their body once SES accepts them, since the link or code inside is
a live credential; the other notices keep theirs for the usual retention window. Until a
team holds the domain they go straight through SES and leave no trace.

What a customer typed (team, person, domain, key and broadcast names, webhook URLs,
addresses) never appears in a subject, and the body prints it as text no mail client turns
into a link (a hair space follows each `.`, `@`, `:` and `\`) or a number to call (a run of
seven or more digits keeps its first four, unless it is exactly one date such as `09/10/2026`
or `2026-10-09`, or one span of up to ten years such as `2025-2026`), cut at 64 characters.
Team and display names with a link scheme, an `@`, a line break, an invisible character or a
run of eight or more digits (such a date or span of years aside) are refused when set; the
joiners and selectors inside an emoji or a Persian or Indic word are writing, not hidden
text, and stay in names and in mail. A team name that matches a brand phishers often imitate
(`PayPal`, `Itaú`, `Correios` and others, look-alikes such as `PayPa1` included) is allowed
and opens a `brand` flag on Trust & safety at creation or rename. Verification and
password-reset emails greet nobody by name; an invitation names the inviter by their
verified address (no inviter when it is unverified) and the team only once the content
monitor has it past the new tier. A team, and one member across all their teams, creates at
most `INVITES_PER_TEAM_PER_DAY` invitations a day (default 50, revoked ones and those of
deleted teams included), one pending per address, and however many accounts and teams ask,
one address gets at most 5 verification and invitation emails a clock hour and 10 a UTC day.

That team is the instance's own, and an operator can mark it as such: on the `system` plan
it is never capped or billed and its badge reads System. On a self-hosted instance plans
carry no limits, but the mark does more than label the team: the content monitor never
holds it, the new-domain warm-up never caps its domains, a pause for its bounce or complaint
rate refuses its new sends but never holds mail it already queued, and its contacts are the
list a suspension unsubscribes a team's members from. Account mail is exempt from that pause
whatever its team's plan: the pause neither refuses nor holds what the instance's own
account-mail path sends, the only path that can tag an email `millionsend_system`.

On an instance with `ALLOW_SIGNUP=true`, every new account becomes a contact of that team
(`source: signup`) once its address is verified; the sign-up screen says so, and deleting the
account removes the contact and scrubs the address from that team's history. A closed instance enrolls nobody. Email
verification is on whenever `AUTH_EMAIL_FROM` and SES credentials are set; earlier accounts
verify at their next sign-in.

Nothing on the instance contacts millionsend.com on its own. The wizard offers, once and
interactively, to subscribe your address to release notes (a confirmation link comes first);
when it cannot reach millionsend.com it prints the page instead,
<https://app.millionsend.com/updates?source=self-host>, and **Settings → Instance** links to
the same page. Full text: docs, "Account mail, contacts and product updates".

</details>

<details>
<summary><b>Production: nginx + TLS</b></summary>

The recommended production shape: nginx on the host terminates TLS and proxies
one hostname per service, and the compose ports bind to loopback so nginx is
the only way in. The API needs its own hostname (or an exposed port): its
routes (`/emails`, `/domains`, …) share paths with dashboard pages, so the two
cannot split one hostname by path. Set `PUBLIC_API_URL` to that hostname — it
is what the dashboard prints as the API base and what MCP tokens are bound to;
unset, the API is assumed at port 3001 of the dashboard host.

`/etc/nginx/conf.d/millionsend.conf`:

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ""      close;
}

# Dashboard.
server {
    listen 80;
    server_name mail.example.com;

    # The broadcast editor posts full HTML bodies through the dashboard.
    client_max_body_size 25m;

    # SES events: SNS is subscribed at {APP_BASE_URL}/ses/events, and the api
    # process serves that path, not the dashboard.
    location = /ses/events {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
    }
}

# API.
server {
    listen 80;
    server_name api.example.com;

    # The largest request is an inbound message of up to 40 MiB the MX
    # delivers to /internal/mx; the API holds everything else to 25 MiB. 60m
    # covers it without unbounded uploads.
    client_max_body_size 60m;
    # The MX sends a delivery's envelope in one header of up to about 13 KB,
    # over nginx's default 8k line; a 400 there defers that mail until the
    # sender gives up.
    large_client_header_buffers 4 16k;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

# Docs (optional).
server {
    listen 80;
    server_name docs.example.com;

    location / {
        proxy_pass http://127.0.0.1:3002;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
    }
}
```

TLS and the http→https redirect in one line — certbot rewrites the blocks
above to listen on 443 with Let's Encrypt certificates, adds the redirect,
and installs automatic renewal:

```sh
sudo certbot --nginx --redirect -d mail.example.com -d api.example.com -d docs.example.com
```

Then set `APP_BASE_URL=https://mail.example.com` and
`PUBLIC_API_URL=https://api.example.com` in `.env` and restart. `APP_BASE_URL`
must be the exact public https origin of the dashboard — any other value makes
login and signup fail with an "invalid origin" error. Forward `Host` and
`X-Forwarded-Host` to the dashboard and docs upstreams as above, so any
absolute URL either app derives from the request names the public hostname
rather than `localhost`.

Client addresses (sign-in rate limits, audit entries) come from
`X-Forwarded-For`, and only proxies listed in `TRUSTED_PROXIES` (comma-separated
IPs or CIDRs; default `127.0.0.1,::1`, which covers nginx on the same host)
are believed. With `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for`
each hop appends itself, and the chain is walked right-to-left past every
trusted proxy, so the first untrusted address is the client. Add your
proxy's address when it runs on another host, and a CDN's ranges when one
sits in front of nginx; headers from any other source are ignored and the
socket address is used instead.

The compose files bind every application port to loopback by default so only a
local reverse proxy reaches them. Docker publishes ports by editing iptables
directly, so do not rely on a host firewall to compensate for a public bind.
The defaults are equivalent to:

```yaml
services:
  millionsend:
    ports: !override
      - "127.0.0.1:3000:3000"
      - "127.0.0.1:3001:3001"
  # With the nginx stream module below, keep the relay loopback-only too:
  # smtp:
  #   ports: !override
  #     - "127.0.0.1:2587:2587"
```

The SMTP relay (`:2587`) is TCP, not HTTP — an `http` server block cannot
proxy it. To publish a service directly, set its `*_BIND_ADDRESS=0.0.0.0` and
open only that firewall port. Prefer keeping SMTP on loopback and passing the TCP stream through nginx's
stream module — bytes pass through untouched, so STARTTLS still terminates in
the relay via `SMTP_TLS_CERT_PATH`/`SMTP_TLS_KEY_PATH`:

```nginx
# /etc/nginx/nginx.conf — top level, outside the http {} block
stream {
    server {
        listen 2587;
        proxy_pass 127.0.0.1:2587;
    }
}
```

Firewall: allow 80 and 443, plus 2587 only if the SMTP relay is used from
outside and 25 when the MX receives mail; everything else closed:

```sh
sudo ufw default deny incoming
sudo ufw allow 80,443/tcp
sudo ufw allow 2587/tcp   # only if the SMTP relay is exposed
sudo ufw allow 25/tcp     # only with the mx profile
sudo ufw enable
```

</details>

<details>
<summary><b>Object storage (team logos)</b></summary>

Optional. With an S3-compatible bucket configured, team admins can upload a
team logo in the dashboard; it also brands hosted unsubscribe pages when
MillionSend branding is hidden. ONE `S3_*` credential set is shared with the
backup job below — each feature is then enabled by its own bucket variable.

The storage step of `npx @millionsend/setup` prompts for the endpoint and
keys, creates (or adopts) both buckets — `millionsend-storage` and
`millionsend-backups` by default — and writes the `S3_*` lines to `.env`.
The one thing it cannot do over the S3 API is make the uploads bucket serve
objects publicly: on R2, enable public access on the bucket (or attach a
custom domain), then set that URL — uploads are addressed as
`${S3_STORAGE_PUBLIC_URL}/<key>`:

```sh
S3_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_STORAGE_BUCKET=millionsend-storage
S3_STORAGE_PUBLIC_URL=https://<public-bucket-url-or-custom-domain>
```

Keep the two buckets separate: R2 public access is bucket-wide, so a database
dump in the public uploads bucket would be world-readable.

</details>

<details>
<summary><b>Backups</b></summary>

The `backup` compose service takes a scheduled `pg_dump` of Postgres and
uploads it to any S3-compatible bucket via rclone — Cloudflare R2 works out of
the box. It is off by default: without `S3_BACKUP_BUCKET` the container prints
`backups disabled — set S3_BACKUP_BUCKET to enable` and exits 0, harmless.

Enable it by setting the shared S3 credentials and a backup bucket in `.env`
(the setup wizard's storage step creates the bucket and writes these lines).
The bucket must exist before the first dump and must stay private — dumps
contain the whole database, and R2 public access is bucket-wide, so never
reuse the public uploads bucket. For R2 the defaults `S3_PROVIDER=Cloudflare`
and `S3_REGION=auto` are already right:

```sh
S3_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_BACKUP_BUCKET=millionsend-backups
```

Then add `backup` to `COMPOSE_PROFILES` in `.env` and `docker compose up -d`:
the service dumps once immediately, and after that daily on `BACKUP_CRON`
(default `0 3 * * *`, UTC). That first dump is skipped when the bucket already
holds one from the last 26 hours, so restarts and upgrades don't take another:
a dump holds a lock on every table until it ends, and the app's migrations
would wait behind it. Only the daily form `<minute> <hour> * * *` is
honoured — the sidecar runs unprivileged as `postgres` with every capability
dropped, so the schedule is a sleep loop rather than crond, and any other
shape makes the service exit 1. Each dump is `pg_dump -Fc`
(compressed custom format, named `millionsend-YYYYMMDD-HHMMSS.dump`), its
uploaded size is verified against the bucket before anything else happens, and
dumps older than `BACKUP_RETENTION_DAYS` (default 14) are pruned.
`S3_BACKUP_PREFIX` (default `backups`) sets the object key prefix.

Set `BACKUP_AGE_RECIPIENT` to an [age](https://age-encryption.org) public key
(`age1…`) to encrypt each dump before upload (`.dump.age`); the bucket then
never holds a readable copy of the database. Keep the matching private key
with `MASTER_ENCRYPTION_KEY`, and restore with `age --decrypt -i <key file>`
before `pg_restore`.

The dumps contain email bodies encrypted with `MASTER_ENCRYPTION_KEY` — back
that key up separately, or restored bodies are unrecoverable.

The standalone `deploy/docker-compose.yml` runs the published
`ghcr.io/millionsend/backup` image (`MILLIONSEND_BACKUP_IMAGE` pins it, the way
`MILLIONSEND_IMAGE` pins the app); a repository clone builds it from
`scripts/backup`.
Restores use the same container either way.

For a one-off dump (before a big upgrade, say), run one cycle by hand; it
dumps even when the bucket already holds a recent one:

```sh
docker compose run --rm --entrypoint /usr/local/bin/backup.sh backup
```

Restore (stop the app first so nothing writes mid-restore):

```sh
docker compose stop millionsend smtp
# list the bucket, pick a dump
docker compose run --rm --entrypoint /usr/local/bin/backup.sh backup \
  sh -c 'rclone lsl ":s3:$S3_BACKUP_BUCKET/${S3_BACKUP_PREFIX:-backups}"'
# download it and restore over the current database
docker compose run --rm --entrypoint /usr/local/bin/backup.sh backup \
  sh -c 'rclone copyto ":s3:$S3_BACKUP_BUCKET/${S3_BACKUP_PREFIX:-backups}/millionsend-YYYYMMDD-HHMMSS.dump" /tmp/restore.dump \
    && pg_restore --clean --if-exists -d "$DATABASE_URL" /tmp/restore.dump'
docker compose start millionsend smtp
```

</details>

<details>
<summary><b>Console</b></summary>

The instance console at `/console` is the operator's view of the whole
deployment, outside any team: an overview (sends, deliverability, teams,
contacts, domains, queue, one card per SES region with its quota, pricing
plan and enforcement status, and the health probes with their history), a
Regions page (served and not-yet-provisioned regions, the steps to add one),
a Teams page with operator actions (change plan or type, a daily send
ceiling, pause broadcasts, suspend and reinstate), a Trust & safety page
built on the guardrail, the account score, the 7-day rates and the stored
content insights (never email bodies), and an instance-wide audit log.

- **Who can open it:** only the instance operator — the first registered
  user. Anyone else, signed in or not, gets the same 404 as a route that
  does not exist. Nothing in the team sidebar or the command palette links
  to it.
- **How to open it:** **Settings → SES** shows the operator an "Instance
  console" card with an "Open console" button; the direct URL
  `https://<your-host>/console` works as well.
- **What it costs:** every number comes from Postgres or from a free SESv2
  `GetAccount` read per region (cached for a minute). No Cost Explorer, no
  CloudWatch; the cost per region is a local estimate (sends this month ×
  the region's pricing-plan rate).
- **Probes:** the worker samples the instance every minute
  (`instance_probes`: Postgres latency and size, the worker heartbeat,
  pg-boss depth, SES events lag, webhook success rate, KMS wrap latency on
  cloud, the last Stripe event, retention purges) and refreshes every active
  team's standing and the automatic trust & safety flags every 15 minutes.
  History is kept 90 days.
- **Operator actions and the team:** a suspended team's API keys still
  authenticate but every send answers `403 team_suspended` (SMTP `550`;
  under a review hold, mail through the API or SMTP is accepted and parked,
  and only broadcast sends answer, `403 sending_paused`),
  broadcasts in flight park, webhooks keep delivering and data stays; of the
  mail about the team, only the suspension and reinstatement notices, billing
  mail and the security receipts (a new API key, a rotated webhook secret, a
  member joining) still reach its owners, and none of it under a phishing
  suspension or a review hold (Stripe still sends its own receipts), while
  mail about a person's own account and mail to the operator, such as the
  content monitor's alerts, still go out; a suspension for any reason but a
  review hold or non-payment also unsubscribes every member from the
  instance's own contact list (the contacts of the team on the `system` plan,
  where product announcements go), with the reason on each contact's timeline
  and no webhook, and reinstating does not subscribe them again, only their
  own opt-in does (upgrading to this release unsubscribes, once, the members
  of teams already suspended for those reasons, except a contact changed
  since its team's suspension); nobody on it can
  delete it, remove its domains (the API answers `403 team_suspended` there
  too) or invite anyone, and a member of a team suspended for phishing or
  held for review cannot create new teams (under either reason each of these
  refusals is one neutral line that never says suspended, the API's domain
  delete answers `403 forbidden`, and the team's own audit log shows the
  suspension without the operator's note); the team's audit log never lists
  trust & safety flags or the content monitor's actions (its broadcast pause,
  the resume and a sampling override), shows a broadcast pause the owner was
  not emailed about without its reason or note, and shows every operator
  action as MillionSend, never the operator's name or email; a
  broadcast pause parks broadcasts while transactional mail flows; a daily
  ceiling caps the team's UTC day under its plan. Owners are emailed about
  each of these (never for a phishing suspension or a review hold), and
  every action is recorded in the audit log with its reason. With
  `SES_TENANTS` on, a suspension also disables the team's SES tenant in
  every region it has a domain in, and reinstating enables it again; an AWS failure never holds
  the suspension back: the console warns, the audit log records it, and the
  worker retries.
- **Sign-up records:** every sign-up's IP and browser are kept in a record
  only the console reads, apart from the sessions, which expire. The hourly
  retention sweep deletes it 90 days after the account is deleted, or 12
  months after when the account was in a team suspended for phishing, manual
  or reputation reasons and not reinstated. A team's dialog lists each member's sign-up IP, the
  IP of their latest session and the other accounts seen on those IPs,
  suspended ones marked. With `IP_GEOLOCATION` on (the cloud default), the
  worker downloads DB-IP's free country and ASN databases (CC BY 4.0) from
  `download.db-ip.com` once a month, keeps the last good copy when a download
  fails, and the dialog adds each sign-up IP's network and country, looked up
  locally.
- **Campaign linkage:** a team suspended for phishing leaves fingerprints that
  outlive it (its people's addresses, Gmail dots and `+tags` ignored, and sign-up
  IPs, its verified domains and card, and from its latest stored mail the sender
  names, subjects, link domains, phone numbers and a visible-text hash). IPs of
  shared egress networks (Cloudflare WARP, iCloud Private Relay, Vivo, Claro,
  TIM) are left out. A new team is compared with them when it is created, adds a
  domain, first pays and sends; a match opens a `linked` flag and mails the
  operator the kinds of evidence, and the team's dialog and review page show the
  values. Only a send holds the team for review, its mail parked silently, and
  only when the match includes an email address, a card or two kinds of evidence
  and the automatic hold is on. Only teams still suspended for phishing count,
  and the fuzzy rules are strict: sender names need two shared distinctive
  words, subjects four words overlapping by 75%, domain names two words of four
  letters or more filling 80% of the other name. A reinstatement deletes a team's
  fingerprints; otherwise they go 12 months after the suspension, IPs after 90
  days.

</details>

<details>
<summary><b>Content monitoring (optional)</b></summary>

Off by default. With a judge configured, TypeSafe Jev scores mail 0–100
and every verdict is folded into a per-team risk the operator sees on Trust
& safety.

**Judged before SES.** A team's mail in its first window (its first 1,000
sends and 72 hours, counted from its first send) is judged before SES takes
it: the email waits in the queue, the send lane moves on, and the verdict,
first in the judge's queue, sends it on in about half a second. A New-tier
team's broadcast writes no copy until its own HTML has a verdict, and its
first rendered copy waits for its own. One team uses at most two of the
judge's four lanes, and a screened email gets a 5 s timeout and one retry.
When the judge still cannot answer, mail from a sending domain under 7 days
old, or of unknown age, waits: the judge is tried again every 2 minutes, 3
times, then the email is parked for the operator, who hears of it through
the judge-health notice; any other mail is sent and judged afterwards. No
daily cap lets mail that waits on a verdict through unjudged: the caps count
and stop only draws made after sending. A team with 20 screenings waiting on
the judge has its next mail wait its turn. The rest of accepted mail is
drawn after SES has taken it, at its tier's rate. Account mail and the
onboarding email are never judged.

A judge failure of any kind (feature off, missing credentials, throttling,
timeout, upstream error, unparseable answer, body already purged by
retention) records the sample as unjudged and changes nothing else. The deterministic content checks (`email_insights`, the
guardrail, the account score) run on every send whether or not the judge is
on. Self-hosters can leave it off; the cloud runs it.

**What it does and does not do.** It opens the `monitor` flag on Trust &
safety when a team's risk crosses the flag line, emails the operator once a
day per team past the alert line, and, for a team in the New tier only
(inside its first 1,000 sends or 72 hours, or under 10,000 sends within 7
days), pauses broadcasts when the risk passes the pause line and a sampled
message scored 90 or more within a day, or at once when a broadcast's own
HTML or a rendered copy draws a phishing-type verdict from 80 (transactional
mail keeps flowing; the team sees "paused pending review"; the operator
resumes from the review page). The pause policy is a setting and can be
switched off.

**The review hold.** When one sampled message of a New-tier team is judged
abuse at the hold score (90 by default) as credential phishing, brand
impersonation or payment redirection, or with an impersonation or
secret-harvesting finding, or at the repeat score (80) while the team's
sending domain was registered under 7 days before, or is of unknown age, the
team is suspended at once
with the reason `review`: mail it sends through the API (`POST /emails` and
`/emails/batch`, which MCP uses too) or SMTP is accepted as any send is and
parked (`park_reason = 'review'`), queued mail and broadcasts park, a new
broadcast is refused with `403 sending_paused`, and with `SES_TENANTS` on its
SES tenant is disabled. A run of lower verdicts holds the team too: by
default the fifth such verdict from 80 within any seven days while the team
is New. A link to
another domain counts toward neither rule on its own: legitimate mail often
links elsewhere. The operator is emailed at once, with the rule that held the
team; the owner is not. The dashboard shows a neutral "Sending is paused
pending review" notice, while the API and SMTP answer as for any accepted
send, so a sender is never told it was caught. The team stays on Trust &
safety with its flag open until the operator decides on its review page:
**Release hold** reinstates it, the parked mail goes out, a broadcast pause
the monitor applied before the hold is lifted as **Resume broadcasts** lifts
it (a pause the operator set by hand stays), and the monitor flag the hold
kept open is cleared in the operator's name (the automatic check does not
reopen it while the same trigger holds); **Suspend for phishing** turns the
hold into a phishing suspension, and what the hold parked stays parked:
`quota.drain` never releases a suspended team's mail. While the team is held, its later verdicts
still move its risk and alert the operator as for any other team, but apply
no pause, so a release leaves no monitor pause behind. A team is held once, by either
rule: after a release its later verdicts only alert, so the released mail,
judged again on its way out, neither holds it a second time nor pauses its
broadcasts. A team already
suspended keeps its suspension, and Probation, Established and Trusted teams
are never held: they stay alert-only. The system team is exempt: the monitor
never samples it. A message judged before SES that holds the team waits with
the rest of its mail; one judged after sending had already gone out, and the
hold stops what follows. In the first window, a message judged phishing-type
from 80 that holds nothing waits 2 minutes before it is sent: a burst
reaches the repeat count within them. `MONITOR_AUTO_HOLD=false` switches the
hold off, and the screening before SES with it.

**New destinations, at every tier.** A message is also judged before SES,
whatever the team's tier (Trusted included), when it carries a destination
the team has not cleared: the owner domain of a link (a free host's
`x.pages.dev` counts on its own) or of its Reply-To, less the team's
verified domains. A verdict under 70 that names nothing phishing-type clears
the message's destinations for the team, when it carried 5 new ones at most;
so does releasing mail parked for a new destination, or waiting after a
verdict, while releasing mail parked for its media or a failing judge clears
none. A link shortener is never cleared. For 7 days after a destination
clears, every email to it is judged after it is sent, and a phishing-type
verdict from 80 on one takes the clearance back: mail to it is judged before
SES again, no verdict clears it again (an operator's release does), and the
operator is mailed at most once a day per team. A message with more than 20
new destinations is not judged: it waits for the operator. A broadcast is
judged before its fan-out when its own HTML carries a new destination, and a
rendered copy when a contact field put one there; mail that links only to
the team's own domains never waits for this. When a new destination draws a
phishing-type verdict from 80, its link domains' registration dates are
looked up, in a cache every team shares: 3 per verdict, the rest in the
background, and a failed lookup is not repeated for an hour (a free host's
names and shorteners are not dated, and a date no registry has is not
young). An age not known yet, because its lookup failed, ran past 10
seconds or waits its turn, counts as young. For a New-tier team, such a
verdict on a link domain registered under 7 days ago holds the team, and one
of an age not known makes its mail wait 2 minutes. Past New, the mail is
parked for the review list on a phishing-type verdict from 90, or from 80
with a link domain under 7 days old or of an age not known, and the operator
is mailed at most once a day per team; a team past New is never held
automatically. These samples count against no daily cap; a team has 200 of
them a day, past which its mail with a new destination waits for the next
UTC day.

**The review list.** Trust & safety lists every unsent email screening
stopped, grouped by team: parked behind a review hold, waiting out its 2
minutes, parked for a new destination, or parked after the judge kept
failing. **Release** sends an email
without screening it again (`quota.drain` charges it as any parked mail);
**Cancel** means it never goes out. **Release all** and **Cancel all** ask
first, with the count, and take only mail held before the list was loaded.
A held team's mail is released with its hold, and a suspension for anything
else cancels it, so no later reinstatement sends it. The team's review page also lists its held unsent emails among the
flagged ones, so a content access can name them.

**Turning it on** (in the instance's `.env`, read by the worker and the
app; a restart applies it):

```sh
ABUSE_JUDGE=typesafe
ABUSE_JUDGE_API_KEY=...
# Optional; jev-1.13.0 is the default.
ABUSE_JUDGE_MODEL=jev-1.13.0
ABUSE_JUDGE_TIMEOUT_MS=20000
```

A missing API key fails the boot. The default model is a pinned version, not
the `jev-latest` alias, because the score thresholds are calibrated against
one version's answers: move to a newer version deliberately, after checking
its scores. Each sample records the versioned
model id that answered. `ABUSE_JUDGE_BASE_URL` (default
`https://api.typesafe.ai`) points the judge at another endpoint serving the
same API; it posts to `<base>/v1/systemone`. The questions Jev answers ship in
`packages/core/src/abuse-judge/questions.ts`.

**Where the samples go.** Every sampled message is sent to TypeSafe, a
sub-processor that hosts its service in the United States. Per its published
terms, its data processing agreement keeps personal data for as long as
necessary for the purpose of the processing; its customer agreement gives it
a perpetual licence to use submitted data for fraud and abuse monitoring,
telemetry and legal compliance; zero data retention is offered only on
enterprise plans; submitted data is not used to train its models. Its DPA
offers the EU standard contractual clauses and the UK Addendum as transfer
mechanisms, and no Brazilian (ANPD) clauses. Before turning the judge on,
accept TypeSafe's [data processing agreement](https://typesafe.ai/legal/data-processing),
list TypeSafe as a sub-processor, and describe it in the instance's privacy
notice (see also its [customer agreement](https://typesafe.ai/legal/mca) and
[privacy policy](https://typesafe.ai/legal/privacy-policy)).

**Exactly what Jev sees**, built in memory per call and never stored by
MillionSend: the team's name, verified domains (plus each one's registrable
domain, the form links are shown in, where the suffix is unambiguous), days since its first send
and plan; the `From` and `Reply-To` headers as sent; the `Subject`; the
rendered visible text, without elements hidden by an inline style or the
`hidden` attribute (up to 6,000
characters); a table of link anchor texts and their registrable domains (up
to 30 rows); the image count, the attachment names and content types, and
the count of hidden characters. The subject, the visible text, the anchor
texts and the attachment names are redacted first by the same pass the
break-glass content access uses (links cut to their domain and a short path
stub; credential-shaped strings and 4-to-8-digit codes in the 40 characters
after words like *code*, *OTP*, *senha* or *token* masked); on top of that,
email addresses in them keep only their domain. Whitespace in every field,
line breaks included, collapses to one space. Other personal data written in
these fields (names, phone numbers, tax ids such as CPF, postal addresses) is
not removed: nothing detects it reliably. Never a recipient
address or header, never the raw HTML, never the images or files themselves. The
stored record of a judged sample is the score, verdict, categories, reason
codes, language, model version, latency and error class; the review page
shows those and never a subject or a body. Sample rows are metadata and are
pruned after 90 days.

**Images and attachments.** Screening opens what an email carries, inside
the worker: the text and links of PDF (up to 50 pages), Word, Excel,
PowerPoint, OpenDocument, calendar, HTML and SVG attachments, and the QR
codes in images, in a PDF's first pages and in images inside Office files.
A Pix code, in a QR code or pasted as text, shows as its payee, city,
amount and kind of key, never the key. Jev then also sees up to 4,000
characters of text from attachments, up to 20 more link rows (QR codes,
links inside files, Pix codes), and each attachment's real type, size, page
count and flags. Program files are refused at the API for every team, and
a new team's email carrying a risky file waits for review (see
the API reference's "Attachments"). None of this leaves the
instance: parsing runs on two worker threads, with 4 seconds per email.

For a New-tier team, an email that carries a file, or whose message rides in
images, files or a QR code drawn with characters (under 100 characters of
readable text), is judged before SES, and its body images are read too. A
file the policy flags, refuses or cannot open parks it at once; after the
verdict, so does a QR code the image reader saw that no decoder read, or
images the reader declined. Images Bedrock refuses (HTTP 400) park any
team's unsent email, keep no preview, and the operator is mailed at most
once a day per team. When a body image cannot be fetched or Bedrock does not
answer, a New-tier team's mail from a sending domain under 7 days old waits
as for a judge outage; other mail is judged without those images, and Jev is
told what was not read. Links in files and QR codes count as destinations at
every tier. Past New, a sampled email has its body images read when its
readable text is under 100 characters, and such an email, like one with
files, counts as an anomaly in the draw.

**Image reading (optional).** Off by default. With it on, Claude Haiku 5.5
on Amazon Bedrock writes down the text and the brands shown in an email's
images and in attachment pages that are images, and Jev receives that text
(up to 3,000 characters) with the rest. The worker sends the images to
Bedrock in `ABUSE_VISION_REGION` (default `us-east-1`) with its AWS
credentials. Bedrock serves the model there only through cross-region
inference profiles, and the worker uses the one for that region's
geography: from `us-east-1`, `us.anthropic.claude-haiku-5-5`, which reads
them in N. Virginia, Ohio or Oregon. The global profile, which may read
them anywhere, is never used.
Bedrock keeps no copy, except that AWS may keep an image its automated
checks flag as child sexual abuse material, in the region that read it.
Off, an email is judged without its image text and the judge is told so.
Refusing program files, holding risky files and reading PDFs, Office files
and QR codes all work without Bedrock.

`ABUSE_VISION_REGION` must be a region with such a profile; with image
reading on, any other region stops the instance from starting: `us-east-1`,
`us-east-2`, `us-west-1`, `us-west-2`, `ca-central-1` and `ca-west-1` (US
profile; from Canada, images may be read in the US too), `eu-central-1`,
`eu-central-2`, `eu-north-1`, `eu-south-1`, `eu-south-2`, `eu-west-1`,
`eu-west-2` and `eu-west-3` (EU profile; from London or Zurich, images may
be read in the EU too), `ap-southeast-2` and `ap-southeast-4` (Australia),
`ap-northeast-1` and `ap-northeast-3` (Japan). To turn it on:

1. Accept Claude Haiku 5.5 in Amazon Bedrock in that region: on the
   console's model access page, or with
   `aws bedrock list-foundation-model-agreement-offers --model-id anthropic.claude-haiku-5-5`
   and then
   `aws bedrock create-foundation-model-agreement --model-id anthropic.claude-haiku-5-5 --offer-token <token>`.
2. Give the worker's AWS credentials these two statements, with your region
   and account id. The second lists the model in each region the profile
   may send images to: from `us-east-1`, `us-east-2` or `us-west-2`, the
   three below. From another region, list them with
   `aws bedrock get-inference-profile --region <region> --inference-profile-identifier <geo>.anthropic.claude-haiku-5-5 --query 'models[].modelArn'`,
   where `<geo>` is `us`, `eu`, `au` or `jp`, and use that prefix in both
   statements. A service control policy that blocks any of these regions
   makes reads fail unless it exempts this profile with the
   `bedrock:InferenceProfileArn` condition key (see AWS's "Geographic
   cross-Region inference").

   ```json
   [
     {
       "Effect": "Allow",
       "Action": "bedrock:InvokeModel",
       "Resource": "arn:aws:bedrock:<region>:<account-id>:inference-profile/us.anthropic.claude-haiku-5-5"
     },
     {
       "Effect": "Allow",
       "Action": "bedrock:InvokeModel",
       "Resource": [
         "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-haiku-5-5",
         "arn:aws:bedrock:us-east-2::foundation-model/anthropic.claude-haiku-5-5",
         "arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-haiku-5-5"
       ],
       "Condition": {
         "StringEquals": {
           "bedrock:InferenceProfileArn": "arn:aws:bedrock:<region>:<account-id>:inference-profile/us.anthropic.claude-haiku-5-5"
         }
       }
     }
   ]
   ```

   If the worker's credentials were given `bedrock-mantle:CreateInference`
   for image reading, replace it with these two statements: until then
   Bedrock denies every read (HTTP 403), and mail is handled as when Bedrock
   does not answer. Check step 3 too: that quota is separate from the one
   image reading used before. If `ABUSE_VISION_REGION` is not one of the
   regions above (São Paulo, `sa-east-1`, has no such profile), set one of
   them or `ABUSE_VISION=off` before upgrading, or the instance will not
   start.
3. In Service Quotas, check Amazon Bedrock's "Cross-region model inference
   tokens per minute for Anthropic Claude Haiku 5.5" in that region. AWS's
   default is 10,000,000, but some accounts start at 0, and then no read
   gets through: request an increase, which must ask for more than
   10,000,000.
4. Set `ABUSE_VISION=bedrock` (and `ABUSE_VISION_REGION` for another
   region) and restart. Add Amazon Bedrock to the instance's privacy notice
   first.

**Sampling.** After each accepted message, a keyed draw
(HMAC of the team and message ids under a key derived from
`MASTER_ENCRYPTION_KEY`) decides whether it is judged. Every value below is
edited in the console under Trust & safety → Monitoring settings, or set
as its `MONITOR_*` environment variable until it is; the console wins.

| Setting | Default | Meaning |
| --- | --- | --- |
| `MONITOR_FIRST_SENDS` | 1000 | A team's first N accepted messages are judged in full |
| `MONITOR_FIRST_HOURS` | 72 | Everything in the first H hours after a team's first send is judged in full |
| `MONITOR_RAMP_SENDS` | 10000 | Up to this lifetime count the ramp rate applies |
| `MONITOR_RAMP_RATE` | 0.25 | The ramp rate; the ramp ends at the count above or on the day below, whichever comes first |
| `MONITOR_RAMP_DAYS` | 7 | |
| `MONITOR_PROBATION_RATE` | 0.05 | The ramp's end to day 30 |
| `MONITOR_ESTABLISHED_RATE` | 0.02 | Day 30 onward |
| `MONITOR_TRUSTED_RATE` | 0.005 | 120 days, 50,000 sends and no flag in 90 days |
| `MONITOR_BROADCAST_COPIES` | 3 | Rendered copies judged per broadcast (plus the broadcast's own HTML), established and trusted teams |
| `MONITOR_BROADCAST_COPIES_NEW` | 10 | The same for new, ramp and probation teams |
| `MONITOR_ANOMALY_MULTIPLIER` | 20 | One anomaly (a failing link-domain, shortener or phishing-pattern check, under 100 characters of text carried by images or files, an attachment) multiplies the rate; two force the sample |
| `MONITOR_TEAM_DAILY_CAP` | 600 | Draws after sending per team per UTC day; past it they stop silently. Mail judged before SES neither counts nor is capped |
| `MONITOR_INSTANCE_DAILY_CAP` | 50000 | Instance-wide draws after sending; past it tier sampling stops, first sends and anomalies continue |
| `MONITOR_FLAG_RISK` | 0.5 | The team gets the `monitor` flag and samples four times as much |
| `MONITOR_ALERT_RISK` | 0.7 | The operator is emailed, once per team per day |
| `MONITOR_PAUSE_RISK` | 0.85 | New teams only: broadcasts pause, with a verdict of 90 or more in the last day |
| `MONITOR_AUTO_PAUSE` | true | Whether the pause policy applies |
| `MONITOR_FLAG_SCORE` | 70 | A sample counts as flagged in the console from this score |
| `MONITOR_HOLD_SCORE` | 90 | New teams only: a phishing-type verdict from this score holds the team for review |
| `MONITOR_HOLD_REPEAT_COUNT` | 5 | New teams only: this many phishing-type verdicts from the score below, within seven days of the team's first send, also hold it for review; 0 turns this off |
| `MONITOR_HOLD_REPEAT_SCORE` | 80 | The score from which a phishing-type verdict counts toward the count above |
| `MONITOR_AUTO_HOLD` | true | Whether the review hold applies |

The risk is a decayed mean of the verdicts (half-life 7 days) with a prior
that starts new teams higher; the review page shows it beside the tier,
the last samples and the judge's answer next to each flagged email, and
offers "Sample everything for 7 days". The Overview's Monitoring card
charts the hourly sample count, and the operator is emailed, at most once
every six hours, when more than 20% of an hour's samples (at least 20 of
them) went unjudged, or as soon as TypeSafe rejects the API key.

</details>

<details>
<summary><b>New-domain warm-up (optional)</b></summary>

Off by default here and on by default with `IS_CLOUD`. With it on, a sending
domain gets a daily cap by the age of its registrable domain (ICANN section of
the Public Suffix List; under a private-section suffix, such as `shop.eu.org`
from a free subdomain service, the name itself, dated by its certificates
only), counted per UTC day across every team sending from it:

| Setting | Default | Meaning |
| --- | --- | --- |
| `WARMUP_ENABLED` | `false` (`true` with `IS_CLOUD`) | Whether the warm-up applies |
| `WARMUP_CAP_FIRST_DAY` | 100 | Emails a day while the domain is under 24 hours old |
| `WARMUP_CAP_FIRST_WEEK` | 300 | Day 1 to 7, and an unknown age while the team is new or on probation |
| `WARMUP_CAP_FIRST_MONTH` | 2000 | Day 7 to 30; from day 30 only the plan applies |

The console (Trust & safety → Monitoring settings) wins over the environment.
The cap is the lower of the plan's and the warm-up's, and no plan lifts it.
A team's warming domains also share one daily limit, the highest of their
caps, counted per team and UTC day, so a second fresh domain never adds
volume. Mail over either parks as `queued_quota` (`park_reason = 'warmup'`)
and `quota.drain` releases it as both allow; `429 daily_quota_exceeded` (SMTP
`452`) with a warm-up message only when the team's parked backlog is full.
50 clean sends since the last step, the first a day old (hard bounces under
2%, complaints under 0.1%, no phishing-type monitor verdict), move a domain up
a step early, and an operator can trust a team or a domain from its review
page (audited).

The worker's `domain.age` job looks the age up off the send path, when a
domain is added or verifies and from the `domains.reverify` sweep: RDAP via
IANA's bootstrap (plus fixed servers for `.io`, `.me`, `.co` and `.us`), then
the registry's WHOIS on TCP 43, then the first certificate on crt.sh, else
unknown; a certificate's date never replaces a registry's found before. It
needs outbound HTTPS and TCP 43 while the warm-up or the content monitor's
review hold (a judge set and `MONITOR_AUTO_HOLD` on) is on, and makes no
lookup otherwise. The full description is in the docs' self-hosting
page.

</details>

<details>
<summary><b>Content access (break-glass)</b></summary>

Off by default. With it on, an authorised operator can read the subject and
the rendered visible text of specific messages of a flagged team, and what
screening read from the images and attachments of mail it held, for a
security reason they name and justify before anything is decrypted, for at
most 30 minutes. It is the break-glass path for the cases the stored
metadata cannot settle: the insights know a link points at a shortener, not
whether the text around it is a bank lure or a newsletter.

**What an operator can see.** The subject, and the rendered visible text of
the HTML with hidden elements stripped (or the plain-text part when there is
no HTML), cut at 20,000 characters and redacted on the way out: every link —
written with a scheme or as a bare `www.` host — is reduced to its scheme, its registrable domain and at most 24 characters
of path, with the query and the fragment dropped entirely, so a one-time
link cannot be followed; anything shaped like a
credential (a JWT, 32 or more hex characters, 40 or more of base64, one of
this instance's own `ms_` API keys) is masked, as is a 4-to-8-digit run
in the 40 characters after a word like *code*, *código*, *OTP*, *PIN*, *token*,
*senha*, *password* or *verification*.
Never the raw HTML, the recipient addresses, the headers, the attachment
files or the click-tracking targets, and the view offers no copy or download.
A body retention has already purged cannot be revealed by anyone.

**The media panel.** An email screening held over its images or files, and
any other held email it kept a read of, gets a **Media** action on the
review list. Under the same grant it shows why the email waits; the text
read from its images (transcribed) and attachments (extracted); the links
found in them, each with its registrable domain and that domain's age when
screening has already dated it; each file's name, type, size, pages and
flags; and up to four previews. Every one of those strings, file names
included, goes through the redaction above. The previews are small JPEGs
the worker redrew from what it read, at most 600 px a side: they reach the
page only as JPEG `data:` images, anything else is dropped, and an original
file, an SVG or HTML is never shown or served. What the panel shows is
sealed with the email and purged with its body. **Release all N with the
same media** sends every held email of the team whose images and files
screening read exactly as this one's (a blast's copies), as **Release**
does, with the same audit row.

**For how long.** A grant lasts 30 minutes from the moment it is made and is
never extended; a later look is a new grant, with a new reason and a new
audit row. Every view is counted on the grant.

**What is logged.** The grant row (`content_access_grants`) keeps the
operator, the reason, the justification they wrote, the scope, the message
ids, the view count and the times. Nothing prunes those rows: they are the
inventory of who read what. An instance audit row (`content.revealed`) is
written before anything decrypts, with the grant id, the reason and the
number of messages — never the justification's text and never any content.
A grant's first look at a media panel writes a second `content.revealed`
row, whose fields name what screening read from the images and attachments,
and stamps the grant (`media_viewed_at`).

**What the team sees, and when.** Seven days later a daily job adds a
`content.accessed` row to the team's own audit log — dated at the access,
not at the disclosure — with the reason, how many messages and which fields
were read: `subject, rendered text`, followed by
`what screening read from its images and attachments` only when the grant
opened a media panel. Nobody is emailed about an access, then or later. A
team suspended for phishing never gets the row; the grant records that the
disclosure step ran, so it is not retried nightly. A team held for review
gets it once the hold ends: after a release the next daily run writes it,
and if the hold becomes a phishing suspension it is withheld for good.

**Turning it on** in the instance's `.env`, read by the worker and the app
(a restart applies it):

```sh
CONTENT_REVEAL=on
```

Off, the console's buttons render disabled with a tooltip naming the
variable and every content procedure refuses. Reading other people's messages
is lawful only as a narrow, recorded, disclosed security measure: say so in
the instance's terms and privacy notice before turning it on.

</details>

<details>
<summary><b>Support view (optional)</b></summary>

Off by default. With `SUPPORT_VIEW=on`, the console's Teams list gains
"View as owner": the operator names a reason (support ticket, billing
dispute, other) and the ticket reference, and opens the team's dashboard as
its owner sees it, read-only, for 30 minutes. Every reason is a request the
customer made; an operator checking an abuse report works from the console's
own Trust & safety pages instead, and from the content reveal when the
message text itself is needed. No view starts on a team suspended for
phishing or held for review. The session rides on the operator's own login;
no session is ever minted for the owner.

- **What the operator sees:** the dashboard under a banner ("Support view
  of <team> · read-only · ends in mm:ss"): emails and their events (a
  clicked link shows only its origin, since its path and query can carry a
  token), contacts, domains, broadcasts, templates, API key names, webhook
  endpoints, settings and usage.
- **What stays hidden:** the content of sent mail. Email bodies (the
  detail says "Email content is hidden in support view"); the body and
  preheader of a broadcast that has started going out, is sent, or was
  canceled mid-send; every template body, since a template's text is copied
  into the broadcasts sent from it and nothing records which; API log
  request and response bodies; CSV exports (the export route answers 403);
  and every secret: API keys, webhook signing secrets and SMTP credentials
  are never returned. A draft or scheduled broadcast stays readable, since
  nothing of it has reached anyone and checking one before it goes is what
  support is asked for.
- **What is refused:** every change. A base tRPC middleware answers
  `FORBIDDEN` to every mutation while the view is live, whatever the
  screen shows; the console's own actions keep working.
- **How long:** 30 minutes, enforced on every request; one live view per
  operator. Starting another, from the console or from under a view, ends
  the live one first exactly as End session does, which is how a view left
  open in a closed tab ends. The operator ends it from the banner, the owner
  from Settings → Support access, and expiry ends it on the next request.
- **Starting one:** the dialog emails a 6-digit code to the operator's own
  address, from `AUTH_EMAIL_FROM`. It works once, for 10 minutes; five
  wrong tries void it, a new code replaces the old one, and one operator is
  sent at most five an hour. Only a hash keyed by `BETTER_AUTH_SECRET` is
  stored. A code that checks out covers that browser session's starts for
  15 minutes, so opening several views takes one code; signing out ends it.
  When the instance cannot send the code (no `AUTH_EMAIL_FROM` or no SES
  credentials) or its email fails, whether the send itself or, when a team
  holds the sender's domain, the queued email later (refused, failed,
  bounced, or held back from SES), the dialog says so and for 10 minutes a
  sign-in from the last 15 minutes stands in for the code. Either way a
  stolen long-lived session cannot open a view.
- **What is logged:** `support.view_started` and `support.view_ended` in
  the instance audit and, at once, in the team's own Settings → Audit log
  (who, the reason, the reference, how it ended, the minutes, how many
  distinct procedures were read). The grant row keeps a count per
  procedure name and never anything a procedure returned.
- **What the owner sees:** no email; the session is in the team's audit
  log at once, and the Support access card under Settings shows it while it
  is live, with an "End session" button. Both name MillionSend, never the
  operator: no name, email or user id reaches the team.

```sh
SUPPORT_VIEW=on
```

</details>

<details>
<summary><b>Error tracking (optional)</b></summary>

Off by default. With a DSN set, the web, api and worker processes report
their errors through the Sentry SDK to your Sentry project. Without one
the SDK is never loaded, on the server or in the browser. A restart applies
any change.

Create a project for the instance (and, for the dashboard's browser
errors, a second one, or reuse the first), copy its DSN, and set in the
instance's `.env`:

```sh
SENTRY_DSN=https://<key>@<host>/<project-id>
# Optional: the dashboard's browser errors, to the same or another project.
SENTRY_BROWSER_DSN=https://<key>@<host>/<project-id>
SENTRY_ENVIRONMENT=production
```

then `docker compose up -d`. By default only errors are sent (no sessions,
traces, replays, profiles or client reports). `SENTRY_TRACES_SAMPLE_RATE`
(0 to 1) also sends that share of request traces (incoming and outgoing
HTTP, browser page loads), scrubbed like the errors; trace headers are
never added to outgoing requests, so customers' webhook endpoints never see
them. A tracker run by a third party is a sub-processor: name it in the
instance's privacy notice before pointing an instance at it. One you host
yourself is not.

**What is reported.**

- web: server errors through Next.js's `onRequestError` hook, server
  component render failures included (the browser only ever sees those as
  React's minified error #441 and a digest; the event carries the same
  digest), route handlers and the proxy; tRPC procedures failing with
  `INTERNAL_SERVER_ERROR`, never an answer a procedure chose
  (`UNAUTHORIZED`, `NOT_FOUND`, `FORBIDDEN`, `BAD_REQUEST`…); with
  `SENTRY_BROWSER_DSN`, uncaught errors in the dashboard's pages and what
  its error boundary catches.
- api: every request that ends in "unhandled api error" (the 500
  `internal_server_error` answer).
- worker: every job, dead-letter or cron handler that throws, tagged with
  its queue. Each retry is an event; the tracker groups them.
- all three: unhandled rejections and uncaught exceptions. The api and the
  worker still exit on one, as before; the web process keeps serving, as
  Next.js does.

Events are tagged with `process` (web, api, worker, browser), `team_id`
where the request has one, and the route pattern, tRPC procedure or queue.
The release is the image's git revision, the `revision` the API's `/health`
reports.

**What is never sent.** Every event, breadcrumb and span passes one scrubber
(`packages/core/src/error-tracking.ts`): no request body, query string,
cookie, or header other than the user agent (`Authorization`, `x-api-key`
and `Cookie` included); no user and no IP address; no local variables; no
tRPC input or job payload. In messages, exception values, extra data,
contexts and breadcrumbs, email addresses keep only their domain
(`••••••@example.com`), `ms_` API keys are masked, and URL paths lose every
segment that could be a token or an address (an unsubscribe or invite link
carries its capability there), keeping route words and ids. Server events
name the route pattern (`/invite/[token]`), never the request's path. The
browser posts its reports to `/api/client-errors` on the dashboard's own
origin, which forwards them, so the Content-Security-Policy needs no
exception and a visitor's IP address never reaches the tracker. What no
scrubber can recognise is personal data written into free text that ends up
in an error message, such as a name in a template.

**Source maps (optional).** Browser stack traces are minified. An image
built with a `SENTRY_AUTH_TOKEN` secret uploads the dashboard's browser
source maps, matched by debug id, and deletes them from the image:

```sh
docker build --secret id=SENTRY_AUTH_TOKEN,env=SENTRY_AUTH_TOKEN \
  --build-arg SENTRY_ORG=<org-slug> \
  --build-arg SENTRY_PROJECT=<project-slug> -t millionsend .
```

For a self-hosted tracker, add `--build-arg SENTRY_URL=https://<host>/`.
Without the secret the build is unchanged, and the published image is built
without it.

</details>

<details>
<summary><b>Operations</b></summary>

- Send rate and email retention are managed in the dashboard: Settings → Instance
  (owner/admin). Defaults are 14/s and 30 days until changed there; the worker picks
  up a rate change within a minute, retention on the next purge run. (`SES_MAX_SEND_RATE`
  and `EMAIL_RETENTION_DAYS` remain honored as boot overrides if set in the
  environment, but are no longer part of the documented setup.) Whole email rows —
  recipients, subject, status, events — outlive their bodies and are deleted after
  `EMAIL_METADATA_RETENTION_DAYS` (default 30, the industry norm; daily counters and broadcast results are kept regardless); webhook delivery rows (payload,
  response, attempts) stay readable for `WEBHOOK_DELIVERY_RETENTION_DAYS` (default
  30) and are then purged. A tracking-pixel fetch within `OPEN_PREFETCH_WINDOW_SECONDS`
  of delivery (default 10; 0 keeps only the user-agent rules) is recorded as
  prefetched, not opened, so open rates count people.
  Deleting a contact tombstones its address across email history, event payloads and
  API logs; only the suppression hash is kept.
- Worker sizing: `SEND_CONCURRENCY` (default 16) is the number of parallel send
  lanes — about 1.2 per message/second of SES rate; `SQS_POLL_CONCURRENCY` (default
  4) is the number of parallel SQS long-poll loops. The SES rate limiter is a
  per-process token bucket, so N workers would send at N × the configured rate:
  when running more than one worker, set `WORKER_REPLICAS` (default 1) to that
  count and each process divides the rate by it.
- Postgres runs with `max_connections=200` in the compose files; each process
  (api, worker, web) holds a pool of up to 24 connections, so separate containers
  and worker replicas fit without tuning.
- To run processes in separate containers, set `PROCESS` to `api`, `worker`, or `web`
  per container (default `all`). Upgrade them in the same `up -d`: the Metrics chart
  counts only what upgraded processes write, so a writer left on an older image during
  the swap is missing from that day's chart (the daily usage figures are unaffected).
- Email bodies are encrypted at rest with `MASTER_ENCRYPTION_KEY` and purged after
  the retention window. Back up the key with the database.
- Webhook endpoints must be public `https://` hosts; loopback and private
  addresses are refused, test fires included. For local development set
  `WEBHOOK_ALLOW_LOCALHOST=true` to allow `http://` and loopback/private
  targets on any port. Keep it `false` on any internet-reachable instance.

</details>

<details>
<summary><b>Maintainers</b></summary>

The Settings → SES quick-create link loads the CloudFormation template from the
`millionsend-public` S3 bucket. After changing `infra/millionsend-ses.cfn.yaml`,
re-upload it:

```sh
aws s3 cp infra/millionsend-ses.cfn.yaml s3://millionsend-public/millionsend-ses.cfn.yaml
```

</details>
