# Containerized peer on the NAS (slice 6, homelab #5 item 5)

Status: implemented. A `homectl-peer:pr6` image ran on Ugreen on 2026-11-10 and reported `healthy`, and the peer port answered from the LAN (record: homelab log 2026-11-11). An earlier draft dated this run to 2026-11-07. A local image tagged `pr6-ui-20261107` exists, but no record shows a run of it on Ugreen, so that date was removed. The authenticated remote panel and the prebuilt-image Compose Project example are still being validated separately. Addresses and paths in the examples remain placeholders.

Goal: homectl runs as an always-on peer in a container on the NAS. It pairs with the desktop peers, runs control sync, restarts cleanly, and holds no broad privilege.

## Container contract

- **Image.** Bun base image pinned by digest. The base is a required build argument (`BUN_IMAGE`, no default), so a tag-only build fails. The image runs as a numeric non-root user (`10001:10001`). `HOME=/data/home`, so all state lives under `/data`. OpenSSH client is installed for the session agent (`ssh-agent`). Dependencies are installed from `bun.lock` with `--frozen-lockfile`.
- **Filesystem.** `read_only: true`. One writable volume, `/data`, holds inventory, `control-plane/`, the device key, the KDBX database and the serve workspace. `/tmp` is a tmpfs. No other writable path is needed.
- **Privilege.** No Docker socket, no `privileged`, `cap_drop: ALL`, `no-new-privileges`, no host network. The image sets no capabilities.
- **Network.** The peer listener (7448) binds the container's static address on a user-defined bridge network and publishes on an explicit NAS LAN IP. The local panel (7447) remains on loopback. An optional authenticated panel proxy can bind a second, explicit container address; its host port should stay on loopback behind an HTTPS reverse proxy. Multicast discovery is disabled (`--no-discovery`); pairing uses the UI and a manual peer address.
- **Health.** `GET /healthz` on the local panel port (loopback inside the container). It is unauthenticated and returns only `{"status":"ok"|"degraded","version":"<semver>"}`. `degraded` means startup recovery flagged something (it never repairs), or control sync is off. The Docker `HEALTHCHECK` runs `bun /app/src/container/health.ts`, which exits 0 only for `ok`.
- **Limits.** Memory, CPU and PID limits in compose. `init: true` so signals reach homectl.

## Shutdown (SIGTERM and SIGINT)

1. Stop the timers and the discovery responder (none in container mode).
2. Wait up to 10 s for an in-flight control-sync round to finish. Then stop the scheduler.
3. Lock the hub: clear the vault and unload keys from the session agent.
4. Stop both listeners.
5. Delete the launch token (`serve/panel.json`).
6. Mark the run as stopped (`serve/run.json`, state `stopped`). Stop the heartbeat first, and wait for any heartbeat write in flight, so "stopped" is the last write.
7. Exit 0.

State files are written by temp-file-and-rename, so a stop does not need a separate flush. Audit entries are appended; a torn final line is caught by the startup verification below and refused (fail closed). Docker `stop_grace_period` is 20 s, longer than the 10 s sync wait.

## Startup recovery (fail closed, no auto-repair)

Runs before any listener is opened. Each check is logged to stderr with a short reason. No secret or entry content is logged.

| Check | Result |
|---|---|
| `serve/run.json` says `running` for another instance, and its heartbeat is younger than 90 s | Refuse (exit 3): "another homectl instance is using this data directory (host <hostname>, heartbeat <age> ago)". |
| `serve/run.json` says `running` for another instance, and its heartbeat is older than 90 s, or has none | Unclean previous shutdown: start, status `degraded` for this run, log it. |
| `serve/run.json` says `running` for this same instance | No duplicate; nothing to report. |
| `serve/run.json` unreadable | Refuse (exit 5): run state unknown. |
| Audit journal fails verification (truncated, diverged from its anchor, unparseable tail) | Refuse (exit 5). Nothing is repaired. Restore from backup or run `control audit verify`. A lagging anchor (crash between append and anchor write) is accepted, as the journal already does. |
| `*.tmp` leftovers from an interrupted atomic write | Start, status `degraded`, names logged. Files are kept, not deleted: the committed file is still the last consistent version. |
| `serve/panel.json` present at start | Removed: the server that issued the token is gone. |
| Any other state file fails to parse | Existing loaders refuse to start (exit 5); the container never rewrites them. |

