#!/bin/sh
# stdout is exclusively the private OpenSSH askpass channel. Never call this from an agent.
case "$1" in
  *[Pp]assword*) printf '%s\n' "$HOMECTL_SSH_PASSWORD" ;;
  *) exit 1 ;;
esac
