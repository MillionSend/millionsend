# MillionSend

**The open-source email platform. Send one. Send a million.**

Self-host on your own AWS SES, or use the hosted cloud. Resend-compatible API — migrating
means changing two environment variables, not rewriting your integration.

## Status

Early development — the monorepo is taking shape in the open (pnpm + Turborepo; Drizzle
schema and typed environment config first, product surfaces next). Watch this repo or join
the [Discussions](https://github.com/orgs/MillionSend/discussions) to follow along.

## Run it locally

```sh
git clone https://github.com/MillionSend/millionsend.git
cd millionsend
cp .env.example .env   # fill the 3 required values (generation hints inside)
docker compose up -d
```

Dashboard at http://localhost:3000, API at http://localhost:3001. Full setup —
including the SES/SNS event pipeline and Docker-less development — is in
[SELF_HOSTING.md](SELF_HOSTING.md).

## License

Code is licensed under [AGPL-3.0](LICENSE). SDKs ship separately under MIT
(npm/PyPI package: `millionsend`).

The MillionSend name, wordmark, and logos are trademarks of the MillionSend project and are
not licensed under the AGPL.