Exit code 5 (integrity doubt) and exit code 3 (duplicate) end the start without writing. With `restart: unless-stopped`, Docker retries with backoff, so a transient cause recovers by itself and a lasting one shows in the logs until an operator acts. Use `docker stop` to hold it down.

## Remote panel and pairing

The local panel remains bound to loopback for the health check and local CLI. Container mode can additionally start a remote listener on one explicit container IP. That listener accepts only the configured browser origin and Host, then proxies requests to the existing loopback panel. It does not log the panel access code. Without all three `--panel-interface`, `--panel-origin` and `--panel-token-file` options, the remote listener stays off.

The access code is read from a protected file or Compose secret. It must contain at least 32 bytes and must not be group- or world-writable. The Compose secret source is a host file: make it readable by UID `10001` (the container user), for example with owner `10001:10001` and mode `0400`, while keeping it out of the Compose YAML, environment, command arguments and logs. The login page accepts the code; it does not need to appear in a URL or terminal output. The session cookie is `HttpOnly` and `SameSite=Strict`; the remote proxy adds `Secure` when the configured origin is HTTPS.

For a Compose Project, use `examples/container/compose.project.yaml`. It uses the prebuilt local image, the existing external Docker network and the existing `/data` volume. Set `HOMECTL_PANEL_BIND=127.0.0.1:17447` and route that host-loopback port through the NAS HTTPS reverse proxy. Configure `HOMECTL_PANEL_ORIGIN` to the exact public HTTPS origin and preserve the browser's Host and Origin headers. The panel port should not be published directly to the LAN for this setup. The project can then be managed from the Docker **Projects** view.

Open the HTTPS panel, enter the access code from the secret file, and use **Devices → Start pairing**. Enter the other peer's address and one-time code in the UI. Compare the verification phrase on both screens and confirm only when they match. Pairing still grants sync only; inventory and vault credentials stay local unless separately reviewed and synchronized.

Direct HTTP on a trusted LAN can be configured by binding `HOMECTL_PANEL_BIND` to the NAS LAN IP and setting the exact `http://IP:port` origin. HTTP does not encrypt the panel token or session cookie, so HTTPS through a trusted reverse proxy is the recommended configuration.

## Secrets

- The KDBX database password is never in the environment, compose, image or argv.
- `docker exec -it homectl home-ctl session unlock` prompts on a TTY, as on the desktop. Without a TTY it refuses.
- The session expires with its TTL. A container restart clears the agent, so unlock again after each restart.
- The KDBX file, device key and control state sit on `/data`. The volume is therefore sensitive at rest. Restrict the host directory to the container UID. This workspace does not replace runtime backups or the encrypted peer recovery design.

## NAS sleep and resume

- While the NAS sleeps, the container is stopped. Desktop peers see this device as offline. Their operations wait for the lease.
- On wake, `restart: unless-stopped` starts the container again after a host reboot. A container stopped by an operator (`docker stop`) stays stopped. Startup recovery runs on every start.
- To stop an offline device blocking operations, suspend it on the desktop with `home-ctl control peer suspend DEVICE --reason TEXT`. Suspension is signed, replicated and audited, and the device rejoins the lease on its next successful sync.

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
- The OpenSSH and KeePassXC packages are not version-pinned in the Dockerfile, and KeePassXC adds a large dependency set to the image.
- The first live run verified the digest-pinned image build, entry point, container startup, health check and LAN peer port. The authenticated remote panel, HTTPS reverse proxy and Compose Project replacement are still awaiting live verification.
- Container `session unlock`, and whether a session agent survives the exit of `docker exec`, remain unverified.
- One container per `/data` volume is an operator rule, and the heartbeat is the guard. Each start gets a random instance id, and a running instance rewrites `serve/run.json` (instance id, hostname, start time, heartbeat) every 30 s (`HEARTBEAT_MS`). A second container is refused while the heartbeat is younger than 90 s (`STALE_AFTER_MS`). A container that restarts within 90 s of a crash is therefore refused until that heartbeat ages out, and Docker retries it. Pids are not used for this check, because every container's main process is pid 1. The control-plane lock still records a pid; it is read only inside one process namespace, so it is a warning here, not a guard.

