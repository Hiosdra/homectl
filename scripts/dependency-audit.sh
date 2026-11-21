#!/bin/sh
# Fails on high or critical advisories in the installed dependency tree (bun audit), except
# the advisories listed in scripts/audit-accepted.txt. Adding to that list is a decision for
# the owner; the list may only shrink without review.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
set --
while IFS= read -r line; do
  id="${line%%#*}"
  id="$(printf '%s' "$id" | tr -d ' \t\r')"
  if [ -n "$id" ]; then set -- "$@" "--ignore=$id"; fi
done < "$here/audit-accepted.txt"
echo "Accepted advisories: $#"
exec bun audit --audit-level=high "$@"
