#!/bin/sh
# One backup cycle: pg_dump -Fc (already compressed) -> upload to an
# S3-compatible bucket -> verify the uploaded size -> prune old dumps.
# Configured entirely from the shared S3_* credentials plus the S3_BACKUP_* /
# BACKUP_* env (see .env.example); reuses the stack's DATABASE_URL. Invoked
# with arguments it instead runs them with the rclone env prepared — the
# documented restore path (`... backup.sh sh -c 'rclone ...'`).
# shellcheck disable=SC3040 # BusyBox ash does support pipefail
set -euo pipefail

# rclone's s3 backend configured purely via env: no config file, and secrets
# never on the command line where `ps` would show them. provider Cloudflare
# makes rclone apply R2's quirks; other S3-compatibles set S3_PROVIDER.
export RCLONE_CONFIG=/dev/null
export RCLONE_S3_PROVIDER="${S3_PROVIDER:-Cloudflare}"
export RCLONE_S3_ENDPOINT="${S3_ENDPOINT}"
export RCLONE_S3_ACCESS_KEY_ID="${S3_ACCESS_KEY_ID}"
export RCLONE_S3_SECRET_ACCESS_KEY="${S3_SECRET_ACCESS_KEY}"
export RCLONE_S3_REGION="${S3_REGION:-auto}"
# The bucket must already exist. Skipping rclone's bucket probe/create lets
# R2 tokens scoped to a single bucket (no ListBuckets permission) work.
export RCLONE_S3_NO_CHECK_BUCKET=true

remote=":s3:${S3_BACKUP_BUCKET}/${S3_BACKUP_PREFIX:-backups}"

# Escape hatch for restore/inspection: any arguments run as a command with
# the rclone env above already in place.
if [ "$#" -gt 0 ]; then
  exec "$@"
fi

name="millionsend-$(date -u +%Y%m%d-%H%M%S).dump"
dump="/tmp/${name}"
trap 'rm -f "$dump"' EXIT

echo "backup: dumping database"
pg_dump --format=custom --file "$dump" "$DATABASE_URL"
local_size=$(wc -c <"$dump")

echo "backup: uploading ${name} (${local_size} bytes)"
rclone copyto "$dump" "${remote}/${name}"

# Re-read the object's size from the bucket and require a byte-for-byte match
# before anything gets pruned — never trust an upload that wasn't read back.
remote_size=$(rclone lsjson "${remote}/${name}" | sed -n 's/.*"Size":\([0-9]\{1,\}\).*/\1/p')
if [ "${remote_size:-0}" != "$local_size" ] || [ "$local_size" -eq 0 ]; then
  echo "backup: verification failed for ${name} (local ${local_size} bytes, remote ${remote_size:-none})" >&2
  exit 1
fi

echo "backup: pruning dumps older than ${BACKUP_RETENTION_DAYS:-14} days"
rclone delete --min-age "${BACKUP_RETENTION_DAYS:-14}d" "$remote"

echo "backup: done (${name})"
