#!/usr/bin/env bash
# Package one merged commit and deploy it to the shared VLab or to V. The same
# command works from a Mac and from V itself (docs/change-flow.md).
#
#   scripts/ship.sh vlab <commit> [--start]           shared VLab Night Shift
#   scripts/ship.sh v    <commit> [--with-state-backup]  V, then align the VLab
#
# It refuses a commit that is not on origin/main or whose CI is not green: a
# release is always an exact, reviewed, merged commit. On V it deploys code
# only (--code-only) unless asked to snapshot the state for a schema change,
# and it fails loudly if the Gateway process changed: Night Shift releases
# never restart the Gateway.
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
repo_slug=vegekyd-sys/v-nightshift
vlab_ssh=${NIGHTSHIFT_VLAB_SSH:-vlab91}
v_ssh=${NIGHTSHIFT_V_SSH:-v}
v_hostname=${NIGHTSHIFT_V_HOSTNAME:-VM-8-2-ubuntu}

die() {
  echo "ship: $*" >&2
  exit 1
}

target=${1:-}
commit=${2:-}
option=${3:-}
case "$target:$option" in
  vlab: | vlab:--start | v: | v:--with-state-backup) ;;
  *) die "usage: scripts/ship.sh vlab <commit> [--start] | v <commit> [--with-state-backup]" ;;
esac
[[ -n "$commit" ]] || die "which commit?"

git -C "$repo_root" fetch -q origin main
sha=$(git -C "$repo_root" rev-parse --verify "$commit^{commit}")
git -C "$repo_root" merge-base --is-ancestor "$sha" origin/main ||
  die "$sha is not on origin/main. Merge the PR first, and only after Tianyi says so."

runs=$(gh api "repos/$repo_slug/commits/$sha/check-runs" --jq '.check_runs | length')
[[ "$runs" -gt 0 ]] || die "no CI run for $sha yet; wait for it"
not_green=$(gh api "repos/$repo_slug/commits/$sha/check-runs" \
  --jq '[.check_runs[] | select(.status != "completed" or .conclusion != "success") | "\(.name): \(.status)/\(.conclusion)"] | join(", ")')
[[ -z "$not_green" ]] || die "CI is not green for $sha: $not_green"

# Commands run over SSH, or directly when this is the host itself (V has no
# SSH route to itself).
host_for() {
  if [[ "$1" == v && "$(hostname)" == "$v_hostname" ]]; then
    echo local
  elif [[ "$1" == v ]]; then
    echo "$v_ssh"
  else
    echo "$vlab_ssh"
  fi
}
on() {
  local host=$1
  shift
  if [[ "$host" == local ]]; then bash -c "$*"; else ssh -o ConnectTimeout=20 "$host" "$*"; fi
}
put() {
  if [[ "$1" == local ]]; then cp "$2" "$3"; else scp -q -o ConnectTimeout=20 "$2" "$1:$3"; fi
}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
artifact=$work/nightshift-${sha:0:7}.tgz
echo "ship: packaging $sha"
if ! bash "$repo_root/scripts/package-nightshift-release.sh" "$sha" "$artifact" >"$work/package.log" 2>&1; then
  tail -20 "$work/package.log" >&2
  die "packaging failed"
fi
digest=$( (sha256sum "$artifact" 2>/dev/null || shasum -a 256 "$artifact") | cut -c1-64)
echo "ship: artifact sha256=$digest"

# deploy_to <vlab|v> <manage-script argument...>
deploy_to() {
  local where=$1
  shift
  local host script remote
  host=$(host_for "$where")
  script=manage-nightshift-production.sh
  [[ "$where" == vlab ]] && script=manage-nightshift-vlab.sh
  remote=/tmp/nightshift-${sha:0:7}-$$.tgz
  put "$host" "$artifact" "$remote"
  # The manage script comes from the release itself, so it always matches it.
  on "$host" "chmod 644 $remote; d=\$(mktemp -d); tar -xzf $remote -C \$d --wildcards '*scripts/$script'; sudo -n bash \$d/scripts/$script deploy $remote $digest $sha $*; rc=\$?; rm -rf \$d $remote; exit \$rc"
}

if [[ "$target" == vlab ]]; then
  echo "ship: deploying to the shared VLab"
  deploy_to vlab $option
  exit 0
fi

host=$(host_for v)
# A restart begun just before the deploy still changes the PID read below.
look_back_from=$(on "$host" "date -d '-2 min' '+%Y-%m-%d %H:%M:%S'")
gateway_before=$(on "$host" "systemctl show openclaw-gateway -p MainPID --value")
mode=--code-only
[[ "$option" == --with-state-backup ]] && mode=
echo "ship: deploying to V ($host) ${mode:-with a state backup}"
deploy_to v $mode
gateway_after=$(on "$host" "systemctl show openclaw-gateway -p MainPID --value")
if [[ "$gateway_before" != "$gateway_after" ]]; then
  # On 2026-10-02 another session on the same Mac restarted the Gateway four
  # seconds before a deploy began. Show who did, so a collision is told apart
  # from a deploy that touched the Gateway.
  on "$host" "sudo -n journalctl --since '$look_back_from' --no-pager -o short-iso | grep -E 'COMMAND=.*systemctl (restart|stop|kill) openclaw-gateway|Stopping openclaw-gateway' | tail -5" >&2 || true
  die "the Gateway process changed ($gateway_before -> $gateway_after). Night Shift never restarts it; the lines above show who did. Wait for the Gateway and Night Shift to recover (nightshiftctl health), then align the VLab: scripts/ship.sh vlab $sha"
fi
# Health reads ok only after the first scheduler pass, a few seconds after start.
health=$(on "$host" "for i in \$(seq 1 36); do h=\$(curl -fsS --max-time 10 http://127.0.0.1:24879/api/health 2>/dev/null) && echo \"\$h\" | grep -q '\"ok\":true' && break; sleep 5; done; echo \"\$h\"")
node -e '
const h = JSON.parse(process.argv[1]);
if (!h.ok || !h.gatewayConnected) { console.error("ship: V Night Shift is not healthy:", JSON.stringify({ ok: h.ok, gatewayConnected: h.gatewayConnected, lastSchedulerError: h.lastSchedulerError })); process.exit(1); }
console.log("ship: V healthy, Gateway connected, Gateway PID unchanged");
' "$health"

# The shared VLab equals V, or V plus the one release on its way: align it.
echo "ship: aligning the shared VLab with V"
deploy_to vlab || echo "ship: VLab not aligned. Run: scripts/ship.sh vlab $sha" >&2
