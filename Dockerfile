# Containerized homectl peer (docs/homectl-2.0/container-peer.md).
#
# BUN_IMAGE has no default on purpose. Pass a digest-pinned reference from a
# registry you trust, for example:
#   --build-arg BUN_IMAGE=oven/bun@sha256:<digest>
# Use the Debian-based variant: the install step below uses apt-get.
ARG BUN_IMAGE
FROM ${BUN_IMAGE}

# openssh-client provides ssh-agent and ssh-add. keepassxc provides keepassxc-cli,
# which the session unlock requires. Package versions are not pinned here (open
# item in the design).
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-client keepassxc \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    HOME=/data/home \
    HOMECTL_PANEL_PORT=7447

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts
COPY src ./src
COPY schema ./schema

# Numeric non-root user. /data is the only writable volume; the root filesystem
# is read-only at run time (compose sets read_only: true).
RUN groupadd --system --gid 10001 homectl \
 && useradd --system --uid 10001 --gid 10001 \
      --home-dir /data/home --no-create-home --shell /usr/sbin/nologin homectl \
 && mkdir -p /data/home \
 && chown -R 10001:10001 /data

USER 10001:10001

# Peer protocol and optional authenticated reverse-proxy panel. Compose decides
# which host addresses (if any) publish these ports.
EXPOSE 7447 7448

# Local, unauthenticated, status-only health route; exits 0 only when "ok".
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=3 \
  CMD ["bun", "/app/src/container/health.ts"]

ENTRYPOINT ["bun", "/app/src/cli/main.ts"]
# Loopback by default: the peer port is reachable only after the compose file
# sets an explicit container address with --interface.
CMD ["serve", "--container", "--interface", "127.0.0.1", "--no-discovery"]
