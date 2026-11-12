#!/bin/sh
# Installs the built Linux packages in clean containers and runs homectl in each.
# A package passes when it installs, homectl help exits 0, and an unknown internal
# command exits 2 (the same check as the release smoke test).
#   sh scripts/smoke-packages.sh <dist directory> [version]
# Needs Docker. rpm and pacman are not tested here: see scripts/build-packages.ts.
set -eu

dist="$(cd "$1" && (pwd -W 2>/dev/null || pwd))"
version="${2:-$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' package.json | head -1)}"
test -n "$version"

check='
  homectl help >/tmp/help.txt 2>&1 || { echo "homectl help failed"; cat /tmp/help.txt; exit 1; }
  head -1 /tmp/help.txt
  code=0; homectl __internal bogus >/dev/null 2>&1 || code=$?
  test "$code" -eq 2 || { echo "bogus exit $code, expected 2"; exit 1; }
'

echo "== deb (Debian 12, glibc)"
docker run --rm -e VERSION="$version" -v "$dist:/pkg:ro" debian:12-slim sh -c '
  set -e
  apt-get update -qq >/dev/null
  cp "/pkg/homectl_${VERSION}_amd64.deb" /tmp/homectl.deb
  apt-get install -y -qq --no-install-recommends /tmp/homectl.deb >/tmp/install.log 2>&1 \
    || { tail -20 /tmp/install.log; exit 1; }
  echo "installed $(dpkg -s homectl | grep ^Version)"
  '"$check"'
'

echo "== apk (Alpine 3.20, musl)"
docker run --rm -e VERSION="$version" -v "$dist:/pkg:ro" alpine:3.20 sh -c '
  set -e
  apk add --no-cache --allow-untrusted "/pkg/homectl_${VERSION}_x86_64.apk" >/tmp/install.log 2>&1 \
    || { tail -20 /tmp/install.log; exit 1; }
  echo "installed homectl $(apk info -e homectl >/dev/null && echo ok)"
  '"$check"'
'

echo "Linux package smoke tests passed for $version"
