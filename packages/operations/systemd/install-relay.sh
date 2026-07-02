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
#   packages/operations/systemd/install-relay.sh                # install + reload
#   packages/operations/systemd/install-relay.sh --enable       # install + enable + start
#   packages/operations/systemd/install-relay.sh --with-nats    # also install/reload nats unit
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
NATS_STATE_DIR="/var/lib/hangar-bridge/jetstream"

NATS_UNIT_NAME="hangar-bridge-nats.service"
NATS_UNIT_SRC="$(dirname "$0")/${NATS_UNIT_NAME}"
NATS_UNIT_DEST="${UNIT_DEST_DIR}/${NATS_UNIT_NAME}"

ENABLE_NOW=""
NATS_INSTALL="false"

reload_nats_unit_if_running() {
  if systemctl --user is-active --quiet "${NATS_UNIT_NAME}"; then
    if systemctl --user reload "${NATS_UNIT_NAME}" >/dev/null 2>&1; then
      echo "Reloaded: ${NATS_UNIT_NAME}"
    else
      systemctl --user restart "${NATS_UNIT_NAME}"
      echo "Restarted: ${NATS_UNIT_NAME}"
    fi
    return
  fi

  if systemctl --user is-enabled "${NATS_UNIT_NAME}" >/dev/null 2>&1; then
    systemctl --user restart "${NATS_UNIT_NAME}"
    echo "Restarted (enabled): ${NATS_UNIT_NAME}"
  fi
}

for ARG in "$@"; do
  case "${ARG}" in
    --enable) ENABLE_NOW="--enable" ;;
    --with-nats) NATS_INSTALL="true" ;;
  esac
done

mkdir -p "${UNIT_DEST_DIR}"
mkdir -p "$(dirname "${PEERS_FILE}")"

ensure_nats_state_dir() {
  if [[ "${NATS_INSTALL}" != "true" ]]; then
    return
  fi

  if [[ -d "${NATS_STATE_DIR}" && -w "${NATS_STATE_DIR}" ]]; then
    return
  fi

  if command -v sudo >/dev/null 2>&1; then
    sudo mkdir -p "${NATS_STATE_DIR}"
    sudo chmod 700 "${NATS_STATE_DIR}"
    sudo chown "${USER}:${USER}" "${NATS_STATE_DIR}" || true
  else
    mkdir -p "${NATS_STATE_DIR}"
  fi

  if [[ ! -d "${NATS_STATE_DIR}" || ! -w "${NATS_STATE_DIR}" ]]; then
    echo "ERROR: cannot create or write ${NATS_STATE_DIR}." >&2
    echo "Create it as root or with sufficient privileges before enabling hangar-bridge-nats.service." >&2
    exit 1
  fi
}

# Seed an empty peers.json if missing so the relay can boot.
if [[ ! -f "${PEERS_FILE}" ]]; then
  echo '{}' > "${PEERS_FILE}"
  chmod 600 "${PEERS_FILE}"
  echo "Seeded empty ${PEERS_FILE} (mode 600). Add per-peer entries before any peer can authenticate."
fi

cp -f "${UNIT_SRC}" "${UNIT_DEST}"
chmod 644 "${UNIT_DEST}"
echo "Installed: ${UNIT_DEST}"

if [[ "${NATS_INSTALL}" == "true" ]]; then
  ensure_nats_state_dir
  cp -f "${NATS_UNIT_SRC}" "${NATS_UNIT_DEST}"
  chmod 644 "${NATS_UNIT_DEST}"
  echo "Installed: ${NATS_UNIT_DEST}"
fi

# daemon-reload MUST run before reloading/restarting any unit, so systemd picks
# up the freshly-copied unit files rather than stale metadata (R5 ordering fix).
systemctl --user daemon-reload
echo "daemon-reload: OK"

if [[ "${NATS_INSTALL}" == "true" ]]; then
  reload_nats_unit_if_running
fi

if [[ "${ENABLE_NOW}" == "--enable" ]]; then
  systemctl --user enable --now "${UNIT_NAME}"
  echo "Enabled + started ${UNIT_NAME}."
  echo ""
  systemctl --user status "${UNIT_NAME}" --no-pager -l | head -20 || true

  if [[ "${NATS_INSTALL}" == "true" ]]; then
    systemctl --user enable --now "${NATS_UNIT_NAME}"
    echo "Enabled + started ${NATS_UNIT_NAME}."
    echo ""
    systemctl --user status "${NATS_UNIT_NAME}" --no-pager -l | head -20 || true
  fi

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

  if [[ "${NATS_INSTALL}" == "true" ]]; then
    echo ""
    echo "NATS unit installed but NOT enabled. To start:"
    echo "  systemctl --user enable --now ${NATS_UNIT_NAME}"
    echo "  systemctl --user status ${NATS_UNIT_NAME}"
  fi
fi
