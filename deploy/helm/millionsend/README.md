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
(see below). Every pod loads the ConfigMap through `envFrom`, and every pod but
docs the Secret too. Leave out the variables the chart sets itself:
`WORKER_REPLICAS` (from `worker.replicas`) and, with `smtp.enabled`,
`SMTP_PORT`, `SMTP_PUBLIC_HOST` and `SMTP_TLS_*` (from `smtp.*`). The few
variables that only exist for compose are listed
[at the end](#compose-only-variables).

## Install

```sh
helm upgrade --install millionsend deploy/helm/millionsend \
  -n millionsend --create-namespace -f my-values.yaml
```

The image tag defaults to the chart's `appVersion`, a pinned release. Upgrade by
upgrading the chart, or set `image.tag` (or `image.digest`) to hold another
version. Never point it at `latest` or `edge`: a pod that restarts (OOM,
eviction, node drain) would pull a newer build than its neighbours and run that
build's migrations against the shared database, and `helm rollback` could not
move the version back.

`helm rollback` brings back the previous image, not the previous schema:
migrations only run forward, so the older version would run against the newer
schema. Take a dump before a big version jump (see [Backups](#backups)):
restoring it along with the rollback is the way back. With the backup CronJob
on, this takes one now (`<fullname>`, here and below, is the name prefix of the
chart's resources; `kubectl -n <namespace> get deploy` shows it):

```sh
kubectl -n <namespace> create job --from=cronjob/<fullname>-backup pre-upgrade-dump
```

Starting points:

- [`examples/values-k3s.yaml`](examples/values-k3s.yaml): Traefik, CloudNativePG,
  a Secret created out of band (for example from a SealedSecret), and AWS access
  through an OIDC web identity role instead of access keys.
- [`examples/values-eks.yaml`](examples/values-eks.yaml): AWS Load Balancer
  Controller, RDS, External Secrets Operator with AWS Secrets Manager, and IRSA.

### What has been verified

- k3s with the `restricted` Pod Security Standard, Postgres 17 and every
  component on: fresh install, a failing migrate hook keeping the old pods up,
  the worker's `Recreate` rollout, the backup CronJob (dump, upload, verify,
  prune, and a restore of the dump), STARTTLS on the relay.
- `aws.webIdentity` from a k3s cluster against a real IAM role, with the issuer
  published as static files (the recipe below), on a self-hosted cluster in
  everyday use.
- `values-eks.yaml` renders and syncs through External Secrets Operator. It has
  **not** run on a real EKS cluster yet: treat IRSA, the ALB annotations and the
  RDS notes as untested until someone reports back.

## Secrets

`secrets.mode` decides where the Secret comes from. Every mode produces one
Secret, which every pod but docs loads.

| Mode | Use it when | Secret name |
|---|---|---|
| `existingSecret` (default) | You create the Secret yourself: `kubectl`, SealedSecrets, SOPS, Vault Secrets Operator, ... | `secrets.existingSecret.name` |
| `externalSecret` | [External Secrets Operator](https://external-secrets.io) is installed | the release fullname |
| `create` | Local tests only: values are stored in the Helm release | the release fullname |

Required keys: `DATABASE_URL`, `MASTER_ENCRYPTION_KEY`, `BETTER_AUTH_SECRET`.
Also add `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`, unless the pods get AWS
credentials some other way (see below). Add `S3_ACCESS_KEY_ID`,
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
`kubectl -n <namespace> rollout restart deployment -l app.kubernetes.io/instance=<release>`.

Back up `MASTER_ENCRYPTION_KEY`. Without it, the stored email bodies cannot be
read.

## AWS credentials without static keys

If the Secret has no `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`, every AWS
client in the app (SES sending, GetAccount, SQS polling, quotas) uses the AWS
SDK default provider chain. That chain picks up a web identity token, so the
pods can assume an IAM role and never hold a long-lived key.

In both setups below, the role needs the `millionsend-ses` permissions
(`infra/millionsend-ses.cfn.yaml`) **and read access to the SES events queue**.
The CloudFormation template grants the queue only to the IAM user it creates, so
add this to the role, or sending works while every `ReceiveMessage` is denied and
bounces and complaints never reach the suppression list:

```json
{
  "Effect": "Allow",
  "Action": ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"],
  "Resource": "arn:aws:sqs:<region>:<account>:millionsend-events"
}
```

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

**A public issuer.** AWS must be able to download
`<issuer>/.well-known/openid-configuration` and the JWKS it points at. The API
server of a k3s cluster is private, so publish the two documents yourself, as
static files on any HTTPS host (an S3 or R2 bucket behind a custom domain is
enough), and tell the API server about them. On every k3s server, in
`/etc/rancher/k3s/config.yaml`:

```yaml
kube-apiserver-arg:
  # The first issuer is the one new tokens carry.
  - service-account-issuer=https://oidc.example.com/k3s-prd
  # Keep the previous issuer as a second entry, or every token issued
  # before the change stops validating until its pod restarts.
  - service-account-issuer=https://kubernetes.default.svc.cluster.local
  - service-account-jwks-uri=https://oidc.example.com/k3s-prd/openid/v1/jwks
```

Publish, before restarting the API servers:

- `https://oidc.example.com/k3s-prd/.well-known/openid-configuration`

  ```json
  {
    "issuer": "https://oidc.example.com/k3s-prd",
    "jwks_uri": "https://oidc.example.com/k3s-prd/openid/v1/jwks",
    "response_types_supported": ["id_token"],
    "subject_types_supported": ["public"],
    "id_token_signing_alg_values_supported": ["RS256"]
  }
  ```

- `https://oidc.example.com/k3s-prd/openid/v1/jwks`: the output of
  `kubectl get --raw /openid/v1/jwks` (public keys only).

The issuer URL is the cluster's identity in every trust policy, so pick one you
will not change. The JWKS must be republished before
`/var/lib/rancher/k3s/server/tls/service.key` is ever rotated, or every AWS call
from the cluster fails until it is.

**An IAM OIDC provider** for that issuer, with audience `sts.amazonaws.com`.

**A role that trusts only this ServiceAccount**, with the condition
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

## Scaling

`worker.replicas` is also written to `WORKER_REPLICAS`, which every pod reads
(the console divides the SES rate by it). Each worker takes 1/N of the send
rate, so scale the worker only through the chart: an HPA or `kubectl scale`
would leave `WORKER_REPLICAS` out of date and push the account over its quota.
The worker uses the `Recreate` strategy for the same reason, because during a
rolling update old and new workers would overlap. `worker.replicas: 0` pauses
sending; `WORKER_REPLICAS` then stays at 1, the lowest value the app accepts.

`web` and `api` can run more than one replica, with three costs:

- The sign-in, sign-up, password-reset, failed-auth and MCP rate limiters are
  kept per process, so N replicas allow N times those limits.
- So is the per-team request cap (3,000 a minute across all of a team's API
  keys): each api and each smtp process counts it in memory. The per-key limit,
  `API_RATE_LIMIT_PER_MINUTE`, is kept in Postgres and holds across replicas.
- Each web or api replica opens about 26 Postgres connections, and the worker
  about 36. Size `max_connections` for the sum.

The EKS example runs one replica of each for that reason. When you raise them,
`podDisruptionBudget.enabled: true` adds a budget for every component with more
than one replica, so a node drain keeps one pod of each.

## Migrations

Every app pod runs pending migrations at boot. A Postgres advisory lock
serializes concurrent boots, so plain `helm upgrade` is enough. The startup
probe allows 10 minutes (`startupProbe.periodSeconds` x `failureThreshold`), so a
long migration is not killed partway through; raise it before a release whose
notes warn about a slow migration.

You can also set `migrations.job.enabled: true` to run `migrate` as a
`pre-install,pre-upgrade` hook (ArgoCD treats it as PreSync). Then a failing
migration stops the upgrade and the old pods keep serving, which is the
Kubernetes version of the `docker compose run --rm --no-deps millionsend migrate`
step in SELF_HOSTING.md. Run the upgrade with `--timeout 30m` (anything at least
`migrations.job.activeDeadlineSeconds`): with Helm's default of 5 minutes the
release fails while the Job keeps running, and a retry deletes the Job in the
middle of the migration. Helm deletes a succeeded Job; a failed one stays for
`ttlSecondsAfterFinished` (a day) so its logs can be read.

The hook runs before the chart's own resources, so it needs
`secrets.mode: existingSecret` with a Secret that already exists. With ArgoCD, a
SealedSecret in the same Application is only created after PreSync, so the first
sync fails: manage the SealedSecret in its own Application that syncs first.

## Ingress

`ingress.hosts[].paths[].component` routes each path to `web`, `api` or `docs`.
Set `ingress.className` for your controller (`traefik`, `alb`, `nginx`, ...).

The default host carries two paths, in this order: `/ses/events` (`Exact`) to
`api`, which confirms the SNS subscription and receives the bounce, complaint and
delivery notifications (routed to `web` it answers 404 and the subscription stays
pending), and `/` to `web`.

`APP_BASE_URL` must match the dashboard's public origin exactly. Set
`config.PUBLIC_API_URL` whenever the api gets its own host or prefix: without it
the dashboard and the MCP tokens point at `https://<dashboard host>:3001`.

ingress-nginx caps request bodies at 1m by default while the API accepts
25 MiB; add `nginx.ingress.kubernetes.io/proxy-body-size: 25m` to
`ingress.annotations`.

### Client addresses

The app finds the client address by reading `X-Forwarded-For` from the right and
skipping every address listed in `config.TRUSTED_PROXIES`; the first address it
does not trust is the client. Your ingress controller appends the address it
accepted the connection from, so **with a single hop (Traefik, ingress-nginx, an
ALB) leave `TRUSTED_PROXIES` unset**: the rightmost entry already is the client.

An in-cluster controller (Traefik, ingress-nginx) can only append the address
its own Service hands it. Behind a `LoadBalancer` or `NodePort` Service with the
default `externalTrafficPolicy: Cluster`, that is a node address, and every
visitor coming in through that node shares one rate-limit bucket, sign-in
included. Set `externalTrafficPolicy: Local` on the controller's Service, or
have the load balancer send PROXY protocol and turn it on in the controller.
k3s installs Traefik itself, with the `Cluster` policy; change it with a
`HelmChartConfig`:

```yaml
apiVersion: helm.cattle.io/v1
kind: HelmChartConfig
metadata:
  name: traefik
  namespace: kube-system
spec:
  valuesContent: |-
    service:
      spec:
        externalTrafficPolicy: Local
```

List only proxies *in front of* the ingress controller whose entries the
controller keeps: a CDN, a Cloudflare tunnel (`cloudflared`), an external load
balancer that adds a hop. Two things have to hold for that to work:

- The ingress controller must trust the forwarded headers it receives from that
  proxy (Traefik: `forwardedHeaders.trustedIPs` on the entrypoint; ingress-nginx:
  `use-forwarded-headers` with `proxy-real-ip-cidr`). Otherwise it replaces the
  chain with the proxy's own address and the client is already gone.
- `TRUSTED_PROXIES` must contain that proxy's addresses, so the walk steps past
  them.

Do not put the pod CIDR or the VPC CIDR there. Every in-cluster caller would
then share one rate-limit bucket, and any pod could claim a client address of
its choice.

## SMTP relay

The relay will not start without a STARTTLS keypair. Create a
`kubernetes.io/tls` Secret (for example with a cert-manager `Certificate` for the
relay hostname), set `smtp.enabled: true` and `smtp.tlsSecretName`, and set
`smtp.publicHost` to the hostname clients will connect to. Set `smtp.publicPort`
too when clients reach the relay on a port other than `smtp.service.port`: the
node port of a `NodePort` Service, or the port of a load balancer in front of
it. The Secret is mounted at `/certs`, and the `SMTP_TLS_*`, `SMTP_PORT` and
`SMTP_PUBLIC_HOST` variables are rendered into the shared ConfigMap, so the
dashboard's SMTP tab shows the relay's real state, host and port. `SMTP_PORT` in
the ConfigMap is `smtp.publicPort`, else the Service port (what clients use);
the relay container itself listens on `smtp.port`.

SMTP is not HTTP, so expose it with `smtp.service.type: LoadBalancer` or
`NodePort` (optionally limited by `loadBalancerSourceRanges`), and set
`smtp.service.externalTrafficPolicy: Local`. The relay allows 10 connections per
client address and checks that before AUTH; with the default `Cluster` policy
every client arrives as a node address, so one busy client locks the others out
with `421 Too many connections`. A TCP-proxying load balancer or an ingress TCP
route hides client addresses the same way, unless it speaks PROXY protocol
(which the relay does not).

**Certificate renewal.** The relay reads its keypair once at boot, so a
cert-manager renewal never reaches the running process and STARTTLS breaks when
the old certificate expires. Restart the Deployment after each renewal:

```sh
kubectl -n <namespace> rollout restart deploy/<fullname>-smtp
```

Either from a CronJob that runs inside the renewal window with a ServiceAccount
allowed to patch that Deployment, or with
[Reloader](https://github.com/stakater/Reloader), which watches the Secret. Put
its annotation on the smtp Deployment alone, so a renewal restarts nothing else:

```yaml
smtp:
  deploymentAnnotations:
    secret.reloader.stakater.com/reload: <smtp.tlsSecretName>
```

A relay that only serves pods of the same cluster can use a long-lived
self-signed certificate instead (the clients then skip chain validation), with
the Service left as `ClusterIP`.

For a private network without TLS at all, `config.SMTP_ALLOW_INSECURE_AUTH:
"true"` lets the relay start with no Secret; AUTH is then plaintext. Never
combine it with a public Service.

## Backups

`backup.enabled: true` runs a CronJob with `ghcr.io/millionsend/backup`, at the
app's version unless `backup.image` pins its own. It dumps, uploads to
S3-compatible storage, verifies the upload and prunes, once per run. It needs
`config.S3_BACKUP_BUCKET` and the S3 credentials. `backup.schedule` takes any
cron expression (the compose-only `BACKUP_CRON` is not used), and a run that
hangs is killed after `backup.activeDeadlineSeconds`. Skip it if your database
already backs itself up (CloudNativePG `ScheduledBackup`, RDS snapshots).

Restore with the same image. Stop the app first so nothing writes mid-restore:

```sh
kubectl -n <namespace> scale deployment -l app.kubernetes.io/instance=<release> --replicas=0
```

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: <fullname>-restore
spec:
  # A retry would run pg_restore --clean again over a half-restored database.
  backoffLimit: 0
  template:
    spec:
      restartPolicy: Never
      securityContext: { runAsNonRoot: true, runAsUser: 70, runAsGroup: 70, fsGroup: 70, seccompProfile: { type: RuntimeDefault } }
      containers:
        - name: restore
          image: ghcr.io/millionsend/backup:<version>
          envFrom:
            - configMapRef: { name: <fullname> }
            - secretRef: { name: <secret> }
          # backup.sh sets up rclone's S3 access, then runs its arguments.
          command: ["/usr/local/bin/backup.sh", "sh", "-c"]
          args:
            - rclone copyto ":s3:$S3_BACKUP_BUCKET/${S3_BACKUP_PREFIX:-backups}/millionsend-YYYYMMDD-HHMMSS.dump" /tmp/restore.dump
              && pg_restore --clean --if-exists -d "$DATABASE_URL" /tmp/restore.dump
          securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: [ALL] } }
          volumeMounts: [{ name: tmp, mountPath: /tmp }]
      volumes: [{ name: tmp, emptyDir: {} }]
```

The Job ends as failed even when the restore went through: `pg_restore` exits 1
because `--clean` cannot drop the primary keys that pg-boss's table partitions
inherit. It logs `cannot drop inherited constraint` for each, then
`errors ignored on restore`; those tables are dropped and restored anyway. When
those are the only errors in `kubectl -n <namespace> logs job/<fullname>-restore`,
the restore worked.

Then scale the Deployments back (`helm upgrade` with your values also restores
the replica counts). Dumps encrypted with `BACKUP_AGE_RECIPIENT` need
`age --decrypt` before `pg_restore`, as in SELF_HOSTING.md.

## Compose-only variables

| In `.env` | In the chart |
|---|---|
| `BACKUP_CRON` | `backup.schedule` (any cron expression, not only the daily form) |
| `PORT`, `SMTP_PORT` | set by the chart: the api listens on 3001, the relay on `smtp.port`; the SMTP tab shows `smtp.publicPort`, else `smtp.service.port` |
| `SMTP_TLS_CERT_PATH`, `SMTP_TLS_KEY_PATH` | set by the chart: the `smtp.tlsSecretName` keypair, mounted at `/certs` |
| `SMTP_PUBLIC_HOST` | `smtp.publicHost` |
| `WEB_PORT`, `DOCS_PORT`, `*_BIND_ADDRESS` | compose host ports and bind addresses; Services and the Ingress take their place |
| `COMPOSE_PROFILES` | `smtp.enabled`, `docs.enabled`, `backup.enabled` |
| `mx` and `clamav` in `COMPOSE_PROFILES` | nothing yet: receiving (the MX and ClamAV) is not covered by the chart |
| `MILLIONSEND_IMAGE`, `MILLIONSEND_BACKUP_IMAGE` | `image.*`, `backup.image.*` |
| `POSTGRES_PASSWORD` | not used: Postgres is external, `DATABASE_URL` carries the password |
| `WORKER_REPLICAS` | `worker.replicas` |

## Security defaults

The pods run with the same hardening as the compose files:

- non-root uid 999 (the image's `millionsend` user)
- read-only root filesystem, with `emptyDir` on the paths compose mounts as tmpfs
- all capabilities dropped and no privilege escalation
- `RuntimeDefault` seccomp
- no ServiceAccount token mounted (the web identity token, when on, is a
  projected token for AWS only)
- a shared PID namespace, so the pause container reaps the zombie each
  boot-time migration leaves (compose's `init: true`)
- the docs pod loads the ConfigMap only, never the Secret

web, api, smtp and docs sleep 10 s in `preStop` so in-flight requests finish
while the endpoint removal propagates (api and smtp exit at once on SIGTERM);
the grace period is 55 s, that sleep plus the worker's 30 s drain with margin.
These defaults pass the `restricted` Pod Security Standard.
