# Tracking edge

Serves teams' branded tracking hosts (`links.customer.com`) over HTTPS when the
app's own host cannot hold a certificate for each of them: on MillionSend Cloud,
whose app sits behind Cloudflare, and on a self-hosted instance behind
Cloudflare or behind a proxy that only issues certificates for names listed in
advance. [Branded tracking hosts](https://docs.millionsend.com/self-hosting#branded-tracking-hosts)
in the self-hosting guide covers when you need it and the alternatives.

It is one **Caddy** container with on-demand TLS. It terminates TLS for each
tracking host, issuing a Let's Encrypt certificate on the first request, and
reverse-proxies `/t/c` and `/t/o` back to the app. It stores no database: the
app verifies the tracking token and issues the redirect.

```
recipient clicks a tracked link
  → links.customer.com             the team's CNAME
  → t.millionsend-dns.com          this box's A record, DNS only (grey cloud)
  → this box                       Caddy, on-demand TLS
  → /t/c or /t/o proxied to app.millionsend.com (through Cloudflare)
  → the app verifies the token, records the event and returns a 302
```

Before minting a certificate for a hostname, Caddy asks the app
(`/internal/tracking-host-allowed`) whether it is the tracking host of a domain
that has verified, so a stranger pointing DNS here cannot burn Let's Encrypt's
issuance limits, and a claim on a name nobody proved gets no certificate.

The steps use MillionSend Cloud's values; [Self-hosting](#self-hosting) lists
what changes for your own instance.

## Setup

### 1. Launch the box

- **EC2 `t4g.micro`** (Arm, 1 GiB), **Ubuntu Server 24.04 LTS (arm64)**, in the
  region nearest the app (`us-east-1`). Any small VPS with a public IPv4 works.
- Attach an **Elastic IP** so the address is stable.
- Security group: **80 and 443 from `0.0.0.0/0`** (80 is required for the ACME
  HTTP-01 challenge and the HTTP→HTTPS redirect), **22 from your IP only**.

### 2. DNS

In the Cloudflare zone **`millionsend-dns.com`** (a domain of its own, so a
tracking host on a blocklist never touches `millionsend.com`):

| Type | Name | Content            | Proxy status        |
| ---- | ---- | ------------------ | ------------------- |
| A    | `t`  | the Elastic IP     | **DNS only (grey)** |

It must be grey: proxied, Cloudflare would terminate TLS for the teams'
hostnames, which needs Cloudflare for SaaS, the thing this box replaces. Teams
then point a CNAME such as `links` at `t.millionsend-dns.com`; the dashboard
shows each team that record with its status.

### 3. Docker

```bash
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2
sudo usermod -aG docker "$USER" && newgrp docker
```

### 4. Files and `.env`

```bash
sudo install -d -o "$USER" -g "$USER" /opt/millionsend-tracking-edge
cd /opt/millionsend-tracking-edge
base=https://raw.githubusercontent.com/MillionSend/millionsend/main/deploy/tracking-edge
curl -fsSL --remote-name-all "$base/Caddyfile" "$base/docker-compose.yml"
curl -fsSL "$base/.env.example" -o .env
chmod 600 .env
nano .env
```

Keep this directory: Compose names the certificate volume after it
(`millionsend-tracking-edge_caddy_data`), and under a new name the box starts
with no certificates and reissues one for every tracking host.

`.env` on MillionSend Cloud:

```bash
ACME_EMAIL=<the address Let's Encrypt writes to about expiry>
ORIGIN=https://app.millionsend.com
ORIGIN_HOST=app.millionsend.com
ASK_URL=https://app.millionsend.com/internal/tracking-host-allowed?token=<the app's TRACKING_ASK_SECRET>
EDGE_HOST=t.millionsend-dns.com
EDGE_REDIRECT=https://millionsend.com
```

### 5. Start

```bash
docker compose up -d
docker compose logs -f    # each tracking host's certificate issues on its first click
```

### 6. App side

In the app's `.env`, then `docker compose up -d` there:

```bash
TRACKING_EDGE_HOST=t.millionsend-dns.com
TRACKING_ASK_SECRET=<the token in ASK_URL>       # openssl rand -hex 32
TRUSTED_PROXIES=<what it lists now>,<the box's Elastic IP>
```

With these set, a team's tracking CNAME targets the edge, and Caddy's `ask`
check succeeds for the tracking host of each domain that has verified.

`TRUSTED_PROXIES` must list this box: its requests reach the app through
Cloudflare, which names the box as its peer, so without the entry every open
and click records the box's address as the recipient's. Caddy puts the real
client in `X-Forwarded-For` and Cloudflare appends the box to it; declaring the
box lets the app walk past it to the client.

## Checks

```bash
# The ask gate (replace the secret): a verified domain's tracking host returns
# 200, others 404.
curl -s -o /dev/null -w '%{http_code}\n' \
  "https://app.millionsend.com/internal/tracking-host-allowed?token=SECRET&domain=links.SOMECUSTOMER.com"

# Once a team's domain has verified and its CNAME is live, the first HTTPS hit
# issues its certificate:
curl -sI "https://links.SOMECUSTOMER.com/t/o/anything"   # 200 + a fresh cert

# The edge's own hostname bounces to the site:
curl -sI "https://t.millionsend-dns.com"                 # 302 → EDGE_REDIRECT
```

## Upgrades

```bash
cd /opt/millionsend-tracking-edge
base=https://raw.githubusercontent.com/MillionSend/millionsend/main/deploy/tracking-edge
curl -fsSL --remote-name-all "$base/Caddyfile" "$base/docker-compose.yml"
docker compose up -d && docker compose restart caddy
```

The restart is what applies a Caddyfile change: `up -d` leaves the running
container alone when only the Caddyfile changed. Certificates persist in the
volume across both. `.env` stays as it is unless a release note asks for a new
value.

## Operations and security

- **What the box holds:** Caddy's Let's Encrypt account key, the issued
  certificates, and the ask token in `.env`, which only answers whether a
  hostname is a tracking host. It never sees `MASTER_ENCRYPTION_KEY`, the
  database or API keys. A compromise of this box reaches no customer data;
  worst case it serves redirects.
- **Certificates persist** in the `caddy_data` volume. Do not delete it, or
  certificates reissue and you risk Let's Encrypt's rate limits.
- **Exposed IP.** Because the DNS record is grey, the box sits outside
  Cloudflare's WAF and DDoS shield. That is acceptable for a stateless redirect
  edge: a flood degrades tracking links but touches nothing sensitive.
  Optional hardening: build Caddy with the `caddy-ratelimit` module (via
  `xcaddy`) and add a `rate_limit` directive.
- **Monitor** `docker compose logs` for repeated `ask` denials or issuance
  failures. Renewals are automatic while the box stays reachable.
- **Reboots:** Docker starts on boot and the container restarts itself
  (`restart: unless-stopped`).

## Self-hosting

The same box serves a self-hosted instance. What changes:

- **`.env`:** `ORIGIN`, `ORIGIN_HOST` and the host in `ASK_URL` are your
  `APP_BASE_URL`'s host; `EDGE_HOST` is the edge's own hostname, an A record
  that is DNS only; `EDGE_REDIRECT` is any page you like.
- **App side:** the same three settings, with your edge's hostname and
  address. If Cloudflare is in front of the app, `TRUSTED_PROXIES` keeps its
  ranges too.
- **Where it runs:** any box with a public IPv4 and ports 80 and 443 free. When
  nothing else listens on them, as with an app behind a Cloudflare Tunnel, that
  can be the app's own box.