## Onboarding runbook

Placeholders in this runbook: `192.0.2.20` is the NAS LAN address, `172.28.0.10` the container address on the example subnet `172.28.0.0/24`, and `/volume2/appdata/homectl` the data directory. Replace all of them with your own values. Never paste a password, a verification phrase or a pairing code into chat, email or a log.

### 1. Prepare the data directory

- Create `/volume2/appdata/homectl` on the NAS, owned by UID 10001 with mode 0700 (`chown -R 10001:10001` and `chmod 0700`).
- Copy the KeePassXC database into it privately, for example to `/volume2/appdata/homectl/vault/homelab.kdbx`. It is seen inside the container as `/data/vault/homelab.kdbx`. Do not put it in the repository.

### 2. Build the image

- Look up the Bun base digest from a registry you trust, for example `docker buildx imagetools inspect oven/bun:<tag>`, and confirm it against a second source. The build refuses a tag-only value because `BUN_IMAGE` has no default.
- Build from a checkout with `docker build --build-arg BUN_IMAGE=oven/bun@sha256:<digest> -t homectl-peer:pr6 .`, or use a temporary digest-pinned Bun helper container when the NAS has no Git/build toolchain. Verify the fetched commit before the build.
- Check the entry point without state: `docker run --rm --read-only --cap-drop ALL homectl-peer:pr6 help`.

### 3. Configure a Compose Project

- Import `examples/container/compose.project.yaml` in UGOS Docker **Projects** after the prebuilt image, data directory, external network and panel token file are ready.
- Set `HOMECTL_LAN_IP`, `HOMECTL_PANEL_BIND`, `HOMECTL_PANEL_ORIGIN`, and `HOMECTL_PANEL_TOKEN_FILE` in the project's `.env` file. The token file is mounted as a Compose secret; do not put its value in `.env`, `environment:`, compose or the image.
- The example reuses the existing external network `homectl-pr6-lan` and its address `172.28.0.10`. Change these only after checking that the replacement subnet is free and updating the peer and panel interface addresses together.
- To move from the first manually created container, stop and remove only that container in UGOS **Containers** before starting the Project with the same `container_name`. Keep `/volume2/appdata/homectl` and the `homectl-peer:pr6` image; the Project reuses the existing data directory.

### 4. First run

- Import the project in UGOS Docker **Projects** and start it, or run `docker compose up -d` from the project directory. The prebuilt project file does not build or download an image.
- `docker logs homectl` shows one JSON line with `"state":"running"` and `"startup":"clean"` on a fresh volume. Any warning line on stderr starts with `homectl: startup:` and names the reason.
- Health after the start period: `docker inspect --format '{{.State.Health.Status}}' homectl` should report `healthy`. `unhealthy` means the local route answered `degraded` or did not answer; read the last startup lines in the logs.

### 5. Unlock the session (interactive only)

- `docker exec -it homectl home-ctl session configure --database /data/vault/homelab.kdbx --ttl 8h`
- `docker exec -it homectl home-ctl session unlock` prompts for the database password on the terminal. It refuses without a TTY.
- A container restart clears the session. Unlock again after every restart, and check with `docker exec homectl home-ctl session status`.

### 6. Pair with a desktop peer

