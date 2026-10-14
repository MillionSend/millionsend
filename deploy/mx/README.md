# Inbound MX box (MillionSend Cloud)

The mail server that receives for every receiving-enabled domain on MillionSend
Cloud, and for the shared inbox domain and its teams' subdomains:
`mx.millionsend-dns.com`, a small EC2 instance in `us-east-1`. It runs
the app's own image as `PROCESS=mx` and holds no database. Per recipient it asks
the API whether the domain receives here, and it hands every message to the
API before it answers `250`. The only secret on the box is `MX_INGEST_SECRET`,
plus the TLS keypair.

```
sender's mail server
  → mx.millionsend-dns.com:25       A record, DNS only (grey cloud)
  → this box, container port 2525   PROCESS=mx
      RCPT TO  → POST https://api.millionsend.com/internal/mx/rcpt     accept or 550/452
      DATA     → POST https://api.millionsend.com/internal/mx/deliver  stored → 250
      app down → 451, the sender retries for days
```

Part 1 prepares the box (once). Part 2 runs the MX and connects it to the app.

## Part 1: launch and prepare the box

### 1. Launch the instance

EC2 console, region **us-east-1** → Launch instance:

- **Name:** `millionsend-mx`
- **AMI:** Ubuntu Server 24.04 LTS, 64-bit (Arm)
- **Instance type:** `t4g.small` (2 GiB). The MX keeps at most 512 MiB of
  message data in memory (`MX_MAX_BUFFERED_MB`); past that, senders get
  `452` and retry.
