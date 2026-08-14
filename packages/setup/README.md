# @millionsend/setup

The self-hosting setup tool: provisions the AWS resources a
[MillionSend](https://github.com/MillionSend/millionsend) instance sends
through. Deliberately not named `@millionsend/cli` — that name stays reserved
for a future end-user CLI that talks to the MillionSend API.

## What it creates

- IAM policy + `millionsend` user + access key (least-privilege sending)
- With an https `APP_BASE_URL`: an SNS event topic and SES configuration set,
  so bounces, complaints, and deliveries flow back into your instance

## Usage

```sh
npx @millionsend/setup            # interactive setup
npx @millionsend/setup --dry-run  # print the plan, touch nothing
npx @millionsend/setup teardown   # delete everything it created
```

Run it anywhere Node 18+ and your AWS admin credentials live — laptop or
server; the MillionSend server never needs admin credentials. It verifies your
AWS identity, shows the plan, creates everything, and prints the `.env` lines
to paste where MillionSend runs. Re-running is safe, but each run mints a new
access key — delete stale ones in the IAM console.

Full self-hosting guide:
[SELF_HOSTING.md](https://github.com/MillionSend/millionsend/blob/main/SELF_HOSTING.md).
