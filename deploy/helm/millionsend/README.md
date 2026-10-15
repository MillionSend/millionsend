# MillionSend Helm chart

Runs self-hosted MillionSend on any Kubernetes cluster (k3s, EKS, GKE, AKS, ...).
It deploys the same image as the compose files, with one Deployment per process
instead of one supervised container:

| Component | `PROCESS` | Port | Default |
|---|---|---|---|
| `web` (dashboard) | `web` | 3000 | on |
| `api` | `api` | 3001 | on |
| `worker` (sends, SES events, crons) | `worker` | — | on |
| `smtp` (relay) | `smtp` | 2587 | off, needs a TLS Secret |
| `docs` | `docs` | 3002 | off |
| `backup` (CronJob, pg_dump → S3) | — | — | off |

Postgres is **not** part of the chart. Bring Postgres 17 (CloudNativePG, RDS,
Cloud SQL, ...) with `max_connections` of at least 200: each app process pools
up to 24 connections. Also set `max_parallel_workers_per_gather = 0`, as the
compose file does.

Every variable from [`.env.example`](../../../.env.example) works here: put
non-secret values under `config` (a ConfigMap) and secret values in the Secret
(see below). Both reach every pod through `envFrom`.

## Install

```sh
helm upgrade --install millionsend deploy/helm/millionsend \
  -n millionsend --create-namespace -f my-values.yaml
```

Starting points:

- [`examples/values-k3s.yaml`](examples/values-k3s.yaml): Traefik, CloudNativePG,
  a Secret created out of band (for example from a SealedSecret), and AWS access
  through an OIDC web identity role instead of access keys.
- [`examples/values-eks.yaml`](examples/values-eks.yaml): AWS Load Balancer
  Controller, RDS, External Secrets Operator with AWS Secrets Manager, and IRSA.

## Secrets

`secrets.mode` decides where the Secret comes from. Every mode produces one
Secret that all pods load.

