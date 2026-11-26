#!/usr/bin/env bash
# Usage: scripts/container-smoke.sh IMAGE
# Runs the image twice, the way the NAS compose file runs it (read-only root, no
# capabilities, no-new-privileges), each time on an empty volume:
#   1. no arguments, the 0.3 default: the broker (daemon run) and its owner panel
#      (daemon panel) under docker/entrypoint.ts. Healthy when docker/healthcheck.ts passes.
#   2. serve --container, the legacy peer, with an empty inventory. Healthy when
#      src/container/health.ts passes.
# Each run must become healthy within 60 seconds and still be running afterwards.
# Catches files the image needs at run time that the Dockerfile does not copy.
set -u
# Git Bash on Windows rewrites /app and /data paths in docker arguments without this.
export MSYS_NO_PATHCONV=1
img="${1:?usage: scripts/container-smoke.sh IMAGE}"
status=0

# smoke LABEL PROBE PRESEED [container arguments...]
#   PRESEED yes writes an empty inventory first (the legacy peer needs one; the
#   0.3 entrypoint creates its own).
smoke() {
  label="$1"
  probe="$2"
  preseed="$3"
  shift 3
  name="homectl-smoke-$label-$$"
  docker volume create "$name" >/dev/null
  if [ "$preseed" = yes ]; then
    docker run --rm -v "$name:/data" --entrypoint sh "$img" -c 'mkdir -p /data/home/.config/homectl && printf "version: 1\nmachines: {}\n" > /data/home/.config/homectl/inventory.yaml'
  fi
  docker run -d --name "$name" --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true -v "$name:/data" "$img" "$@" >/dev/null
  ok=1
  for _ in $(seq 1 60); do
    if docker exec "$name" bun "$probe" >/dev/null 2>&1; then ok=0; break; fi
    sleep 1
  done
  if [ "$ok" = 0 ] && [ "$(docker inspect -f '{{.State.Running}}' "$name")" != true ]; then
    ok=1
  fi
  docker logs "$name" 2>&1 | tail -20
  docker rm -f "$name" >/dev/null
  docker volume rm "$name" >/dev/null
  if [ "$ok" = 0 ]; then
    echo "healthy: $label ($img)"
  else
    echo "NOT healthy: $label ($img)"
    status=1
  fi
}

smoke default /app/docker/healthcheck.ts no
smoke serve /app/src/container/health.ts yes serve --container --interface 127.0.0.1 --no-discovery
exit "$status"
