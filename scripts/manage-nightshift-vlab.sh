#!/usr/bin/env bash
# The shared VLab's Night Shift, managed the way manage-nightshift-production.sh
# manages V's. Runs on the VLab host as root.
#
# The VLab Night Shift runs on a copy of production data against the shared
# VLab Gateway. Projects active in that copy resume as soon as it starts, with
# real model and media credentials, so it stays stopped between tests:
# `deploy` installs a release without starting it (it restarts it only if it
# is already running), and `start` refuses while any project is active unless
# told those may run. `pause` and `pause-active` pause projects while it is
# stopped, through the release's own store (the same update as the pause API).
set -euo pipefail

base=/srv/vlab-production-mirror/labs/instances/db91-parity
release_root=$base/nightshift-releases
backup_root=$release_root/dropin-backups
service_name=nightshift-vlab-production-mirror.service
dropin_dir=/etc/systemd/system/$service_name.d
release_dropin=$dropin_dir/99-release.conf
node_bin=/opt/vlab/node-v22.23.1-linux-x64/bin
service_user=lab-db91-parity
state_db=$base/state/nightshift-native/nightshift.sqlite
health_url=http://127.0.0.1:24980/api/health

usage() {
  echo "Usage: $0 deploy <artifact.tgz> <sha256> <release-id> [--start] | start [--with-active] | stop | status | pause <project-id>... | pause-active | rollback <backup-directory>" >&2
  exit 2
}

wait_for_health() {
  local attempt
  for ((attempt = 1; attempt <= 60; attempt++)); do
    if curl -fsS --max-time 5 "$health_url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  echo "VLab Night Shift did not become healthy after 120 seconds" >&2
  systemctl show "$service_name" -p ActiveState -p NRestarts --no-pager >&2
  return 1
}

current_release() {
  systemctl show "$service_name" -p WorkingDirectory --value
}

active_projects() {
  sqlite3 -readonly "$state_db" "select id || '  ' || updated_at from instances where status = 'active' order by updated_at desc;" 2>/dev/null || true
}

show_active_projects() {
  local projects
  projects=$(active_projects)
  if [[ -n "$projects" ]]; then
    echo "Projects active in the VLab data (they resume when the service runs):"
    printf '%s\n' "$projects" | sed 's/^/  /'
  else
    echo "No project is active in the VLab data."
  fi
}

# Starting resumes every active project. Refuse unless the caller said so.
guard_active() {
  local projects
  projects=$(active_projects)
  [[ -z "$projects" || "${1:-}" == "--with-active" ]] && return 0
  show_active_projects
  echo "Refusing to start: these would resume and dispatch real work. Pause the ones this test does not need (sudo $0 pause <id>... or sudo $0 pause-active), or start with --with-active." >&2
  exit 1
}

pause_projects() {
  if systemctl is-active --quiet "$service_name"; then
    echo "The service is running: pause through its API instead (NIGHTSHIFT_URL=http://127.0.0.1:24980 nightshiftctl projects pause <id>)." >&2
    exit 1
  fi
  local release
  release=$(current_release)
  sudo -u "$service_user" "$node_bin/node" --no-warnings --input-type=module -e '
    import { NightShiftStore } from "'"$release"'/packages/nightshift-core/src/index.mjs";
    const store = new NightShiftStore(process.argv[1]);
    for (const id of process.argv.slice(2)) {
      const instance = store.getInstance(id);
      if (!instance) console.error(`unknown project ${id}`);
      else if (instance.status !== "active") console.log(`${id} is ${instance.status}`);
      else console.log(`paused ${store.updateInstanceStatus(id, "paused").id}`);
    }
    store.close();
  ' "$state_db" "$@"
}

if [[ ${EUID} -ne 0 ]]; then
  echo "Run as root" >&2
  exit 2
fi

