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
  documentation site), `smtp` (the relay; mount a keypair first), `backup`
  (scheduled dumps).
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
`ses:*Tenant*` actions behind `SES_TENANTS` (one SES tenant per team); a
deployment set up before those existed re-runs the wizard, or updates the
`millionsend-ses` policy, before enabling the flag. An https `APP_BASE_URL`
additionally gets events pushed to your host; the queue works without any public
URL.

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
<summary><b>Signup policy</b></summary>

The first user to register becomes the initial account — no configuration needed.
After that, registration is closed: anyone with an account can create API keys that
send through your SES account, so signup stays off unless you opt in with
`ALLOW_SIGNUP=true`. Keep port 3000 off the public internet unless you have opened
signup deliberately.

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
`millionsend_system`. Password-reset, verification, invitation and subscription-confirm
emails lose their body once SES accepts them, since the link inside is a live credential;
the other notices keep theirs for the usual retention window. Until a team holds the
domain they go straight through SES and leave no trace.

That team is the instance's own, and an operator can mark it as such: on the `system` plan
it is never capped or billed and its badge reads System. On a self-hosted instance plans
carry no limits, so the mark only labels the team.

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

    # POST /emails/batch takes up to 100 emails per request; html/text bodies
    # carry no schema byte cap, but SES rejects messages over 10 MB anyway.
    # 25m covers a full batch of large bodies without unbounded uploads.
    client_max_body_size 25m;

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
outside; everything else closed:

