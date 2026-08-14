# Self-hosting MillionSend

MillionSend sends through your own AWS SES account. Two containers: Postgres and one
app container running the api (port 3001), worker, and web dashboard (port 3000).

Prerequisites: Docker with Compose; an AWS account with SES access in your chosen
region (sandbox accounts can only send to verified recipients — request production
access to send to anyone); a sending domain you control. Domain verification (DKIM
records) is done from the dashboard after boot.

<details open>
<summary><b>Quickstart (no clone)</b></summary>

Runs the prebuilt image `ghcr.io/millionsend/millionsend:edge` (multi-arch, published
on every push to main). Pin a version tag in the compose file for production; `:edge`
is a moving head.

```sh
mkdir millionsend && cd millionsend
curl -O https://raw.githubusercontent.com/MillionSend/millionsend/main/deploy/docker-compose.yml
curl -o .env https://raw.githubusercontent.com/MillionSend/millionsend/main/.env.example
```

In `.env` (everything else defaults to a working local setup):

- `MASTER_ENCRYPTION_KEY` and `BETTER_AUTH_SECRET` — `openssl rand -base64 32` each.
- `APP_BASE_URL` — the URL you open the dashboard at. The default
  `http://localhost:3000` works locally; set your real `https://` URL when exposing
  it, or sign-in is rejected as an untrusted origin.
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

One command creates everything MillionSend needs in AWS — IAM policy + user + access
key, and, with an https `APP_BASE_URL`, the SNS event topic and SES configuration set:

```sh
npx @millionsend/setup
```

Run it anywhere Node 18+ and your AWS admin credentials live — laptop or server; the
MillionSend server never needs admin credentials. It verifies your AWS identity,
shows the plan, prompts for region and `APP_BASE_URL`, creates everything, and prints
the exact `.env` lines to paste where MillionSend runs (if a `.env` exists where it
runs, it offers to update it in place). `--dry-run` prints the plan and exits.
`teardown` deletes everything the setup created, including all access keys of the
`millionsend` user, so a running server stops sending. Re-running is safe, but each
run mints a new access key — delete stale ones in the IAM console.
(`@millionsend/setup` is the self-host setup tool; `@millionsend/cli` stays reserved
for a future end-user CLI that talks to the MillionSend API.)

No Node on the server? The same CLI ships inside the image:
`docker run --rm -it --user root -v ~/.aws:/root/.aws ghcr.io/millionsend/millionsend:edge setup`.

Prefer not to run a CLI? The dashboard's Settings → SES page offers a CloudFormation
quick-create link and a pre-filled shell script that create the same resources.

</details>

<details>
<summary><b>SES events (bounces, complaints, deliveries)</b></summary>

The setup CLI configures this when `APP_BASE_URL` is a public https URL. Without it,
sends work but you get no delivery events and no automatic suppression of bounced
addresses.

Manual equivalent: an SNS standard topic (same region as SES) subscribed to
`https://<your-host>/ses/events`, its ARN in `.env` as `SNS_TOPIC_ARNS`; an SES
configuration set with an event destination pointing at the topic (event types: Send,
Delivery, Delivery Delay, Bounce, Complaint, Open, Click, Reject, Rendering Failure),
its name in `.env` as `SES_CONFIGURATION_SET`. Restart after setting both. Without
`SES_CONFIGURATION_SET`, sends go out without a configuration set and emit no events.

The SNS subscription confirms itself once the app runs with `SNS_TOPIC_ARNS` set; if
it stays pending, use "Request confirmation" on it in the SNS console.

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
<summary><b>Operations</b></summary>

- Send rate and email retention are managed in the dashboard: Settings → Instance
  (owner/admin). The env vars `SES_MAX_SEND_RATE` and `EMAIL_RETENTION_DAYS` are the
  boot defaults; a value saved in the dashboard overrides them (the worker picks up a
  rate change within a minute, retention on the next purge run).
- One worker container only: the SES rate limiter is in-memory, so N worker replicas
  send at N × the configured send rate. Scale the worker vertically, or divide the
  rate by the replica count.
- To run processes in separate containers, set `PROCESS` to `api`, `worker`, or `web`
  per container (default `all`).
- Email bodies are encrypted at rest with `MASTER_ENCRYPTION_KEY` and purged after
  the retention window. Back up the key with the database.

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