case "${1:-}" in
  deploy)
    artifact=${2:-}
    expected_sha=${3:-}
    release_id=${4:-}
    mode=${5:-}
    if [[ ! -f "$artifact" || ! "$expected_sha" =~ ^[a-f0-9]{64}$ || ! "$release_id" =~ ^[a-f0-9]{7,64}$ || ( -n "$mode" && "$mode" != "--start" ) ]]; then
      usage
    fi
    echo "$expected_sha  $artifact" | sha256sum -c -
    if ! tar -tzf "$artifact" | grep -Ex '^\.?/?apps/nightshift-dashboard/dist/index\.html$' >/dev/null; then
      echo "Release artifact is missing apps/nightshift-dashboard/dist/index.html" >&2
      exit 1
    fi
    release=$release_root/$release_id
    if [[ -e "$release" ]]; then
      # A release directory is immutable; the same commit may be installed again.
      if [[ "$(cat "$release/RELEASE_COMMIT" 2>/dev/null)" != "$release_id" ]]; then
        echo "Release directory exists with other contents: $release" >&2
        exit 1
      fi
      echo "Release already installed: $release"
    else
      install -d -o "$service_user" -g "$service_user" -m 755 "$release"
      sudo -u "$service_user" tar -xzf "$artifact" -C "$release"
      sudo -u "$service_user" env HOME="$base" PATH="$node_bin:/usr/local/bin:/usr/bin:/bin" \
        "$node_bin/npm" --prefix "$release" ci --omit=dev --ignore-scripts --no-audit --no-fund
    fi
    sudo -u "$service_user" "$node_bin/node" --check "$release/apps/nightshift-dashboard/server/index.mjs"

    timestamp=$(date -u +%Y%m%dT%H%M%SZ)
    backup=$backup_root/$timestamp-${release_id:0:7}
    install -d -m 755 "$backup"
    current_release >"$backup/release.before"
    # Every drop-in that chose a release before this script existed moves into
    # the backup, so exactly one drop-in names the running release.
    for dropin in "$dropin_dir"/99-*.conf; do
      [[ -e "$dropin" ]] || continue
      mv "$dropin" "$backup/"
    done
    # The seed Workflow is read from the release too. On 2026-10-02 an older
    # drop-in still named one from a September release, which the current
    # validator refuses, and the service crash-looped on start.
    workflow_name=$(basename "$(systemctl show "$service_name" -p Environment --value | tr ' ' '\n' | sed -n 's/^NIGHTSHIFT_WORKFLOW_PATH=//p' | tail -1)")
    [[ -f "$release/examples/workflows/$workflow_name" ]] || workflow_name=xingqing-content-delivery.workflow.md
    cat >"$release_dropin" <<CONF
[Service]
WorkingDirectory=$release
Environment=NIGHTSHIFT_WORKFLOW_PATH=$release/examples/workflows/$workflow_name
ExecStart=
ExecStart=$node_bin/node --no-warnings $release/apps/nightshift-dashboard/server/index.mjs
CONF
    systemctl daemon-reload
    if systemctl is-active --quiet "$service_name" || [[ "$mode" == "--start" ]]; then
      systemctl is-active --quiet "$service_name" || guard_active
      show_active_projects
      systemctl restart "$service_name"
      wait_for_health
      echo "running=$release"
    else
      echo "installed=$release (not started; start it for a test with: sudo bash $release/scripts/manage-nightshift-vlab.sh start)"
    fi
    # The script usually runs from a temporary extraction; name the copy that
    # stays installed with the release.
    printf '%s\n' "backup=$backup" "rollback=sudo bash $release/scripts/manage-nightshift-vlab.sh rollback $backup"
    ;;
  start)
    guard_active "${2:-}"
    show_active_projects
    systemctl start "$service_name"
    wait_for_health
    echo "running=$(current_release)"
    ;;
  stop)
    systemctl stop "$service_name"
    echo "stopped=$(current_release)"
    ;;
  status)
    echo "release=$(current_release)"
    systemctl show "$service_name" -p ActiveState -p NRestarts --no-pager
    if systemctl is-active --quiet "$service_name"; then
      curl -fsS --max-time 5 "$health_url" | head -c 400
      echo
    fi
    show_active_projects
    ;;
  pause)
    shift
    [[ $# -gt 0 ]] || usage
    pause_projects "$@"
    ;;
  pause-active)
    mapfile -t ids < <(sqlite3 -readonly "$state_db" "select id from instances where status = 'active';")
    [[ ${#ids[@]} -gt 0 ]] || { echo "No project is active."; exit 0; }
    pause_projects "${ids[@]}"
    ;;
  rollback)
    backup=${2:-}
    if [[ ! -d "$backup" || ! -f "$backup/release.before" ]]; then
      usage
    fi
    rm -f "$release_dropin"
    for dropin in "$backup"/99-*.conf; do
      [[ -e "$dropin" ]] || continue
      cp -a "$dropin" "$dropin_dir/"
    done
    systemctl daemon-reload
    if systemctl is-active --quiet "$service_name"; then
      systemctl restart "$service_name"
      wait_for_health
    fi
    echo "release=$(current_release) (expected $(cat "$backup/release.before"))"
    ;;
  *)
    usage
    ;;
esac
