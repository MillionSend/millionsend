# Backup sidecar: pg_dump + rclone, nothing else. Self-built rather than a
# third-party backup image to keep the supply chain to two upstreams (the
# official postgres image and Alpine's rclone package). The postgres major
# here must match the compose postgres service — pg_dump refuses newer servers.
FROM postgres:18-alpine@sha256:d3e1620b530c944afa6e887d22eb899824da68e19c52024bf98f5220c88a65b2

RUN apk add --no-cache rclone

COPY --chmod=755 backup.sh entrypoint.sh /usr/local/bin/

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
