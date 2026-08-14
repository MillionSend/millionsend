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
