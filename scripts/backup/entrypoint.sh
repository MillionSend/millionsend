#!/bin/sh
# Gate + scheduler for the backup service. All four BACKUP_S3_* settings are
# required to enable backups; anything missing exits 0 so an unconfigured
# deployment stays clean (the compose service uses restart: "no", so the
# stopped container is harmless).
set -eu

if [ -z "${BACKUP_S3_BUCKET:-}" ] || [ -z "${BACKUP_S3_ENDPOINT:-}" ] ||
  [ -z "${BACKUP_S3_ACCESS_KEY_ID:-}" ] || [ -z "${BACKUP_S3_SECRET_ACCESS_KEY:-}" ]; then
  echo "backups disabled — set BACKUP_S3_* to enable"
  exit 0
fi

# Baseline dump right away so a fresh deploy is protected before the first tick.
/usr/local/bin/backup.sh

# BusyBox crond, UTC. crond is exec'd as PID 1, so pointing job output at
# /proc/1/fd/1 lands it in the container log (crond itself discards it).
cron="${BACKUP_CRON:-0 3 * * *}"
echo "$cron /usr/local/bin/backup.sh >/proc/1/fd/1 2>&1" >/etc/crontabs/root
echo "backup schedule installed: $cron (UTC)"
exec crond -f -l 8 -L /dev/stdout
