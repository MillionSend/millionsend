# Backup sidecar: pg_dump + rclone (+ age for optional encryption), nothing
# else. Self-built rather than a third-party backup image to keep the supply
# chain to two upstreams (the official postgres image and Alpine's packages).
# The postgres major here must match the compose postgres service — pg_dump
# refuses newer servers.
FROM postgres:17-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73

RUN apk add --no-cache rclone age

COPY --chmod=755 backup.sh entrypoint.sh /usr/local/bin/

# The image's own entrypoint (which steps down from root itself) is replaced
# below, so step down here: the processes holding DATABASE_URL and the S3
# keys never run as uid 0.
USER postgres

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