```sh
sudo ufw default deny incoming
sudo ufw allow 80,443/tcp
sudo ufw allow 2587/tcp   # only if the SMTP relay is exposed
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
(default `0 3 * * *`, UTC). Only the daily form `<minute> <hour> * * *` is
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
  authenticate but every send answers `403 team_suspended` (SMTP `550`),
  broadcasts in flight park, webhooks keep delivering and data stays; a
  broadcast pause parks broadcasts while transactional mail flows; a daily
  ceiling caps the team's UTC day under its plan. Owners are emailed about
  each of these (never for a phishing suspension), and every action is
  recorded in the audit log with its reason.

</details>

<details>
<summary><b>Content monitoring (optional)</b></summary>

Off by default. With a judge configured, a sample of accepted mail is
scored 0–100 by TypeSafe Jev after SES has taken it and folded into a
per-team risk the operator sees on Trust & safety.
Nothing on the send path waits for it: a verdict never delays, holds or
refuses a message, and a judge failure of any kind (feature off, missing
credentials, throttling, timeout, upstream error, unparseable answer, body
already purged by retention) records the sample as unjudged and changes
nothing else. The deterministic content checks (`email_insights`, the
guardrail, the account score) run on every send whether or not the judge is
on. Self-hosters can leave it off; the cloud runs it.

**What it does and does not do.** It opens the `monitor` flag on Trust &
safety when a team's risk crosses the flag line, emails the operator once a
day per team past the alert line, and, for a team in the New tier only
(inside its first 1,000 sends or 72 hours, or under 10,000 sends within 7
days), pauses broadcasts when the risk passes the pause line and a sampled
message scored 90 or more within a day (transactional mail keeps flowing;
the team sees "paused pending review"; the operator resumes from the review
page). It never suspends a team and never holds transactional mail: a
person decides. The pause policy is a setting and can be switched off.

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
MillionSend: the team's name, verified domains, days since its first send
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
address or header, never the raw HTML, never an attachment's content. The
stored record of a judged sample is the score, verdict, categories, reason
codes, language, model version, latency and error class; the review page
shows those and never a subject or a body. Sample rows are metadata and are
pruned after 90 days.

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
| `MONITOR_ANOMALY_MULTIPLIER` | 20 | One failing link-domain, shortener or phishing-pattern check multiplies the rate; two force the sample |
| `MONITOR_TEAM_DAILY_CAP` | 600 | Judged messages per team per UTC day; past it sampling stops silently |
| `MONITOR_INSTANCE_DAILY_CAP` | 50000 | Instance-wide; past it tier sampling stops, first sends and anomalies continue |
| `MONITOR_FLAG_RISK` | 0.5 | The team gets the `monitor` flag and samples four times as much |
| `MONITOR_ALERT_RISK` | 0.7 | The operator is emailed, once per team per day |
| `MONITOR_PAUSE_RISK` | 0.85 | New teams only: broadcasts pause, with a verdict of 90 or more in the last day |
| `MONITOR_AUTO_PAUSE` | true | Whether the pause policy applies |
| `MONITOR_FLAG_SCORE` | 70 | A sample counts as flagged in the console from this score |

The risk is a decayed mean of the verdicts (half-life 7 days) with a prior
that starts new teams higher; the review page shows it beside the tier,
the last samples and the judge's answer next to each flagged email, and
offers "Sample everything for 7 days". The Overview's Monitoring card
charts the hourly sample count, and the operator is emailed, at most once
every six hours, when more than 20% of an hour's samples (at least 20 of
them) went unjudged, or as soon as TypeSafe rejects the API key.

</details>

<details>
<summary><b>Content access (break-glass)</b></summary>

Off by default. With it on, an authorised operator can read the subject and
the rendered visible text of specific messages of a flagged team, for a
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
Never the raw HTML, the recipient addresses, the headers, the attachments or
the click-tracking targets, and the view offers no copy or download. A body
retention has already purged cannot be revealed by anyone.

**For how long.** A grant lasts 30 minutes from the moment it is made and is
never extended; a later look is a new grant, with a new reason and a new
audit row. Every view is counted on the grant.

**What is logged.** The grant row (`content_access_grants`) keeps the
operator, the reason, the justification they wrote, the scope, the message
ids, the view count and the times. Nothing prunes those rows: they are the
inventory of who read what. An instance audit row (`content.revealed`) is
written before anything decrypts, with the grant id, the reason and the
number of messages — never the justification's text and never any content.

**What the team sees, and when.** Seven days later a daily job adds a
`content.accessed` row to the team's own audit log — dated at the access,
not at the disclosure — and emails the team's owners in their own language:
when it happened, the reason, how many messages, and what was withheld. The
one exception is a team suspended for phishing since the grant, where the
row and the notice are withheld; the grant records that the disclosure step
ran either way, so it is not retried nightly.

**Turning it on** in the instance's `.env`, read by the worker and the app
(a restart applies it):

```sh
CONTENT_REVEAL=on
```

Off, the console's buttons render disabled with a tooltip naming the
variable and both procedures refuse. Reading other people's messages is
lawful only as a narrow, recorded, disclosed security measure: say so in the
instance's terms and privacy notice before turning it on.

</details>

<details>
<summary><b>Support view (optional)</b></summary>

Off by default. With `SUPPORT_VIEW=on`, the console's Teams list gains
"View as owner": the operator names a reason (support ticket, billing
dispute, other) and the ticket reference, and opens the team's dashboard as
its owner sees it, read-only, for 30 minutes. Every reason is a request the
customer made; an operator checking an abuse report works from the console's
own Trust & safety pages instead, and from the content reveal when the
message text itself is needed. The session rides on the operator's own
login; no session is ever minted for the owner.

- **What the operator sees:** the dashboard under a banner ("Support view
  of <team> · read-only · ends in mm:ss"): emails and their events,
  contacts, domains, broadcasts, templates, API key names, webhook
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
  operator, starting another ends the previous, and a view cannot start
  another. The operator ends it from the banner, the owner from Settings →
  Support access, and expiry ends it on the next request.
- **What is logged:** `support.view_started` and `support.view_ended` in
  the instance audit and, at once, in the team's own Settings → Audit log
  (who, the reason, the reference, how it ended, the minutes, how many
  distinct procedures were read). The grant row keeps a count per
  procedure name and never anything a procedure returned.
- **What the owner receives:** an email when the session starts (who, why,
  the reference, until when, and where to end it), and the Support access
  card while it is live.

```sh
SUPPORT_VIEW=on
```

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