- **Key pair:** yours
- **Network:** default VPC, auto-assign public IP on (step 2 replaces it)
- **Security group** `millionsend-mx`, inbound rules:

  | Type | Port | Source      | Why                                                  |
  | ---- | ---- | ----------- | ---------------------------------------------------- |
  | SMTP | 25   | `0.0.0.0/0` | mail from the internet                               |
  | HTTP | 80   | `0.0.0.0/0` | Let's Encrypt validation; only certbot listens there |
  | SSH  | 22   | My IP       | administration                                       |

  Keep the default outbound rule: the box needs 443 (the API, Let's Encrypt)
  and DNS.
- **Storage:** 20 GiB gp3 (the image is about 2 GB, and an upgrade keeps the
  previous one until pruned)

Skip AWS's port-25 request form and reverse DNS: AWS throttles only outbound
port 25, and this box never sends mail.

### 2. Elastic IP

EC2 → Elastic IPs → Allocate Elastic IP address → Actions → Associate → the
`millionsend-mx` instance.

### 3. DNS

In the Cloudflare zone **millionsend-dns.com**:

| Type | Name | Content            | Proxy status       |
| ---- | ---- | ------------------ | ------------------ |
| A    | `mx` | the Elastic IP     | **DNS only (grey)** |

It must be grey: Cloudflare proxies HTTP, not SMTP. Add no AAAA record (the
MX listens on IPv4 only). Wait until it resolves:

```bash
dig +short mx.millionsend-dns.com    # prints the Elastic IP
```

### 4. Docker, certbot and swaks

SSH in as `ubuntu`:

```bash
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2 certbot swaks
sudo usermod -aG docker "$USER" && newgrp docker
```

### 5. Working directory and certificate

The image runs as a non-root user. The certificate's deploy hook copies the
keypair into `/opt/millionsend-mx/tls`, owned `root:1000` with mode 0640, and
the compose file adds the container's user to group 1000 (`group_add`), so it
can read the key without the key being world-readable.

```bash
sudo install -d -o "$USER" -g "$USER" /opt/millionsend-mx
sudo install -d -m 0750 -o root -g 1000 /opt/millionsend-mx/tls
sudo certbot certonly --standalone -d mx.millionsend-dns.com \
  --non-interactive --agree-tos -m you@example.com --deploy-hook \
  'install -m 0640 -o root -g 1000 "$RENEWED_LINEAGE/fullchain.pem" "$RENEWED_LINEAGE/privkey.pem" /opt/millionsend-mx/tls/'
ls -l /opt/millionsend-mx/tls
```

Replace `you@example.com` with the address Let's Encrypt should write to about
expiry. `ls` should list `fullchain.pem` and `privkey.pem` as
`-rw-r----- root 1000`.

Renewal needs nothing more: Ubuntu's `certbot.timer` runs twice a day, certbot
reruns the saved hook after each renewal, and the MX loads the new files within
five minutes, without a restart. Keep port 80 open for it;
`sudo certbot renew --dry-run` checks the path.

## Part 2: run the MX

### 6. Compose file and `.env`

```bash
cd /opt/millionsend-mx
curl -fsSLO https://raw.githubusercontent.com/MillionSend/millionsend/main/deploy/mx/docker-compose.yml
openssl rand -hex 32    # the MX_INGEST_SECRET, unless the app already has one
nano .env
chmod 600 .env
```

`.env`, exactly these four lines:

```bash
MILLIONSEND_TAG=0.8.0
MX_HOSTNAME=mx.millionsend-dns.com
MX_INGEST_URL=https://api.millionsend.com/internal/mx
MX_INGEST_SECRET=<the same value as MX_INGEST_SECRET in the app's .env>
```

- `MILLIONSEND_TAG`: the release the app runs (the line above is an example),
  since both sides ship the MX ↔ app contract. `edge` follows `main`, for
  testing ahead of a release.
- `MX_HOSTNAME`: the greeting name. It is the A record above and the app's
  `RECEIVING_MX_HOST`.
- `MX_INGEST_URL`: the API's public origin plus `/internal/mx`. The API is
  served at `https://api.millionsend.com`: the Cloud server in the OpenAPI
  document (`apps/api/src/app.ts`), the default base URL of the CLI
  (`packages/cli/src/meta.ts`) and the SDKs, and the host the docs give for
  every call. The internal MX routes belong to the API process
  (`MX_INGEST_PATH` in `packages/core/src/receiving/protocol.ts`), not to
  `app.millionsend.com`, which serves the dashboard. The box calls the API
  through that public hostname like any other client.
- `MX_INGEST_SECRET`: the bearer secret, at least 32 characters, identical on
  both sides.

The compose file sets the keypair paths. The limits keep their defaults unless
added here: `MX_MAX_CLIENTS` (200), `MX_MAX_CONNECTIONS_PER_IP` (10),
`MX_CONNECTIONS_PER_IP_PER_MINUTE` (60), `MX_MAX_RECIPIENTS` (50, at most
100), `MX_SOCKET_TIMEOUT_MS` (300000), `MX_SESSION_TIMEOUT_MS` (600000) and
`MX_MAX_BUFFERED_MB` (512).

### 7. App side

In the app's `.env` on the VPS, then `docker compose up -d` there:

```bash
RECEIVING_MX_HOST=mx.millionsend-dns.com
MX_INGEST_SECRET=<the same value>
```

The app refuses to boot with only one of the two, or with a secret under 32
characters. Until both are set, `/internal/mx` answers 404 and the MX answers
`451` to every recipient, so senders keep retrying and nothing bounces.

If a reverse proxy in front of the API limits request bodies, it must allow
41m on `/internal/mx/`: messages run up to 40 MiB (the nginx example in
`SELF_HOSTING.md` sets 60m for the whole API). Cloudflare accepts 100 MB
request bodies on every plan.

### 8. Start

```bash
docker compose pull
docker compose up -d
docker compose logs -f mx
```

Expected:

```
mx-1  | [mx] {"event":"tls_loaded","subject":"CN=mx.millionsend-dns.com","expires":"..."}
mx-1  | [mx] {"event":"listening","port":2525,"hostname":"mx.millionsend-dns.com"}
```

`tls_unavailable` with `EACCES` means the keypair is not `root:1000` 0640, or the
container lacks `group_add`; with `ENOENT`, the hook has not run (step 5).

### 9. Checks

From the box. First, the app answers the MX:

```bash
set -a; . ./.env; set +a
curl -sS -X POST "$MX_INGEST_URL/rcpt" \
  -H "authorization: Bearer $MX_INGEST_SECRET" -H 'content-type: application/json' \
  -d '{"recipient":"probe@example.com","mailFrom":"","clientIp":"192.0.2.1","helo":"probe.example"}'
```

Expected: `{"accept":false,"code":550,"enhanced":"5.1.1",...}` (example.com
does not receive here). A 404 means the app runs without `RECEIVING_MX_HOST`
or on a release without receiving; an authorization error means the two
secrets differ.

STARTTLS with the real certificate:

```bash
openssl s_client -starttls smtp -connect 127.0.0.1:25 \
  -servername mx.millionsend-dns.com -verify_hostname mx.millionsend-dns.com -brief </dev/null
```

Expected: `Protocol version: TLSv1.3`, `Peer certificate: CN=mx.millionsend-dns.com`
and `Verification: OK`. From outside AWS, any SMTP test tool pointed at
`mx.millionsend-dns.com:25` should show the same.

No AUTH and no relay:

```bash
swaks --server 127.0.0.1:25 --quit-after EHLO
swaks --server 127.0.0.1:25 --from probe@example.com --to someone@gmail.com --quit-after RCPT
```

The first lists `STARTTLS` and `SIZE 41943040` but no `AUTH`. The second ends
with `550 5.1.1 Recipient domain does not receive mail here`.

### 10. End-to-end test with real mail

1. In the dashboard, add a subdomain such as `inbound-test.example.com` to a
   team and verify it, turn on **Receiving** and **Catch-all** (or create an
   inbox on it and send to that address below), and add the MX record it
   shows: name `inbound-test`, mail server `mx.millionsend-dns.com`,
   priority 10. A subdomain keeps the parent domain's mailboxes untouched.
2. Wait for the record's live check to pass (`dig +short MX inbound-test.example.com`
   prints `10 mx.millionsend-dns.com.`).
