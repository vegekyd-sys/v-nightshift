#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
commit=${1:-HEAD}
output=${2:-"$repo_root/nightshift-workboard-release.tgz"}
stage=$(mktemp -d)

cleanup() {
  rm -rf -- "$stage"
}
trap cleanup EXIT

commit_sha=$(git -C "$repo_root" rev-parse --verify "${commit}^{commit}")
git -C "$repo_root" archive "$commit_sha" | tar -x -C "$stage"

env PATH="${PATH}" npm --prefix "$stage" ci --ignore-scripts
env PATH="${PATH}" npm --prefix "$stage" run dashboard:build
rm -rf -- "$stage/node_modules"
printf '%s\n' "$commit_sha" >"$stage/RELEASE_COMMIT"

tar -czf "$output" -C "$stage" .
sha256sum "$output"
