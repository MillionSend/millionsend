#!/bin/sh
# Gate + scheduler for the backup service. S3_BACKUP_BUCKET enables backups;
# unset exits 0 so an unconfigured deployment stays clean (the compose service
# uses restart: "no", so the stopped container is harmless). The app container
# validates at boot that the bucket comes with the shared S3_* credentials, so
# a lone gate on the bucket suffices here.
# -f: the cron fields below are word-split, and "*" must not glob.
set -euf

if [ -z "${S3_BACKUP_BUCKET:-}" ]; then
  echo "backups disabled — set S3_BACKUP_BUCKET to enable"
  exit 0
fi

# BACKUP_CRON keeps its cron shape, but only the daily "<minute> <hour> * * *"
# form is honoured: BusyBox crond calls initgroups for every job, which needs
# CAP_SETGID, and this container runs unprivileged with every capability
# dropped — so the schedule is a sleep loop rather than crond.
cron="${BACKUP_CRON:-0 3 * * *}"
# shellcheck disable=SC2086 # word-split the five cron fields
set -- $cron
case "$#:$1:$2:$3:$4:$5" in
  5:[0-9]:[0-9]:\*:\*:\* | 5:[0-9][0-9]:[0-9]:\*:\*:\* | 5:[0-9]:[0-9][0-9]:\*:\*:\* | 5:[0-9][0-9]:[0-9][0-9]:\*:\*:\*) ;;
  *)
    echo "BACKUP_CRON must be a daily schedule, \"<minute> <hour> * * *\" (got: $cron)" >&2
    exit 1
    ;;
esac
# A leading zero would make the shell read the field as octal.
minute=${1#0}
hour=${2#0}
at=$(( ${minute:-0} * 60 + ${hour:-0} * 3600 ))

# Baseline dump right away so a fresh deploy is protected before the first tick.
/usr/local/bin/backup.sh

echo "backup schedule installed: $cron (UTC)"
while :; do
  now=$(date -u +%s)
  next=$(( now - now % 86400 + at ))
  [ "$next" -gt "$now" ] || next=$(( next + 86400 ))
  # Backgrounded so a stop signal ends the loop at once instead of after the sleep.
  sleep $(( next - now )) &
  wait $!
  /usr/local/bin/backup.sh || echo "backup: failed, next attempt at the scheduled time" >&2
done
