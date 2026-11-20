#!/bin/sh
# Lints the non-TypeScript files (homelab #21 supply chain): shell scripts,
# GitHub workflows and the Dockerfile, with the pinned tools below.
# Uses a local binary when present, otherwise the pinned official image through
# Docker. Formatting of these files is `bun fmt` (see .prettierignore).
set -eu
cd "$(dirname "$0")/.."

SHELLCHECK_IMAGE="koalaman/shellcheck:v0.11.0"
ACTIONLINT_IMAGE="rhysd/actionlint:1.7.12"
HADOLINT_IMAGE="hadolint/hadolint:v2.15.1"

# Git Bash on Windows rewrites /repo-style arguments without this.
export MSYS_NO_PATHCONV=1
repo="$(pwd -W 2>/dev/null || pwd)"

run() { # run <binary> <image> <args...>
  bin="$1"
  image="$2"
  shift 2
  if command -v "$bin" >/dev/null 2>&1; then
    "$bin" "$@"
  elif command -v docker >/dev/null 2>&1; then
    docker run --rm --network none -v "$repo:/repo:ro" -w /repo "$image" "$@"
  else
    echo "lint-other: neither $bin nor docker is available" >&2
    return 1
  fi
}

shell_files="$(git ls-files '*.sh' .githooks)"
echo "shellcheck: $(echo "$shell_files" | wc -w | tr -d ' ') files"
# shellcheck disable=SC2086 # word splitting of the file list is intended
run shellcheck "$SHELLCHECK_IMAGE" $shell_files

echo "actionlint: .github/workflows"
run actionlint "$ACTIONLINT_IMAGE" -no-color

echo "hadolint: Dockerfile"
if command -v hadolint >/dev/null 2>&1; then
  hadolint Dockerfile
else
  # The image's entrypoint is hadolint and it reads the file from stdin.
  docker run --rm --network none -i "$HADOLINT_IMAGE" hadolint - <Dockerfile
fi
echo "lint-other: OK"
