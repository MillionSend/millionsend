# Migrate this project from Resend to MillionSend

You are migrating an application from Resend to MillionSend. MillionSend's REST API is wire-compatible with Resend's — same endpoints, same request and response shapes — so this is a configuration change plus one account-data move, not a rewrite. Work through the steps in order. Stop and ask before anything irreversible. Never print, log, or commit an API key.

## Facts you can rely on

- Cloud API base URL: `https://api.millionsend.com`. Self-hosted: the instance's own API origin (ask if it is not in the repo).
- API keys start with `ms_` and are created in the dashboard under **API keys**. Use a full-access key for the migration and sending-access keys for production senders.
- Documentation: https://docs.millionsend.com — append `.md` to any page URL for markdown, `/llms-full.txt` is everything in one file, `/openapi.json` is the OpenAPI 3.1 spec. The migration guide is https://docs.millionsend.com/migrate-from-resend.md and the CLI reference is https://docs.millionsend.com/cli.md.
- The migration CLI (`@millionsend/cli`) only ever reads from Resend (`GET` requests), keeps keys in memory, writes them to no file, and sends no telemetry.
- Ids differ between providers: contacts are matched by email, everything else by name, key, alias or endpoint. The CLI's report carries an id map for topics and segments.

## Step 1 — Inventory this codebase

Find every Resend touchpoint before changing anything, and show the user the list:

- SDK packages: `resend` (Node), `resend` (Python), `resend-go`, `resend-php`, `resend-ruby`, `resend-java`, `resend-dotnet`, `resend-elixir`.
- Environment variables: `RESEND_API_KEY`, `RESEND_BASE_URL`, and any hardcoded `https://api.resend.com`.
- Webhook receivers that verify `svix-*` signature headers, and the endpoint URLs registered at Resend.
- Audience, segment, topic and template ids or aliases referenced in code or config.
- Broadcast or template bodies using `{{{RESEND_UNSUBSCRIBE_URL}}}` (it keeps working on MillionSend as an alias of `{{{UNSUBSCRIBE_URL}}}`).

## Step 2 — Move the account

Ask the user for a full-access Resend key, a full-access MillionSend key, and whether the target is Cloud or a self-hosted URL. Pass keys through environment variables, never as command-line arguments.

Plan first (read-only; exit code 2 means there are changes, 0 nothing to do, 1 an error):

```sh
export RESEND_API_KEY=re_...
export MILLIONSEND_API_KEY=ms_...
export MILLIONSEND_BASE_URL=https://api.millionsend.com   # or the instance's URL

npx @millionsend/cli migrate plan --from resend --out plan.json
```

Show the user the plan summary, including any plan-limit warnings (for example "7 domains to create; the Free plan allows 3"), and wait for approval. Then apply:

```sh
npx @millionsend/cli migrate apply plan.json --yes
```

Flags worth knowing: `--rps <n>` lowers the read rate against Resend (default 8, Resend allows 10 per team shared with production sending); `--skip enrichment` skips the second per-contact pass for properties and topics; `--include-sent` also imports sent broadcasts as drafts; `--fresh-webhook-secrets` mints new webhook secrets instead of copying them; `--on-conflict skip|error` changes how existing contacts are treated (default upsert).

Afterwards read `.millionsend/migrate-report.md`: counts per resource, the checklist of manual items, the DNS records per domain, and the id map. The tool adds `.millionsend/` to `.gitignore` when one exists; confirm it did.

## Step 3 — Point the code at MillionSend

Choose one of the two, with the user:

1. **Keep the Resend SDK.** Official Resend SDKs honor a base URL. Set, in every environment that sends:
   ```sh
   RESEND_API_KEY=ms_...
   RESEND_BASE_URL=https://api.millionsend.com
   ```
   Confirm the installed SDK version reads `RESEND_BASE_URL` (or its base URL constructor option) and replace any hardcoded `https://api.resend.com`.
2. **Switch to the MillionSend SDK** for the language (npm `millionsend`, PyPI `millionsend`, Go `github.com/millionsend/millionsend-go`, Packagist `millionsend/millionsend`, RubyGems `millionsend`, Maven `com.millionsend:millionsend`, NuGet `MillionSend`, Hex `millionsend`). Each mirrors the Resend SDK's surface: swap the import and class name, pass the base URL through its option (`baseUrl`, `base_url`, `BaseURL`, ...). Details per language: https://docs.millionsend.com/sdks.md.
   PHP: `MillionSend::client()` returns a `Client` that keeps its `HttpClient` private. For a request the SDK has no method for, construct `HttpClient` yourself with the same arguments the factory passes (read `MillionSend::client()` in the package): same package, same behavior, one level lower.

Then fix what the report lists:

- Update topic and segment ids in code and config using the report's id map.
- Templates: MillionSend templates do not store `from` or `reply_to`; pass them on each send.
- Webhooks: endpoint, events and signing secret were copied, so the existing receiver keeps verifying the `svix-*` headers. Event types outside MillionSend's seven `email.*` types were dropped per webhook and are listed; remove or replace handlers for them.
- API keys cannot be migrated (Resend exposes their names only). Create one per name the report lists, in the dashboard, and place them in the matching environments.

## Step 4 — DNS, done by the user

MillionSend uses its own DKIM keypair, so every domain needs new DNS records even if it already sends through Resend. The records are in the report and under **Domains** in the dashboard. Both providers can stay verified side by side. Do not switch traffic until each domain reads **Verified**.

## Step 5 — Cut over and verify

1. Re-run `migrate plan` and `migrate apply` right before switching traffic: runs are diffs, so contacts that arrived in between come across and nothing is duplicated.
2. Deploy the environment changes from step 3.
3. Send one email through the new base URL and confirm it reaches **Delivered** on the Emails page; confirm a webhook delivery arrives at the receiver.
4. Keep the Resend account untouched until the user is confident. If something must be undone on the MillionSend side, `npx @millionsend/cli migrate rollback` deletes only what the tool created, after listing it and asking.

## Rules

- Resend is read-only for the entire migration: never create, change or delete anything there.
- Keys go through environment variables or stdin, never into files, logs, arguments, or commits.
- Ask before applying the plan, before touching production environment variables, and before any DNS change.
- Finish with a summary: what changed in the repo, what moved in the account, and the exact items the user still has to do.
