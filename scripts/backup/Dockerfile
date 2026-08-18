# Backup sidecar: pg_dump + rclone, nothing else. Self-built rather than a
# third-party backup image to keep the supply chain to two upstreams (the
# official postgres image and Alpine's rclone package). The postgres major
# here must match the compose postgres service — pg_dump refuses newer servers.
FROM postgres:17-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73

RUN apk add --no-cache rclone

COPY --chmod=755 backup.sh entrypoint.sh /usr/local/bin/

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
