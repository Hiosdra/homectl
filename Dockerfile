# Containerized homectl (docs/setup.md (Docker and NAS containers)). By default
# it runs the 0.3 broker (`daemon run`) and its owner panel (`daemon panel`);
# the legacy `serve --container` peer runs when it is passed as the command.
#
# BUN_IMAGE has no default on purpose. Pass a digest-pinned reference from a
# registry you trust, for example:
#   --build-arg BUN_IMAGE=oven/bun@sha256:<digest>
# Use the Debian-based variant: the install step below uses apt-get.
ARG BUN_IMAGE
FROM ${BUN_IMAGE}

# openssh-client provides ssh-agent and ssh-add. keepassxc provides keepassxc-cli,
# which the session unlock requires. Package versions are not pinned here (open
# item in the design): BUN_IMAGE picks the Debian release, so apt versions
# cannot be known here; the digest-pinned base is what makes builds repeatable.
# hadolint ignore=DL3008
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-client keepassxc \
 && rm -rf /var/lib/apt/lists/*

# HOME=/data/home puts the inventory and broker state on the /data volume.
# HOMECTL_OWNER_PANEL_PORT is the owner panel (loopback inside the container).
# HOMECTL_PANEL_PORT is the legacy serve panel, used only by its health check.
ENV NODE_ENV=production \
    HOME=/data/home \
    HOMECTL_OWNER_PANEL_PORT=7451 \
    HOMECTL_PANEL_PORT=7447

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts
COPY src ./src
COPY schema ./schema
# src/skills-bundle.ts imports the skill files; without them every command fails.
COPY skills ./skills
# Container entrypoint (broker + owner panel supervisor) and health check.
COPY docker ./docker

# Numeric non-root user. /data is the only writable volume; the root filesystem
# is read-only at run time (compose sets read_only: true).
RUN groupadd --system --gid 10001 homectl \
 && useradd --system --uid 10001 --gid 10001 \
      --home-dir /data/home --no-create-home --shell /usr/sbin/nologin homectl \
 && mkdir -p /data/home \
 && chown -R 10001:10001 /data

USER 10001:10001

# Documentation only. 7450 is the workspace server listener, used only when
# HOMECTL_WORKSPACE_LISTEN is set. 7448 is the legacy serve peer port. The owner
# panel (7451) binds to loopback inside the container and is not published here.
EXPOSE 7448 7450

# Local, unauthenticated, status-only check (docker/healthcheck.ts). Exits 0 when
# the broker and its owner panel answer, or when the legacy serve health route does.
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=3 \
  CMD ["bun", "/app/docker/healthcheck.ts"]

# With no arguments: broker plus owner panel. With arguments: home-ctl <arguments>.
ENTRYPOINT ["bun", "/app/docker/entrypoint.ts"]
