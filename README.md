<p align="center">
  <img src="apps/web/public/logo/millionsend-banner.svg" alt="MillionSend" width="560">
</p>

<p align="center"><b>The open-source email platform. Send one. Send a million.</b></p>

Self-host on your own AWS SES, or use the hosted cloud. Resend-compatible API — migrating
means changing two environment variables, not rewriting your integration.

## Status

Early development — the monorepo is taking shape in the open (pnpm + Turborepo; Drizzle
schema and typed environment config first, product surfaces next). Watch this repo or join
the [Discussions](https://github.com/orgs/MillionSend/discussions) to follow along.

## Features

| Feature | Status | Notes |
| --- | --- | --- |
| Emails API (Resend-compatible) | ✅ | Send, batch, get, cancel — same request/response shapes as Resend. |
| Idempotency | ✅ | `Idempotency-Key` header dedupes retried sends. |
| API keys | ✅ | Create and revoke `ms_` keys from the dashboard, with last-used tracking. |
| Suppression list | ✅ | Hard bounces and complaints suppressed automatically; review and remove per address. |
| Metrics | ✅ | Daily sends with bounce and complaint rates tracked against SES thresholds. |
| Webhooks (Standard Webhooks) | ✅ | Signed event deliveries with per-endpoint event selection and a delivery log. |
| Domains + BYODKIM | ✅ | Guided DNS verification; bring your own DKIM key or let SES manage it. |
| Contacts | ✅ | Team-wide contacts with subscribe state, segments, topics, and CSV import. |
| One-click unsubscribe (RFC 8058) | ✅ | `List-Unsubscribe` headers plus a hosted unsubscribe page. |
| Broadcasts | ✅ | Compose, schedule, and send to all contacts, a segment, or a topic; cancel while scheduled. |
| Templates + merge fields | ✅ | Reusable templates with per-contact merge fields. |
| API request logs | ✅ | Every API request recorded with request/response bodies, secrets redacted. |
| SMTP relay | ✅ | Drop-in SMTP on port 2587; authenticate with an API key. |
| Dashboard (en/pt-BR) | ✅ | Full dashboard in English and Brazilian Portuguese. |
| Self-host (Docker) | ✅ | Compose file plus a setup wizard; sends through your own AWS SES. |

## Run it locally

One command, in an empty directory — no clone needed:

```sh
npx @millionsend/setup
```

The wizard creates `.env` (secrets generated for you), optionally provisions
the AWS resources (IAM user, SNS event topic, SES configuration set), and
starts the prebuilt image with `docker compose up -d`. Every step is offered,
skippable, and safe to re-run. Prefer doing it by hand? The manual curl path
and everything else — from-source build, SES/SNS event pipeline, Docker-less
development — is in [SELF_HOSTING.md](SELF_HOSTING.md).

Dashboard at http://localhost:3000, API at http://localhost:3001.

## License

Code is licensed under [AGPL-3.0](LICENSE). SDKs ship separately under MIT
(npm/PyPI package: `millionsend`).

The MillionSend name, wordmark, and logos are trademarks of the MillionSend project and are
not licensed under the AGPL.
