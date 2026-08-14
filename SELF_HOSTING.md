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

2. Fill the three required values in `.env`:

   - `DATABASE_URL` — the default works with the bundled Postgres; leave it.
   - `MASTER_ENCRYPTION_KEY` — `openssl rand -base64 32`
   - `BETTER_AUTH_SECRET` — `openssl rand -base64 32`

   Add `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (or rely on the default AWS
   credential chain). Sandbox SES accounts must keep `SES_MAX_SEND_RATE=1`.

3. Start:

   ```sh
   docker compose up -d
   ```

   Migrations run automatically on boot. Dashboard: http://localhost:3000.
   API: http://localhost:3001.

## SES event ingestion (bounces, complaints, deliveries)

Without this, sends work but you get no delivery events and no automatic suppression
of bounced addresses. Requires a publicly reachable `APP_BASE_URL` (HTTPS).

1. In SNS (same region as SES), create a standard topic, e.g. `millionsend-events`.
2. Put the topic ARN in `.env` as `SNS_TOPIC_ARNS` and restart
   (`docker compose up -d`).
3. Subscribe the topic to `https://<your-host>/ses/events`, protocol HTTPS. The
   endpoint confirms the subscription automatically when the topic ARN matches
   `SNS_TOPIC_ARNS`.
4. In SES, create a configuration set (e.g. `millionsend`) with an event destination
   pointing at the topic. Enable these event types: Send, Delivery, Bounce, Complaint,
   Reject, Rendering Failure, Delivery Delay.

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
