# Self-hosting MillionSend

MillionSend sends through your own AWS SES account. Two containers: Postgres and one
app container running the api (port 3001), worker, and web dashboard (port 3000).

## Prerequisites

1. Docker with Compose.
2. An AWS account with SES access in your chosen region. Sandbox accounts can only send
   to verified recipient addresses; request production access to send to anyone.
3. A sending domain you control. Domain verification (DKIM records) is done from the
   dashboard after boot — you do not need to pre-verify it in the SES console.

## Quickstart

1. Clone and configure:

   ```sh
   git clone https://github.com/MillionSend/millionsend.git
   cd millionsend
   cp .env.example .env
   ```

2. Generate the two secrets in `.env` (everything else defaults to a working local setup; set `APP_BASE_URL` when deploying to a real host — sign-in is only accepted from that origin):

   - `DATABASE_URL` — the default works with the bundled Postgres; leave it.
   - `MASTER_ENCRYPTION_KEY` — `openssl rand -base64 32`
   - `BETTER_AUTH_SECRET` — `openssl rand -base64 32`
   - `APP_BASE_URL` — the URL you open the dashboard at. The default
     `http://localhost:3000` works for a local compose setup; set your real
     `https://` URL when exposing it, or sign-in is rejected as an untrusted
     origin.

   Add `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (or rely on the default AWS
   credential chain). Sandbox SES accounts must keep `SES_MAX_SEND_RATE=1`.

3. Start:

   ```sh
   docker compose up --build -d
   ```

   Migrations run automatically on boot. Dashboard: http://localhost:3000.
   API: http://localhost:3001.

## One-command AWS setup

Three ways to create everything MillionSend needs in AWS (IAM policy + user +
access key, SNS event topic, SES configuration set) without clicking through
the console:

- **Setup CLI (recommended)** — interactive, idempotent, and it runs wherever
  your AWS admin credentials live; the MillionSend server never needs them.

  ```sh
  # On your own machine (repo clone; admin credentials via profile or env):
  pnpm install && pnpm setup:aws

  # Or on the server, inside the container:
  docker compose run --rm millionsend setup
  ```

  It verifies your AWS identity, shows the plan, prompts for region and
  `APP_BASE_URL`, creates everything, and always prints the exact `.env`
  lines — copy-paste them to the server when MillionSend runs elsewhere. If a
  `.env` exists where the CLI runs, it offers to update it in place.
  `--dry-run` prints the plan and exits. Re-running is safe, but each run
  mints a new access key — delete stale ones in the IAM console.
  `pnpm setup:aws teardown` deletes everything the setup created (including
  all access keys of the `millionsend` user, so a running server stops
  sending).

- **CloudFormation quick-create** — the Settings → SES page links straight to
  the CloudFormation console review page with a hosted copy of the template.
  Or deploy it from a terminal:

  ```sh
  aws cloudformation deploy --template-file infra/millionsend-ses.cfn.yaml \
    --stack-name millionsend --capabilities CAPABILITY_NAMED_IAM \
    --parameter-overrides AppBaseUrl=https://your-host
  aws cloudformation describe-stacks --stack-name millionsend \
    --query "Stacks[0].Outputs" --output table
  ```

  The outputs map 1:1 to `.env` keys. Omit `AppBaseUrl` to skip the event
  subscription.

- **Setup script** — the dashboard's Settings → SES page also generates a
  shell script pre-filled with your region and `APP_BASE_URL`. Paste it into a
  terminal where the aws CLI has admin credentials.

Either way, finish by pasting the values into `.env` and restarting. The SNS
subscription confirms itself once the app runs with `SNS_TOPIC_ARNS` set; if it
stays pending, use "Request confirmation" on it in the SNS console.

### Maintainers: hosted quick-create template

The quick-create console link loads the template from the `millionsend-public`
S3 bucket. After changing `infra/millionsend-ses.cfn.yaml`, re-upload it:

```sh
aws s3 cp infra/millionsend-ses.cfn.yaml \
  s3://millionsend-public/millionsend-ses.cfn.yaml
```

## Signup policy

The first user to register becomes the initial account — no configuration needed.
After that, registration is closed: anyone with an account can create API keys that
send through your SES account, so signup stays off unless you opt in with
`ALLOW_SIGNUP=true`. Keep port 3000 off the public internet unless you have opened
signup deliberately.

## SES event ingestion (bounces, complaints, deliveries)

Without this, sends work but you get no delivery events and no automatic suppression
of bounced addresses. Requires a publicly reachable `APP_BASE_URL` (HTTPS).

1. In SNS (same region as SES), create a standard topic, e.g. `millionsend-events`.
2. Put the topic ARN in `.env` as `SNS_TOPIC_ARNS` and restart
   (`docker compose up --build -d`).
3. Subscribe the topic to `https://<your-host>/ses/events`, protocol HTTPS. The
   endpoint confirms the subscription automatically when the topic ARN matches
   `SNS_TOPIC_ARNS`.
4. In SES, create a configuration set (e.g. `millionsend`) with an event destination
   pointing at the topic. Enable these event types: Send, Delivery, Delivery Delay,
   Bounce, Complaint, Open, Click, Reject, Rendering Failure.
5. Put the configuration set name in `.env` as `SES_CONFIGURATION_SET` and restart.
   It is applied to every send that has no per-domain configuration set; without it,
   sends go out without a configuration set and emit no events.

## Local development without Docker

Requires Node 24+, pnpm 11, and a local Postgres.

1. `pnpm install`
2. Create `.env` as above with `DATABASE_URL` pointing at your Postgres.
3. `pnpm --filter @millionsend/db db:migrate`
4. Run each process in its own terminal:

   ```sh
   pnpm --filter @millionsend/api dev
   pnpm --filter @millionsend/worker dev
   pnpm --filter @millionsend/web dev
   ```

## Operational notes

- One worker container only: the SES rate limiter is in-memory, so N worker replicas
  send at N × `SES_MAX_SEND_RATE`. Scale the worker vertically, or divide the rate by
  the replica count.
- To run processes in separate containers, set `PROCESS` to `api`, `worker`, or `web`
  per container (default `all`).
- Email bodies are encrypted at rest with `MASTER_ENCRYPTION_KEY` and purged after
  `EMAIL_RETENTION_DAYS`. Back up the key with the database.
