#!/usr/bin/env bash
# Installs hangar-bridge-relay.service as a systemd USER unit.
#
# Designed for openclaw (the relay host). Gentoo doesn't need this — it
# only runs peer-agent, which is a stdio MCP server spawned by Claude
# Code, not a long-running daemon.
#
# Why user-unit instead of system-unit:
#   - Linger=yes on cookys (both hosts) gives us system-unit-like
#     persistence without needing root, and lets us keep the data dir
#     under $HOME so backups + permissions stay simple.
#   - Matches the rest of the hangar fleet's pattern (beellama got
#     promoted to system unit only because it survives loginctl
#     terminate-user; the relay isn't that load-bearing yet).
#
# Usage:
#   packages/operations/systemd/install-relay.sh           # install + reload
#   packages/operations/systemd/install-relay.sh --enable  # install + enable + start
#
# Prereqs:
#   - dist built (`pnpm -r build`)
#   - ~/.config/hangar-bridge/peers.json exists (even `{}` is OK)
#   - Linger=yes for this user (`loginctl show-user $USER | grep Linger`)
#   - port 8443 free on 192.168.101.6

set -euo pipefail

UNIT_NAME="hangar-bridge-relay.service"
UNIT_SRC="$(dirname "$0")/${UNIT_NAME}"
UNIT_DEST_DIR="${HOME}/.config/systemd/user"
UNIT_DEST="${UNIT_DEST_DIR}/${UNIT_NAME}"
PEERS_FILE="${HOME}/.config/hangar-bridge/peers.json"
ENABLE_NOW="${1:-}"

mkdir -p "${UNIT_DEST_DIR}"
mkdir -p "$(dirname "${PEERS_FILE}")"

# Seed an empty peers.json if missing so the relay can boot.
if [[ ! -f "${PEERS_FILE}" ]]; then
  echo '{}' > "${PEERS_FILE}"
  chmod 600 "${PEERS_FILE}"
  echo "Seeded empty ${PEERS_FILE} (mode 600). Add per-peer entries before any peer can authenticate."
fi

cp -f "${UNIT_SRC}" "${UNIT_DEST}"
chmod 644 "${UNIT_DEST}"
echo "Installed: ${UNIT_DEST}"

systemctl --user daemon-reload
echo "daemon-reload: OK"

if [[ "${ENABLE_NOW}" == "--enable" ]]; then
  systemctl --user enable --now "${UNIT_NAME}"
  echo "Enabled + started ${UNIT_NAME}."
  echo ""
  systemctl --user status "${UNIT_NAME}" --no-pager -l | head -20 || true
  echo ""
  for i in 1 2 3 4 5; do
    if curl -sf "http://192.168.101.6:8443/health" -m 2 >/dev/null 2>&1; then
      curl -sf "http://192.168.101.6:8443/health"
      echo ""
      break
    fi
    sleep 1
  done
else
  echo ""
  echo "Unit installed but NOT enabled. To start:"
  echo "  systemctl --user enable --now ${UNIT_NAME}"
  echo "  systemctl --user status ${UNIT_NAME}"
  echo "  curl -sf http://192.168.101.6:8443/health"
fi
