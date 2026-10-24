# Backup sidecar: pg_dump + rclone (+ age for optional encryption), nothing
# else. Self-built rather than a third-party backup image to keep the supply
# chain to two upstreams (the official postgres image and Alpine's packages).
# The postgres major here must match the compose postgres service — pg_dump
# refuses newer servers.
FROM postgres:17-alpine@sha256:eee6c6e1b0894fa4fe0075eb054af9fd1cf39a35321c2d4110626cfe506411fb

RUN apk add --no-cache rclone age

COPY --chmod=755 backup.sh entrypoint.sh /usr/local/bin/

# The image's own entrypoint (which steps down from root itself) is replaced
# below, so step down here: the processes holding DATABASE_URL and the S3
# keys never run as uid 0.
USER postgres

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
