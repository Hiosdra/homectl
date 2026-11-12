#!/bin/sh
# Installs the built Linux packages in clean containers and runs home-ctl in each.
# A package passes when it installs, home-ctl help exits 0, and an unknown internal
# command exits 2 (the same check as the release smoke test). On Fedora and Arch it also
# checks that no repository package already provides /usr/bin/home-ctl.
#   sh scripts/smoke-packages.sh <dist directory> [version]
# Needs Docker. Tests the amd64 packages; the arm64 packages are built but not run here.
set -eu

dist="$(cd "$1" && (pwd -W 2>/dev/null || pwd))"
version="${2:-$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' package.json | head -1)}"
test -n "$version"

check='
  home-ctl help >/tmp/help.txt 2>&1 || { echo "home-ctl help failed"; cat /tmp/help.txt; exit 1; }
  head -1 /tmp/help.txt
  code=0; home-ctl __internal bogus >/dev/null 2>&1 || code=$?
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

echo "== rpm (Fedora 41, glibc)"
docker run --rm -e VERSION="$version" -v "$dist:/pkg:ro" fedora:41 sh -c '
  set -e
  if dnf -q provides /usr/bin/home-ctl >/tmp/provides.txt 2>&1 && [ -s /tmp/provides.txt ]; then
    echo "conflict: a repository package provides /usr/bin/home-ctl"; cat /tmp/provides.txt; exit 1
  fi
  pkg=$(ls /pkg/homectl-"${VERSION}"-*.x86_64.rpm)
  dnf install -y -q "$pkg" >/tmp/install.log 2>&1 || { tail -20 /tmp/install.log; exit 1; }
  echo "installed $(rpm -q homectl)"
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

echo "== pacman (Arch, glibc)"
docker run --rm -e VERSION="$version" -v "$dist:/pkg:ro" archlinux:base sh -c '
  set -e
  pacman -Syu --noconfirm >/tmp/sync.log 2>&1 || { tail -20 /tmp/sync.log; exit 1; }
  pacman -Fy >/dev/null 2>&1 || true
  if pacman -F /usr/bin/home-ctl 2>/dev/null | grep -q .; then
    echo "conflict: a repository package provides /usr/bin/home-ctl"; exit 1
  fi
  pkg=$(ls /pkg/homectl-"${VERSION}"-*-x86_64.pkg.tar.zst)
  pacman -U --noconfirm "$pkg" >/tmp/install.log 2>&1 || { tail -20 /tmp/install.log; exit 1; }
  echo "installed $(pacman -Q homectl)"
  '"$check"'
'

echo "Linux package smoke tests passed for $version"
