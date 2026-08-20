#!/bin/sh
# Gate + scheduler for the backup service. S3_BACKUP_BUCKET enables backups;
# unset exits 0 so an unconfigured deployment stays clean (the compose service
# uses restart: "no", so the stopped container is harmless). The app container
# validates at boot that the bucket comes with the shared S3_* credentials, so
# a lone gate on the bucket suffices here.
set -eu

if [ -z "${S3_BACKUP_BUCKET:-}" ]; then
  echo "backups disabled — set S3_BACKUP_BUCKET to enable"
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