- Open the remote HTTPS panel and enter the access code. In **Devices**, open pairing.
- On the other device, select the NAS if it appears, or enter `http://<NAS-LAN-IP>:7448` and the one-time code in its UI.
- Compare the verification phrase on both screens and confirm on each device only when it matches. Check the Devices and Sync views afterwards.
- Verify fingerprints out of band. A fingerprint received by chat, email or a screenshot is not verified.

### 7. Check sync and the audit chain

- `docker exec homectl home-ctl peers` lists paired devices without secrets.
- `docker exec homectl home-ctl control sync` shows per-device sync: last sync, lease, backoff, refusals and conflicts.
- `docker exec homectl home-ctl control audit verify` checks the audit chain and its anchor.

### 8. When the NAS sleeps

- While the container is stopped, desktop peers see this device as offline and their operations wait for the lease.
- To stop an offline device from blocking a desktop, suspend it there: `home-ctl control peer suspend <nas-device-name> --reason "NAS asleep"`. The suspension is signed, replicated and audited, and the device rejoins the lease on its next successful sync. Resume it with `home-ctl control peer resume <nas-device-name>`.
- On wake, `restart: unless-stopped` starts the container after a host reboot. Startup recovery runs on every start. Unlock the session again (step 5).

### 9. Upgrade and rollback

- Back up `/data` first (section 10).
- Build the new image from a new digest and tag it with its version (`homectl-peer:<version>`). Keep the previous tag. Run `docker compose up -d`, then check the logs, the health status and `control audit verify`.
- Roll back by pointing compose at the previous tag and starting it against the same `/data`. Do not roll back across a state-format change; restore the pre-upgrade backup instead.

### 10. Back up `/data`

- Stop the container first (`docker compose stop homectl`). A copy taken while it runs can tear the control-plane files.
- Archive `/volume2/appdata/homectl` to a location outside the NAS, encrypted before it leaves the NAS. The archive holds the KeePassXC database and the device key.
- Start the container again. Test a restore into a scratch directory on another host before you rely on the backup. This workspace does not replace runtime backups or the encrypted peer recovery design.

### 11. Troubleshooting

- Exit 3, "another homectl instance is using this data directory (host <hostname>, heartbeat <age> ago)": only one container may use a data directory. Check `docker ps -a` on the host named in the message, then stop the other one. If none is running, wait until the heartbeat is older than 90 s; the next start then proceeds as an unclean previous run.
- Exit 5, "Audit journal failed startup verification": nothing was changed and nothing will be repaired automatically. Keep the directory as it is. Work on a copy, restore the control-plane directory from backup, or run `control audit verify` on the copy.
- A `half-written file left by an interrupted write` warning: the committed file is still in use and the temp file is kept. Note its name and investigate before removing it.
- `unhealthy` with a running container: read the last startup line and the warnings in `docker logs homectl`.

### Live validation status

- On Ugreen, on 2026-11-10, the first `homectl-peer:pr6` image build and entry-point check succeeded. The container started as UID 10001 with a read-only root filesystem, reported `healthy`, and accepted TCP on the NAS LAN peer port.
- The panel changes and Compose Project import need a new image and restart before their live behavior can be confirmed.
- Container `session unlock` and whether a session agent survives the exit of `docker exec` remain unverified.

## Image distribution (GHCR)

- The workflow `.github/workflows/container.yml` builds the image on pull requests (no push) and publishes it on version tags `v*` to `ghcr.io/hiosdra/homectl`.
- Tags per release: `<version>`, `<major>.<minor>`, `latest` and `sha-<commit>`. The image is `linux/amd64` only for now.
- The Bun base is pinned by digest in the workflow (`BUN_IMAGE`). Change it only in a reviewed pull request, and check the new digest against a registry you trust.
- Pushes use the workflow's `GITHUB_TOKEN` with `packages: write`. A personal token with only `read:packages` cannot push.
- A new GHCR package is private by default. Either make it public, or give the NAS a read-only pull credential before `docker compose pull`.
- Not yet verified: a pulled image run on the NAS, and the arm64 build (needs QEMU in CI).
