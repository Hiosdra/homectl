#!/bin/sh
# Real-OS-user check of the hardened Linux broker (homelab #21, matrix B1).
#
#   sudo sh scripts/hardened-linux-check.sh /path/to/home-ctl
#
# Creates the homectl service account and the directories install.ts prepares (state
# 0700 owned by homectl, workspace with the custody files, runtime directory), starts the
# broker as that account, then checks as a separate unprivileged agent account that:
#   - it cannot read broker state, the vault copy or the key directory;
#   - the agent socket answers without a token with 401;
#   - a client token reaches agent routes, and is refused on owner routes.
# systemd is not needed: the broker runs under runuser, as the unit would run it.
# Test-only: the owner password and client are generated here and discarded at the end.
#
# Needs keepassxc-cli (apt package keepassxc) to create the test vault. With a vault in the
# workspace, the vault master password is the owner credential (src/broker/daemon.ts), so the
# vault is created with the generated owner password instead of through `owner init`.
# Every wait and network call has its own timeout: a stuck step fails the check instead of
# holding the CI job.
set -eu

bin="${1:?usage: sudo sh scripts/hardened-linux-check.sh /path/to/home-ctl}"
if [ "$(id -u)" -ne 0 ]; then
  echo "run as root (sudo): the check creates OS accounts and starts the broker as one" >&2
  exit 2
fi
if ! command -v keepassxc-cli >/dev/null 2>&1; then
  echo "install keepassxc first (apt-get install keepassxc): it creates the test vault" >&2
  exit 2
fi

svc=homectl
agent=homectl-agent
state=/var/lib/homectl
runtime=/run/homectl
launcher=/usr/local/libexec/homectl/home-ctl
sock="$runtime/agent.sock"
work="$(mktemp -d)"
daemon_pid=""
failures=0

