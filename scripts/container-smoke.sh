#!/usr/bin/env bash
# Usage: scripts/container-smoke.sh IMAGE
# Starts the peer the way the NAS compose file does (read-only root, no capabilities,
# serve --container) with an empty inventory, and fails unless it becomes healthy.
# Catches files the image needs at run time but the Dockerfile does not copy.
set -u
img="$1"; name="homectl-smoke-$$"
docker volume create "$name" >/dev/null
docker run --rm -v "$name:/data" --entrypoint sh "$img" -c 'mkdir -p /data/home/.config/homectl && printf "version: 1\nmachines: {}\n" > /data/home/.config/homectl/inventory.yaml'
docker run -d --name "$name" --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true -v "$name:/data" "$img" serve --container --interface 127.0.0.1 --no-discovery >/dev/null
ok=1
for _ in $(seq 1 30); do
  if docker exec "$name" bun /app/src/container/health.ts >/dev/null 2>&1; then ok=0; break; fi
  sleep 1
done
docker logs "$name" 2>&1 | tail -5
docker rm -f "$name" >/dev/null; docker volume rm "$name" >/dev/null
[ "$ok" = 0 ] && echo "healthy: $img" || echo "NOT healthy: $img"
exit "$ok"
