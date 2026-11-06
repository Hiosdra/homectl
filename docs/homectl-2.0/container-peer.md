# Containerized peer on the NAS (slice 6, homelab #5 item 5)

Status: design. Nothing here has been built or run on a real NAS. The image cannot be built on the development machine (no Docker daemon is running there), so the Dockerfile and compose file are checked by lint-style tests only. All values are synthetic: `172.28.0.0/24`, `192.0.2.20`, `/volume2/appdata/homectl` (an example path, not a real one).

Goal: homectl runs as an always-on peer in a container on the NAS. It pairs with the desktop peers, runs control sync, restarts cleanly, and holds no broad privilege.

## Container contract

- **Image.** Bun base image pinned by digest. The base is a required build argument (`BUN_IMAGE`, no default), so a tag-only build fails. The image runs as a numeric non-root user (`10001:10001`). `HOME=/data/home`, so all state lives under `/data`. OpenSSH client is installed for the session agent (`ssh-agent`). Dependencies are installed from `bun.lock` with `--frozen-lockfile`.
- **Filesystem.** `read_only: true`. One writable volume, `/data`, holds inventory, `control-plane/`, the device key, the KDBX database and the serve workspace. `/tmp` is a tmpfs. No other writable path is needed.
- **Privilege.** No Docker socket, no `privileged`, `cap_drop: ALL`, `no-new-privileges`, no host network. The image sets no capabilities.
- **Network.** The peer listener (7448) binds the container's static LAN address on a user-defined bridge network, and only that port is published, on an explicit host LAN IP. The local panel (7447) is never published. Multicast discovery is disabled (`--no-discovery`); pairing is manual, by address and code.
- **Health.** `GET /healthz` on the local panel port (loopback inside the container). It is unauthenticated and returns only `{"status":"ok"|"degraded","version":"<semver>"}`. `degraded` means startup recovery repaired or flagged something, or control sync is off. The Docker `HEALTHCHECK` runs `bun /app/src/container/health.ts`, which exits 0 only for `ok`.
- **Limits.** Memory, CPU and PID limits in compose. `init: true` so signals reach homectl.

## Shutdown (SIGTERM and SIGINT)

1. Stop the timers and the discovery responder (none in container mode).
2. Wait up to 10 s for an in-flight control-sync round to finish. Then stop the scheduler.
3. Lock the hub: clear the vault and unload keys from the session agent.
4. Stop both listeners.
5. Delete the launch token (`serve/panel.json`).
6. Mark the run as stopped (`serve/run.json`, state `stopped`).
7. Exit 0.

Every state write is already an atomic temp-file-and-rename, so no separate flush is needed. Docker `stop_grace_period` is 20 s, longer than the 10 s sync wait.

## Startup recovery (fail closed, no auto-repair)

Runs before any listener is opened. Each check is logged to stderr with a short reason. No secret or entry content is logged.

| Check | Result |
|---|---|
| `serve/run.json` says `running` and its pid is alive and not this process | Refuse (exit 3): another homectl uses this volume. |
| `serve/run.json` says `running` otherwise | Unclean previous shutdown: start, status `degraded` for this run, log it. |
| `serve/run.json` unreadable | Refuse (exit 5): run state unknown. |
| Audit journal fails verification (truncated, diverged from its anchor, unparseable tail) | Refuse (exit 5). Nothing is repaired. Restore from backup or run `control audit verify`. A lagging anchor (crash between append and anchor write) is accepted, as the journal already does. |
| `*.tmp` leftovers from an interrupted atomic write | Start, status `degraded`, names logged. Files are kept, not deleted: the committed file is still the last consistent version. |
| `serve/panel.json` present at start | Removed: the server that issued the token is gone. |
| Any other state file fails to parse | Existing loaders refuse to start (exit 5); the container never rewrites them. |

Exit code 5 with `restart: on-failure:5` lets Docker retry a transient failure a few times, then stop, which leaves the volume for an operator.

## Panel access and pairing

The panel binds the container's loopback, so the NAS host and the LAN cannot reach it. Options considered:

1. Publish the panel on the NAS loopback or LAN. Rejected for the default: it adds an exposed web UI with a one-time token to the LAN.
2. SSH tunnel to the NAS host. Not possible without (1), because the tunnel ends on the host, not in the container.
3. **Default: CLI through `docker exec`.** Pairing uses the local API through `serve/panel.json`, so `docker exec -it homectl homectl pair open|join|confirm|status|poll|cancel` works without a browser. Approvals and other operations use the `control` commands in the same way.

Decision: panel not published. Pairing and control run through `docker exec`. Publishing the panel is a later, separately approved change.

## Secrets

- The KDBX database password is never in the environment, compose, image or argv.
- `docker exec -it homectl homectl session unlock` prompts on a TTY, as on the desktop. Without a TTY it refuses.
- The session expires with its TTL. A container restart clears the agent, so unlock again after each restart.
- The KDBX file, device key and control state sit on `/data`. The volume is therefore sensitive at rest. Restrict the host directory to the container UID. This workspace does not replace runtime backups or the encrypted peer recovery design.

## NAS sleep and resume

- While the NAS sleeps, the container is stopped. Desktop peers see this device as offline. Their operations wait for the lease.
- On wake, Docker starts the container again (`restart: on-failure:5` covers failure restarts; a clean host shutdown leaves the container stopped, so the NAS boot script or `docker start` brings it back). Startup recovery runs.
- To stop an offline device blocking operations, suspend it on the desktop with `homectl control peer suspend DEVICE --reason TEXT`. Suspension is signed, replicated and audited, and the device rejoins the lease on its next successful sync.

## Upgrade and rollback

- Back up `/data` first (stop the container, then archive the directory).
- Build the new image with a new digest, `docker compose up -d`, and check `/healthz` and `control audit verify`.
- Rollback: start the previous image tag against the same `/data`. Do not roll back across a state-format change; restore the pre-upgrade backup instead.

## Backup

- Stop the container before copying `/data`. A live copy can be torn across the control-plane files.
- The archive contains the KDBX file and the device key. Encrypt it before it leaves the NAS.

## Resource limits (example values)

`mem_limit: 512m`, `cpus: 1.0`, `pids_limit: 256`, `tmpfs /tmp 64m`. These are starting points for a small peer, not measured numbers.

## Open items

- The Bun base digest must be pinned by the operator from a registry they trust (`docker buildx imagetools inspect oven/bun:<tag>`). It is not pinned in this repository.
- The OpenSSH package is not version-pinned in the Dockerfile.
- Not verified: the image build, `bun install --production` in the image, `session unlock` inside the container, and whether a session agent survives `docker exec` exit. Verify on a real NAS before relying on it.
- One container per `/data` volume is an operator rule. The run marker detects a live duplicate only by pid, which does not cross containers.
