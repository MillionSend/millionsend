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
and safe to re-run; `--dry-run` prints the full plan and touches nothing.

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
- `PUBLIC_API_URL` — only behind a reverse proxy that serves the API on its own
  hostname (the nginx section below); otherwise the API is assumed at port 3001
  of the dashboard host.
- `COMPOSE_PROFILES` — optional services, comma-separated: `docs` (the
  documentation site), `smtp` (the relay; mount a keypair first), `backup`
  (scheduled dumps).
- `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` — from the AWS setup below, or rely
  on the default AWS credential chain. Sandbox SES accounts must keep
  `SES_MAX_SEND_RATE=1`.

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

Migrations run on boot, so that is the whole upgrade. The compose file runs
`ghcr.io/millionsend/millionsend:latest`, the latest tagged release (`:1.2.3`
and `:1.2` tags exist alongside it; `:edge` follows `main`, where every build
passed the test suite first). To hold a version, set `MILLIONSEND_IMAGE`
in `.env` to a version tag or an immutable digest
(`ghcr.io/millionsend/millionsend@sha256:…`; `docker image ls --digests` shows
what is running) and `docker compose up -d`. The previous pin put back is the
rollback — with the caveat that schema migrations run forward only, so take a
dump before a big jump (Backups below); a rolled-back image may not start on a
newer schema.

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
AWS — IAM policy + user + access key, the SNS event topic, and the SES
configuration set. With an https `APP_BASE_URL` events are pushed to your host;
otherwise setup adds an SQS queue the worker long-polls, so events work without
any public URL.

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
<summary><b>SES events (bounces, complaints, deliveries)</b></summary>

The setup CLI always configures this. A public https `APP_BASE_URL` gets an SNS
subscription pushing to your host; any other `APP_BASE_URL` gets an SQS queue
(`millionsend-events`) that the worker long-polls — its URL lands in `.env` as
`SQS_QUEUE_URL`. Either way `SNS_TOPIC_ARNS` gates ingestion: events are only
accepted from topics on that allowlist.

Manual equivalent: an SNS standard topic (same region as SES) subscribed to
`https://<your-host>/ses/events` (or to an SQS queue whose policy lets the topic
send and whose URL is in `.env` as `SQS_QUEUE_URL`), its ARN in `.env` as
`SNS_TOPIC_ARNS`; an SES configuration set with an event destination pointing at
the topic (event types: Delivery, Delivery Delay, Bounce, Complaint, Reject,
Rendering Failure), its name in `.env` as `SES_CONFIGURATION_SET`. Do NOT
subscribe Open or Click: that makes SES rewrite every link and inject its own
pixel, while MillionSend tracks engagement itself. Restart after setting them. Without `SES_CONFIGURATION_SET`, sends go out without
a configuration set and emit no events.

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
<summary><b>Operations</b></summary>

- Send rate and email retention are managed in the dashboard: Settings → Instance
  (owner/admin). Defaults are 14/s and 30 days until changed there; the worker picks
  up a rate change within a minute, retention on the next purge run. (`SES_MAX_SEND_RATE`
  and `EMAIL_RETENTION_DAYS` remain honored as boot overrides if set in the
  environment, but are no longer part of the documented setup.) Whole email rows —
  recipients, subject, status, events — and webhook delivery records outlive their
  bodies and are deleted after `EMAIL_METADATA_RETENTION_DAYS` (default 365).
  Deleting a contact tombstones its address across email history, event payloads and
  API logs; only the suppression hash is kept.
- One worker container only: the SES rate limiter is in-memory, so N worker replicas
  send at N × the configured send rate. Scale the worker vertically, or divide the
  rate by the replica count.
- To run processes in separate containers, set `PROCESS` to `api`, `worker`, or `web`
  per container (default `all`).
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