pass() { echo "ok    $*"; }
fail() { echo "FAIL  $*" >&2; failures=$((failures + 1)); }
cleanup() {
  if [ -n "$daemon_pid" ]; then kill "$daemon_pid" 2>/dev/null || true; fi
  # runuser may not relay the signal: stop everything the service account runs.
  pkill -u "$svc" 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT

# 1. Accounts, as install.ts's linuxPlan creates them.
id -u "$svc" >/dev/null 2>&1 || useradd --system --home-dir "$state" --no-create-home \
  --shell /usr/sbin/nologin "$svc"
id -u "$agent" >/dev/null 2>&1 || useradd --create-home --shell /bin/sh "$agent"

# 2. Paths and custody files, as linuxPlan prepares them.
install -d -m 0700 -o "$svc" -g "$svc" "$state" "$state/workspace"
install -d -m 0755 -o "$svc" -g "$svc" "$runtime"
install -d -m 0755 "$(dirname "$launcher")"
install -m 0755 "$bin" "$launcher"
printf 'version: 1\nmachines:\n  pc:\n    description: this computer\n    transport: local\n    access: user\n' \
  > "$state/workspace/inventory.yaml"
: > "$state/workspace/ssh_config"

# 3. Owner password and vault. The vault's master password is the owner password, so one
# secret signs the owner in, and the agent cannot read the vault file.
owner_pw="$(head -c 24 /dev/urandom | base64 | tr -d '\n=+/')"
printf '%s\n%s\n' "$owner_pw" "$owner_pw" \
  | timeout 60 keepassxc-cli db-create --quiet --set-password --decryption-time 1000 \
    "$state/workspace/homelab.kdbx" >/dev/null 2>&1 \
  || { echo "FAIL  keepassxc-cli could not create the test vault" >&2; exit 1; }
chown -R "$svc:$svc" "$state"
chmod 0600 "$state/workspace/homelab.kdbx"

# 4. Start the broker as the service account, from a directory it can enter.
(cd / && runuser -u "$svc" -- env HOME="$state" "$launcher" daemon run --mode hardened) \
  > "$work/daemon.log" 2>&1 &
daemon_pid=$!
tries=0
while [ ! -S "$sock" ] && [ "$tries" -lt 60 ]; do
  sleep 1
  tries=$((tries + 1))
done
if [ ! -S "$sock" ]; then
  cat "$work/daemon.log" >&2
  echo "FAIL  the broker socket did not appear at $sock" >&2
  exit 1
fi
pass "broker running as $svc on $sock"

# The broker's own state must exist, or the checks below would prove nothing.
for present in "$state/workspace/homelab.kdbx" "$state/keys"; do
  if [ -e "$present" ]; then pass "present (as root): $present"; else fail "missing: $present"; fi
done

# 5. Filesystem: the agent account cannot read broker state. Each probe has a timeout.
as_agent() { (cd / && timeout 20 runuser -u "$agent" -- sh -c "$1"); }
if as_agent "cat '$state/workspace/homelab.kdbx' >/dev/null 2>&1"; then
  fail "agent can read $state/workspace/homelab.kdbx"
else
  pass "agent cannot read $state/workspace/homelab.kdbx"
fi
if as_agent "ls '$state/keys' >/dev/null 2>&1"; then
  fail "agent can list the key directory"
else
  pass "agent cannot list $state/keys"
fi
if as_agent "ls '$state' >/dev/null 2>&1"; then
  fail "agent can list $state"
else
  pass "agent cannot list $state"
fi

# 6. Socket: an unauthenticated request is refused.
code="$(as_agent "curl -s --max-time 10 -o /dev/null -w '%{http_code}' --unix-socket '$sock' -X POST \
  -H 'content-type: application/json' -d '{}' http://localhost/v1/whoami")"
if [ "$code" = "401" ]; then pass "agent socket answers 401 without a token"; else
  fail "agent socket without a token answered $code, expected 401"; fi

# 7. Owner login and a client, through the owner API as root (the operator).
root_post() {
  curl -s --max-time 20 --unix-socket "$sock" -X POST -H 'content-type: application/json' "$@"
}
login="$(root_post -d "{\"password\":\"$owner_pw\"}" http://localhost/v1/owner/login)"
owner_token="$(printf '%s' "$login" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
if [ -z "$owner_token" ]; then
  fail "owner login returned no session"
  exit 1
fi
created="$(root_post -H "authorization: Owner $owner_token" \
  -d "{\"password\":\"$owner_pw\",\"id\":\"b1-check\",\"name\":\"B1 check\",\"hosts\":[\"pc\"],\"scopes\":[\"status:read\"]}" \
  http://localhost/v1/owner/clients/create)"
client_token="$(printf '%s' "$created" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
if [ -z "$client_token" ]; then
  fail "client creation returned no token"
  exit 1
fi
agent_home="$(getent passwd "$agent" | cut -d: -f6)"
install -d -m 0700 -o "$agent" -g "$agent" "$agent_home/.config" "$agent_home/.config/homectl"
printf '%s\n' "$client_token" > "$agent_home/.config/homectl/client-token"
chown "$agent:$agent" "$agent_home/.config/homectl/client-token"
chmod 0600 "$agent_home/.config/homectl/client-token"
pass "client b1-check created; token stored in the agent's home only"

# 8. With the client token: agent routes work, owner routes do not.
# The agent presents its own token, read by its own shell from its own home.
token_file="$agent_home/.config/homectl/client-token"
agent_post() {
  as_agent "curl -s --max-time 10 -o /dev/null -w '%{http_code}' --unix-socket '$sock' -X POST \
    -H 'content-type: application/json' -H \"authorization: Bearer \$(cat '$token_file')\" \
    -d '{}' http://localhost$1"
}
code="$(agent_post /v1/whoami)"
if [ "$code" = "200" ]; then pass "client token reaches /v1/whoami (200)"; else
  fail "client token on /v1/whoami answered $code, expected 200"; fi
for owner_route in /v1/owner/clients/list /v1/owner/pending; do
  code="$(agent_post "$owner_route")"
  if [ "$code" = "401" ] || [ "$code" = "403" ]; then
    pass "client token refused on $owner_route ($code)"
  else
    fail "client token on $owner_route answered $code, expected 401 or 403"
  fi
done

if [ "$failures" -ne 0 ]; then
  echo "$failures check(s) failed. Broker log follows:" >&2
  cat "$work/daemon.log" >&2
  exit 1
fi
echo "All hardened Linux checks passed."
