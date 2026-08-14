# @millionsend/setup

The self-hosting setup wizard for
[MillionSend](https://github.com/MillionSend/millionsend). One command in an
empty directory takes you from nothing to a running instance. Deliberately not
named `@millionsend/cli` — that name stays reserved for a future end-user CLI
that talks to the MillionSend API.

```sh
npx @millionsend/setup            # the wizard
npx @millionsend/setup --dry-run  # print the full plan, touch nothing
npx @millionsend/setup teardown   # delete the AWS resources it created
```

## What it does

The wizard detects what is already in the current directory (`.env`, a compose
file, docker) and offers only the missing pieces — every step is skippable,
and re-running is safe:

1. **env** — creates `.env` from a built-in template (no repo clone needed),
   or keeps your existing one and only fills gaps. Offers to generate
   `MASTER_ENCRYPTION_KEY` and `BETTER_AUTH_SECRET` for you, and prompts once
   for `APP_BASE_URL`.
2. **AWS** — IAM policy + `millionsend` user + access key (least-privilege
   sending); with an https `APP_BASE_URL`, also the SNS event topic and SES
   configuration set so bounces, complaints, and deliveries flow back into
   your instance. Keys are written into the same `.env`.
3. **launch** — downloads the standalone `docker-compose.yml` if the
   directory has none, then runs `docker compose up -d` (`--build` when your
   compose file builds from source).

In a terminal every choice is interactive (arrow-key lists, Enter accepts the
default). Piped input still works deterministically — answers one per line;
on EOF every offer defaults to "skip", so scripted runs never create anything
by surprise.

Run it anywhere Node 18+ lives; the AWS step wants your admin AWS credentials
(laptop or server — the MillionSend server itself never needs admin
credentials) and offers `aws login`/`aws sso login`/`aws configure` when the
credential check fails on a machine with the aws CLI. Each AWS run mints a
new access key — delete stale ones in the IAM console.

Full self-hosting guide:
[SELF_HOSTING.md](https://github.com/MillionSend/millionsend/blob/main/SELF_HOSTING.md).