3. From an ordinary mailbox (Gmail, Outlook), send a message with an
   attachment to any address at the subdomain.
4. `docker compose logs mx` shows `"event":"delivered"` with
   `"to_domains":["inbound-test.example.com"]` and the SPF, DKIM and DMARC
   verdicts (`pass` from Gmail).
5. The message appears under Inboxes → All received, and `email.received`
   webhooks fire.

When it does not arrive: `rcpt_refused` with code 550 means receiving is off
for that exact domain, or the address has no inbox and catch-all is off;
`rcpt_failed` or `deliver_failed` means the API did not answer as expected
(the line carries the error or HTTP status). The sender keeps retrying in both
of the latter cases, so the message arrives once the cause is fixed.

## Upgrades

Upgrade the app first, then this box. A release can add to what the MX sends
the app: the unfolded authentication results (`authDetail`), for one, that
sender trust is built from. An older app ignores them and a newer app accepts
mail without them, so neither order loses mail; app first means they are
stored from the box's first message on.

Once the app runs the new release, set `MILLIONSEND_TAG` in `.env` to it,
then:

```bash
cd /opt/millionsend-mx
docker compose pull && docker compose up -d && docker image prune -f
```

During the few seconds of restart, senders find the port closed and retry;
nothing is lost.

## Shared inbox domain

Teams' shared-domain inboxes (`SHARED_INBOX_DOMAIN` in the app's `.env`)
receive here too: one wildcard MX record covers every team's subdomain, and
an MX record on the domain itself takes its `postmaster@` and `abuse@`. The
domain is its own registrable domain, never under `millionsend.com` or
`millionsend-dns.com`: the cloud app refuses to boot with one there. Agent
mail, and abuse of it, then never touches the platform's own reputation.

1. **DNS**, in the shared domain's zone (`<shared>` below stands for it):

   | Type | Name | Content |
   | ---- | ---- | ------- |
   | MX | `<shared>` | `mx.millionsend-dns.com`, priority 10 |
   | MX | `*.<shared>` | `mx.millionsend-dns.com`, priority 10 |
   | TXT | `_dmarc.<shared>` | `v=DMARC1; p=reject` |

2. **SES identity**: verify `<shared>` as a domain identity with Easy DKIM in
   the app's default region (the first of `AWS_REGIONS`) and publish its
   three DKIM CNAME records in the same zone. Shared addresses send with no
   team domain, from that region and its default configuration set, under
   the sending team's SES tenant once the app's `SHARED_INBOX_TENANTS`
   setting is on.
3. **App**: set `SHARED_INBOX_DOMAIN=<shared>` in the app's `.env`, then
   `docker compose up -d` there. Nothing changes on this box. Mail to
   `postmaster@` and `abuse@` at `<shared>`, or at any team's subdomain,
   goes to the oldest team on the System plan, and is refused with
   `550 5.1.1` while there is none.
4. **Checks**: `dig +short MX <shared>` and `dig +short MX test.<shared>`
   both print `10 mx.millionsend-dns.com.`. Create an inbox on the shared
   domain, leaving the username empty, send it a message from Gmail, then
   reply from the inbox: Gmail's "Show original" should read
   `DKIM: 'PASS' with domain <shared>` and
   `DMARC: 'PASS'`. SES documents sending from any subdomain of a verified
   domain identity, but not which key signs it, so this check is what proves
   the signature.

## Operations

- **Logs** are one JSON object per line: `listening`, `tls_loaded`,
  `tls_unavailable`, `rcpt_refused`, `rcpt_failed`, `delivered`,
  `deliver_refused`, `deliver_failed`, `message_refused`,
  `connection_refused`, `auth_timeout`. They carry envelope facts (domains,
  sizes, verdicts) and outcomes, never message content, and Docker's `local`
  driver rotates them.
- **Refusals the MX makes itself:**
  - `rcpt_refused` with reason `recipient_limit` is a 452 past
    `MX_MAX_RECIPIENTS`; the sender retries the rest in another transaction.
  - `message_refused` with reason `size` is a 552 for a message over 40 MiB.
  - `message_refused` with reason `memory` is a 452: the messages in flight
    together passed `MX_MAX_BUFFERED_MB`. A steady stream of these means the
    box needs more memory or a lower `MX_MAX_CLIENTS`.
  - A sender that declares a size over 40 MiB in `MAIL FROM` is refused
    before it sends anything, and that leaves no log line.
- **What the box holds:** the TLS keypair and `MX_INGEST_SECRET`. The secret
  lets its holder submit mail to the app as if received, so rotate it on both
  sides if the box is ever compromised. Nothing here reads stored mail.
- **What it never does:** AUTH, relaying, or sending any mail (bounces
  included). Refusals happen during the SMTP session, and a message over 40 MiB
  is refused while it streams.
- **Reboots:** Docker starts on boot and the service restarts itself
  (`restart: unless-stopped`).
