# Tracking edge

Serves teams' branded tracking hosts (`links.example.org`) over HTTPS when the
app's own host cannot hold a certificate for each of them: behind Cloudflare's
proxy or a Cloudflare Tunnel, or behind a proxy that only issues certificates
for names listed in advance. [Branded tracking hosts](https://docs.millionsend.com/self-hosting#branded-tracking-hosts)
in the self-hosting guide covers when you need it and the alternatives.

It is one **Caddy** container with on-demand TLS. It terminates TLS for each
tracking host, issuing a Let's Encrypt certificate on the first request, and
reverse-proxies `/t/c` and `/t/o` back to the app. It stores no database: the
app verifies the tracking token and issues the redirect.

```
recipient clicks a tracked link
  → links.example.org              the team's CNAME
  → track.example-dns.com          this box's A record (DNS only on Cloudflare)
  → this box                       Caddy, on-demand TLS
  → /t/c or /t/o proxied to the app (mail.example.com)
  → the app verifies the token, records the event and returns a 302
```

Before minting a certificate for a hostname, Caddy asks the app
(`/internal/tracking-host-allowed`) whether it is the tracking host of a domain
that has verified, so a stranger pointing DNS here cannot burn Let's Encrypt's
issuance limits, and a claim on a name nobody proved gets no certificate.

## Setup

### 1. The box

Any small VPS or cloud instance with a public IPv4 (1 GiB of memory is plenty),
and a stable address. Inbound: **80 and 443 from anywhere** (80 carries the
ACME HTTP-01 challenge and the HTTP→HTTPS redirect) and SSH from your own IP
only. When nothing else listens on 80 and 443, as with an app behind a
Cloudflare Tunnel, the app's own box works too.

### 2. DNS

An A record for the edge's own hostname, the CNAME target teams point their
tracking subdomains at:

| Type | Name                    | Content          | Proxy status (Cloudflare) |
| ---- | ----------------------- | ---------------- | ------------------------- |
| A    | `track.example-dns.com` | the box's IPv4   | **DNS only (grey)**       |

On Cloudflare it must be grey: proxied, Cloudflare would terminate TLS for the
teams' hostnames, which needs Cloudflare for SaaS, the thing this box replaces.
A domain of its own keeps a tracking host on a blocklist away from your main
domain.

### 3. Docker

On Ubuntu:

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

`.env.example` explains each value: the app's URL (`ORIGIN`, `ORIGIN_HOST` and
the host in `ASK_URL` are your `APP_BASE_URL`'s host), the app's
`TRACKING_ASK_SECRET` as the token in `ASK_URL`, the edge's own hostname as
`EDGE_HOST`, and the page a direct visit to it lands on as `EDGE_REDIRECT`.

Keep the directory: Compose names the certificate volume after it
(`millionsend-tracking-edge_caddy_data` here), and under a new name the box
starts with no certificates and reissues one for every tracking host.

### 5. Start

```bash
docker compose up -d
docker compose logs -f    # each tracking host's certificate issues on its first click
```

### 6. App side

In the app's `.env`, then restart the app:

```bash
TRACKING_EDGE_HOST=track.example-dns.com
TRACKING_ASK_SECRET=<the token in ASK_URL>       # openssl rand -hex 32
TRUSTED_PROXIES=<what it lists now>,<the box's IPv4>
```

With these set, a team's tracking CNAME targets the edge, and the `ask` check
succeeds for the tracking host of each domain that has verified.

`TRUSTED_PROXIES` must list the box: every open and click reaches the app
through it, and left out, each one records the box's address as the
recipient's. Caddy puts the real client in `X-Forwarded-For` and each proxy
after it appends its peer; declaring the box lets the app walk past it to the
client. If Cloudflare is in front of the app, its ranges stay in the list too.

## Checks

```bash
# The ask gate (replace the secret): a verified domain's tracking host returns
# 200, others 404.
curl -s -o /dev/null -w '%{http_code}\n' \
  "https://mail.example.com/internal/tracking-host-allowed?token=SECRET&domain=links.example.org"

# Once the team's domain has verified and its CNAME is live, the first HTTPS
# request issues the host's certificate:
curl -sI "https://links.example.org/t/o/anything"

# The edge's own hostname redirects:
curl -sI "https://track.example-dns.com"         # 302 → EDGE_REDIRECT
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
  hostname is a tracking host. It never sees the app's encryption key, its
  database or API keys; a compromised box can serve redirects and nothing
  more.
- **Certificates persist** in the `caddy_data` volume. Deleting it reissues
  every certificate and risks Let's Encrypt's rate limits.
- **No CDN in front.** The grey record means the box gets none of Cloudflare's
  proxy protection. To rate-limit, build Caddy with the `caddy-ratelimit`
  module (via `xcaddy`) and add a `rate_limit` directive.
- **Monitor** `docker compose logs` for repeated `ask` denials or issuance
  failures. Renewals are automatic while the box stays reachable.
- **Reboots:** Docker starts on boot and the container restarts itself
  (`restart: unless-stopped`).
