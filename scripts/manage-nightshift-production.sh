#!/usr/bin/env bash
set -euo pipefail

release_root=/home/openclaw/releases/nightshift-workboard
state_root=/home/openclaw/.openclaw/nightshift
backup_root=/home/openclaw/.openclaw/backups/nightshift-workboard
service_name=nightshift-workboard.service
service_path=/etc/systemd/system/nightshift-workboard.service
cli_path=/home/openclaw/.local/bin/nightshiftctl

wait_for_health() {
  local attempts=15
  local delay_seconds=2
  local attempt
  for ((attempt = 1; attempt <= attempts; attempt++)); do
    if curl -fsS --max-time 10 http://127.0.0.1:24879/api/health >/dev/null; then
      return 0
    fi
    sleep "$delay_seconds"
  done
  echo "Night Shift Workboard did not become healthy after $((attempts * delay_seconds)) seconds" >&2
  return 1
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
    if [[ ! -f "$artifact" || ! "$expected_sha" =~ ^[a-f0-9]{64}$ || ! "$release_id" =~ ^[a-f0-9]{7,64}$ || ( -n "$mode" && "$mode" != "--code-only" ) ]]; then
      echo "Usage: $0 deploy <artifact.tgz> <sha256> <release-id> [--code-only]" >&2
      exit 2
    fi
    # --code-only skips the state snapshot. The Night Shift data directory holds
    # tens of gigabytes of instance media; copying it stops scheduling for
    # minutes and doubles disk use. Use it only for releases without a schema
    # change, where rollback needs the previous code and service unit alone.
    echo "$expected_sha  $artifact" | sha256sum -c -
    if ! tar -tzf "$artifact" | grep -Ex '^\.?/?apps/nightshift-dashboard/dist/index\.html$' >/dev/null; then
      echo "Release artifact is missing apps/nightshift-dashboard/dist/index.html" >&2
      exit 1
    fi
    timestamp=$(date -u +%Y%m%dT%H%M%SZ)
    backup="$backup_root/$timestamp-$release_id"
    release="$release_root/$release_id"
    if [[ ! -f /home/openclaw/.config/nightshift/public-auth.json ]]; then
      echo "Missing /home/openclaw/.config/nightshift/public-auth.json" >&2
      exit 1
    fi
    if [[ -e "$release" ]]; then
      echo "Immutable release already exists: $release" >&2
      exit 1
    fi
    install -d -o openclaw -g openclaw -m 700 "$backup" "$release" "$release_root" "$backup_root" "$state_root"
    if [[ -L "$release_root/current" ]]; then
      readlink -f "$release_root/current" >"$backup/current.before"
    fi
    if [[ -f "$service_path" ]]; then
      cp -a "$service_path" "$backup/service.before"
    fi
    was_active=0
    if systemctl is-active --quiet "$service_name"; then
      was_active=1
      systemctl stop "$service_name"
    fi
    if [[ "$mode" == "--code-only" ]]; then
      printf '%s\n' "$release_id" >"$backup/code-only"
    elif [[ -d "$state_root" ]]; then
      cp -a "$state_root" "$backup/state.before"
    fi
    sudo -u openclaw tar -xzf "$artifact" -C "$release"
    sudo -u openclaw env PATH=/opt/node-v22.23.1/bin:/usr/local/bin:/usr/bin:/bin \
      /opt/node-v22.23.1/bin/npm --prefix "$release" ci --omit=dev --ignore-scripts
    install -o root -g root -m 644 "$release/systemd/nightshift-workboard.service" "$service_path"
    ln -sfn "$release" "$release_root/current"
    install -d -o openclaw -g openclaw -m 755 "$(dirname "$cli_path")"
    ln -sfn "$release/scripts/nightshiftctl.mjs" "$cli_path"
    systemctl daemon-reload
    systemctl enable --now "$service_name"
    wait_for_health
    # The script usually runs from a temporary extraction; name the copy that
    # stays installed with the release.
    printf '%s\n' "deployed=$release" "backup=$backup" "rollback=sudo bash $release/scripts/manage-nightshift-production.sh rollback $backup"
    ;;
  rollback)
    backup=${2:-}
    if [[ ! "$backup" =~ ^/home/openclaw/\.openclaw/backups/nightshift-workboard/[A-Za-z0-9._-]+$ || ! -d "$backup" ]]; then
      echo "Usage: $0 rollback <validated-backup-directory>" >&2
      exit 2
    fi
    timestamp=$(date -u +%Y%m%dT%H%M%SZ)
    systemctl stop "$service_name" || true
    # Only a backup that captured state may replace the live state directory.
    # A code-only backup restores the previous release and unit and keeps the
    # data directory exactly as it is.
    if [[ -d "$backup/state.before" ]]; then
      if [[ -d "$state_root" ]]; then
        mv "$state_root" "$state_root.failed-$timestamp"
      fi
      cp -a "$backup/state.before" "$state_root"
      chown -R openclaw:openclaw "$state_root"
    fi
    if [[ -f "$backup/service.before" ]]; then
      cp -a "$backup/service.before" "$service_path"
    fi
    if [[ -s "$backup/current.before" ]]; then
      previous=$(cat "$backup/current.before")
      if [[ ! "$previous" =~ ^/home/openclaw/releases/nightshift-workboard/[A-Za-z0-9._-]+$ || ! -d "$previous" ]]; then
        echo "Invalid previous release in backup" >&2
        exit 1
      fi
      ln -sfn "$previous" "$release_root/current"
      ln -sfn "$previous/scripts/nightshiftctl.mjs" "$cli_path"
      systemctl daemon-reload
      systemctl start "$service_name"
      wait_for_health
      echo "rolled_back=$previous"
    else
      systemctl disable "$service_name" || true
      echo "rolled_back=service-disabled-no-previous-release"
    fi
    ;;
  *)
    echo "Usage: $0 deploy <artifact.tgz> <sha256> <release-id> | rollback <backup-directory>" >&2
    exit 2
    ;;
esac