| Mode | Use it when | Secret name |
|---|---|---|
| `existingSecret` (default) | You create the Secret yourself: `kubectl`, SealedSecrets, SOPS, Vault Agent, ... | `secrets.existingSecret.name` |
| `externalSecret` | [External Secrets Operator](https://external-secrets.io) is installed | the release fullname |
| `create` | Local tests only: values are stored in the Helm release | the release fullname |

Required keys: `DATABASE_URL`, `MASTER_ENCRYPTION_KEY`, `BETTER_AUTH_SECRET`.
Also add `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`, unless the pods get AWS
credentials some other way (see IRSA below). Add `S3_ACCESS_KEY_ID`,
`S3_SECRET_ACCESS_KEY` and `S3_ENDPOINT` when you use uploads or backups.

```sh
kubectl -n millionsend create secret generic millionsend-secrets \
  --from-literal=DATABASE_URL='postgres://millionsend:...@db-rw.postgres.svc:5432/millionsend' \
  --from-literal=MASTER_ENCRYPTION_KEY="$(openssl rand -base64 32)" \
  --from-literal=BETTER_AUTH_SECRET="$(openssl rand -base64 32)" \
  --from-literal=AWS_ACCESS_KEY_ID=... --from-literal=AWS_SECRET_ACCESS_KEY=... \
  --dry-run=client -o yaml   # pipe to kubeseal for a SealedSecret, or drop this line to apply
```

Pods read the Secret at start, so after changing it run
`kubectl rollout restart deployment -l app.kubernetes.io/instance=<release>`.

Back up `MASTER_ENCRYPTION_KEY`. Without it, the stored email bodies cannot be
read.

## AWS credentials without static keys

If the Secret has no `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`, every AWS
client in the app (SES sending, GetAccount, SQS polling, quotas) uses the AWS
SDK default provider chain. That chain picks up a web identity token, so the
pods can assume an IAM role and never hold a long-lived key. In both setups
below, give the role the `millionsend-ses` permissions
(`infra/millionsend-ses.cfn.yaml`).

### Any cluster (k3s, kubeadm, ...): `aws.webIdentity`

The chart mounts a projected ServiceAccount token (audience `sts.amazonaws.com`)
into web, api, worker and smtp, and sets these variables:

- `AWS_ROLE_ARN`
- `AWS_WEB_IDENTITY_TOKEN_FILE`
- `AWS_ROLE_SESSION_NAME` (the pod name, so CloudTrail shows which pod made each call)
- `AWS_DEFAULT_CHAIN=true`

The SDK then exchanges the token with `sts:AssumeRoleWithWebIdentity` and
renews it on its own.

```yaml
aws:
  webIdentity:
    enabled: true
    roleArn: arn:aws:iam::123456789012:role/millionsend
serviceAccount:
  name: millionsend   # fixed, so the trust policy can name it
```

You need these outside the chart:

- **A public issuer.** The cluster's service-account issuer must be published at
  an HTTPS URL that AWS can reach, serving `/.well-known/openid-configuration`
  and the JWKS. On k3s, set it with
  `--kube-apiserver-arg=service-account-issuer=<url>`.
- **An IAM OIDC provider** for that issuer, with audience `sts.amazonaws.com`.
- **A role that trusts only this ServiceAccount**, with the condition
  `<issuer>:sub = system:serviceaccount:<namespace>:millionsend` and
  `<issuer>:aud = sts.amazonaws.com`.

Do not put AWS keys in the Secret. Explicit keys take precedence over the role,
and the chart refuses keys only where it can see them (`config` and
`secrets.create`).

### EKS: IRSA or Pod Identity

On EKS the webhook injects the token and the variables for you, so leave
`aws.webIdentity` off. Then either annotate the ServiceAccount
(`serviceAccount.annotations."eks.amazonaws.com/role-arn"`) or create a Pod
Identity association. Also set `config.AWS_DEFAULT_CHAIN: "true"`. Without it,
account mail (password resets, email verification) stays off when there are no
static keys.

## Worker replicas

`worker.replicas` is also written to `WORKER_REPLICAS`. Each worker takes 1/N of
the SES send rate. So scale the worker only through the chart: an HPA or
`kubectl scale` would leave `WORKER_REPLICAS` out of date and push the account
over its quota. The worker uses the `Recreate` strategy for the same reason,
because during a rolling update old and new workers would overlap. `web` and
`api` are stateless and can be scaled freely.

## Migrations

Every app pod runs pending migrations at boot. A Postgres advisory lock
serializes concurrent boots, so plain `helm upgrade` is enough. The startup
probe allows 10 minutes, so a long migration is not killed partway through.

You can also set `migrations.job.enabled: true` to run `migrate` as a
`pre-install,pre-upgrade` hook (ArgoCD treats it as PreSync). Then a failing
migration stops the upgrade and the old pods keep serving, which is the
Kubernetes version of the `docker compose run --rm --no-deps millionsend migrate`
step in SELF_HOSTING.md. The hook runs before the chart's own resources, so it
needs `secrets.mode: existingSecret` with a Secret that already exists. With
ArgoCD, a SealedSecret in the same Application is only created after PreSync,
so the first sync fails: manage the SealedSecret in its own Application that
syncs first.

## Ingress and client IPs

`ingress.hosts[].paths[].component` routes each path to `web`, `api` or `docs`.
Set `ingress.className` for your controller (`traefik`, `alb`, `nginx`, ...).
`APP_BASE_URL` (and `PUBLIC_API_URL` if you use it) must match the public hosts
exactly.

Set `config.TRUSTED_PROXIES` to the addresses your ingress connects from: the
pod CIDR for in-cluster controllers (k3s default `10.42.0.0/16`; a custom
`--cluster-cidr` changes it, so check the nodes' `spec.podCIDR`) or the VPC CIDR
for an ALB. CIDRs are accepted. If you leave it out, every visitor is recorded
with the proxy's IP.

## SMTP relay

The relay will not start without a STARTTLS keypair. Create a
`kubernetes.io/tls` Secret (for example with a cert-manager `Certificate` for
the relay hostname) and set `smtp.enabled: true` and `smtp.tlsSecretName`. It is
mounted at `/certs` and the `SMTP_TLS_*` variables are set for you. SMTP is not
HTTP, so expose it with `smtp.service.type: LoadBalancer` (optionally limited by
`loadBalancerSourceRanges`) or a TCP route on your ingress controller.

## Backups

`backup.enabled: true` runs a CronJob with `ghcr.io/millionsend/backup`. It
dumps, uploads to S3-compatible storage, verifies the upload and prunes, once
per run. It needs `config.S3_BACKUP_BUCKET` and the S3 credentials. Skip it if
your database already backs itself up (CloudNativePG `ScheduledBackup`, RDS
snapshots). Restores follow SELF_HOSTING.md.

## Security defaults

The pods run with the same hardening as the compose files:

- non-root uid 999 (the image's `millionsend` user)
- read-only root filesystem, with `emptyDir` on the paths compose mounts as tmpfs
- all capabilities dropped and no privilege escalation
- `RuntimeDefault` seccomp
- no ServiceAccount token mounted

The grace period is 45 s, longer than the worker's 30 s drain. These defaults
pass the `restricted` Pod Security Standard.
