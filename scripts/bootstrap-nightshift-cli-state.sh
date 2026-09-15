#!/usr/bin/env bash
set -euo pipefail

source_state="/srv/vlab-browser/state"
private_state="/srv/vlab-browser/nightshift/openclaw-state"

install -d -m 700 "$private_state" "$private_state/identity" "$private_state/state"
install -m 600 "$source_state/identity/device.json" "$private_state/identity/device.json"
install -m 600 "$source_state/identity/device-auth.json" "$private_state/identity/device-auth.json"

for directory in extensions plugins plugin-skills; do
  if [[ -e "$private_state/$directory" && ! -L "$private_state/$directory" ]]; then
    echo "Refusing to replace non-symlink path: $private_state/$directory" >&2
    exit 1
  fi
  ln -sfn "$source_state/$directory" "$private_state/$directory"
done
