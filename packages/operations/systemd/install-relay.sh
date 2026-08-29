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
#   packages/operations/systemd/install-relay.sh --revision <40-hex-sha>
#   packages/operations/systemd/install-relay.sh --enable --revision <40-hex-sha>
#   packages/operations/systemd/install-relay.sh --with-nats --revision <40-hex-sha>
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
REVISION_FILE="${HOME}/.config/hangar-bridge/relay.env"
NATS_STATE_DIR="${NATS_STATE_DIR:-/var/lib/hangar-bridge/jetstream}"
PROC_ROOT="${PROC_ROOT:-/proc}"

NATS_UNIT_NAME="hangar-bridge-nats.service"
NATS_UNIT_SRC="$(dirname "$0")/${NATS_UNIT_NAME}"
NATS_UNIT_DEST="${UNIT_DEST_DIR}/${NATS_UNIT_NAME}"

ENABLE_NOW=""
NATS_INSTALL="false"
REVISION=""

usage() {
  cat <<'EOF'
Usage: install-relay.sh [--enable] [--with-nats] --revision <40-hex-sha>

Installs the relay user unit at an exact source revision. --revision is
mandatory. An already-active relay is restarted after the unit and revision
EnvironmentFile are ready. An inactive relay starts only with --enable.
EOF
}

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

while (($# > 0)); do
  case "$1" in
    --enable)
      ENABLE_NOW="--enable"
      shift
      ;;
    --with-nats)
      NATS_INSTALL="true"
      shift
      ;;
    --revision)
      if (($# < 2)) || [[ "$2" == --* ]]; then
        echo "ERROR: --revision requires a 40-hex value." >&2
        usage >&2
        exit 2
      fi
      REVISION="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "${REVISION}" ]]; then
  echo "ERROR: --revision <40-hex-sha> is required." >&2
  usage >&2
  exit 2
fi
if [[ ! "${REVISION}" =~ ^[[:xdigit:]]{40}$ ]]; then
  echo "ERROR: revision must be exactly 40 hexadecimal characters." >&2
  exit 2
fi
REVISION="${REVISION,,}"

for REQUIRED_COMMAND in systemctl curl git grep jq readlink; do
  if ! command -v "${REQUIRED_COMMAND}" >/dev/null 2>&1; then
    echo "ERROR: required command not found: ${REQUIRED_COMMAND}" >&2
    exit 1
  fi
done

if ! NODE_BIN="$(type -P node)" || [[ -z "${NODE_BIN}" || ! -x "${NODE_BIN}" ]]; then
  echo "ERROR: an executable Node.js >=22 binary is required." >&2
  exit 1
fi
NODE_BIN="$(readlink -f -- "${NODE_BIN}")"
if ! NODE_VERSION="$("${NODE_BIN}" --version 2>/dev/null)"; then
  echo "ERROR: Node.js >=22 is required; ${NODE_BIN} could not report its version." >&2
  exit 1
fi
if [[ ! "${NODE_VERSION}" =~ ^v([0-9]+)(\.[0-9]+){1,2}$ ]] || \
  ((10#${BASH_REMATCH[1]:-0} < 22)); then
  echo "ERROR: Node.js >=22 is required; ${NODE_BIN} reported ${NODE_VERSION:-no version}." >&2
  exit 1
fi
NODE_DIR="$(dirname -- "${NODE_BIN}")"
if [[ "${NODE_DIR}" == *:* || "${NODE_DIR}" =~ [[:space:]] ]]; then
  echo "ERROR: Node.js binary directory cannot contain whitespace or ':': ${NODE_DIR}" >&2
  exit 1
fi
if [[ ! -f "${UNIT_SRC}" ]]; then
  echo "ERROR: relay unit source not found: ${UNIT_SRC}" >&2
  exit 1
fi
if ! grep -Fxq 'WorkingDirectory=%h/projects/hangar-bridge' "${UNIT_SRC}"; then
  echo "ERROR: relay unit WorkingDirectory is not the installer-managed repository path." >&2
  exit 1
fi

EXPECTED_REPO_ROOT="${HOME}/projects/hangar-bridge"
if [[ ! -d "${EXPECTED_REPO_ROOT}" ]]; then
  echo "ERROR: relay unit repository does not exist: ${EXPECTED_REPO_ROOT}" >&2
  exit 1
fi
EXPECTED_REPO_ROOT="$(readlink -f -- "${EXPECTED_REPO_ROOT}")"
if [[ -n "${HANGAR_REPO_ROOT:-}" ]]; then
  if [[ ! -d "${HANGAR_REPO_ROOT}" ]]; then
    echo "ERROR: HANGAR_REPO_ROOT is not a directory: ${HANGAR_REPO_ROOT}" >&2
    exit 1
  fi
  REPO_ROOT="$(readlink -f -- "${HANGAR_REPO_ROOT}")"
else
  if ! REPO_ROOT="$(git -C "$(dirname -- "${UNIT_SRC}")" rev-parse --show-toplevel 2>/dev/null)"; then
    echo "ERROR: cannot resolve the source repository for ${UNIT_SRC}." >&2
    exit 1
  fi
  REPO_ROOT="$(readlink -f -- "${REPO_ROOT}")"
fi
if [[ "${REPO_ROOT}" != "${EXPECTED_REPO_ROOT}" ]]; then
  echo "ERROR: installer source ${REPO_ROOT} does not match unit working directory ${EXPECTED_REPO_ROOT}." >&2
  exit 1
fi
if ! REPO_REVISION="$(git -C "${REPO_ROOT}" rev-parse HEAD 2>/dev/null)" || \
  [[ "${REPO_REVISION}" != "${REVISION}" ]]; then
  echo "ERROR: unit working directory HEAD does not match requested revision ${REVISION}." >&2
  exit 1
fi
if [[ "${NATS_INSTALL}" == "true" && ! -f "${NATS_UNIT_SRC}" ]]; then
  echo "ERROR: NATS unit source not found: ${NATS_UNIT_SRC}" >&2
  exit 1
fi

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
    sudo chown "${USER}:${USER}" "${NATS_STATE_DIR}"
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

# Publish source identity atomically before systemd can start or restart the
# service. This file contains no credential, but mode 600 prevents unrelated
# local users from mutating deployment identity through a shared config path.
REVISION_TMP="$(mktemp "${REVISION_FILE}.XXXXXX")"
cleanup_revision_tmp() {
  rm -f "${REVISION_TMP}"
}
trap cleanup_revision_tmp EXIT
printf 'HANGAR_BUILD_REVISION=%s\nPATH=%s:/usr/local/bin:/usr/bin:/bin\n' \
  "${REVISION}" "${NODE_DIR}" > "${REVISION_TMP}"
chmod 600 "${REVISION_TMP}"
mv "${REVISION_TMP}" "${REVISION_FILE}"
trap - EXIT

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

RELAY_ACTIVATED="false"
if systemctl --user is-active --quiet "${UNIT_NAME}"; then
  if [[ "${ENABLE_NOW}" == "--enable" ]]; then
    systemctl --user enable "${UNIT_NAME}"
    echo "Enabled ${UNIT_NAME}."
  fi
  systemctl --user restart "${UNIT_NAME}"
  echo "Restart command completed for ${UNIT_NAME}; verifying revision ${REVISION}."
  RELAY_ACTIVATED="true"
elif [[ "${ENABLE_NOW}" == "--enable" ]]; then
  systemctl --user enable --now "${UNIT_NAME}"
  echo "Enable/start command completed for ${UNIT_NAME}; verifying revision ${REVISION}."
  RELAY_ACTIVATED="true"
fi

if [[ "${RELAY_ACTIVATED}" == "true" ]]; then
  echo ""
  systemctl --user status "${UNIT_NAME}" --no-pager -l --lines=20

  if [[ "${NATS_INSTALL}" == "true" && "${ENABLE_NOW}" == "--enable" ]]; then
    systemctl --user enable --now "${NATS_UNIT_NAME}"
    echo "Enabled + started ${NATS_UNIT_NAME}."
    echo ""
    systemctl --user status "${NATS_UNIT_NAME}" --no-pager -l --lines=20
  fi

  echo ""
  HEALTH_VERIFIED="false"
  for _ in 1 2 3 4 5; do
    if HEALTH_JSON="$(curl -sf "http://192.168.101.6:8443/health" -m 2 2>/dev/null)"; then
      HEALTH_REVISION=""
      if PARSED_REVISION="$(printf '%s\n' "${HEALTH_JSON}" | \
        jq -er '.build_revision | select(type == "string")' 2>/dev/null)"; then
        HEALTH_REVISION="${PARSED_REVISION}"
      fi
      if [[ "${HEALTH_REVISION}" == "${REVISION}" ]]; then
        printf '%s\n' "${HEALTH_JSON}"
        echo "Verified ${UNIT_NAME} at revision ${REVISION}."
        HEALTH_VERIFIED="true"
        break
      fi
    fi
    sleep 1
  done

  if [[ "${HEALTH_VERIFIED}" != "true" ]]; then
    echo "ERROR: relay health did not report requested build revision ${REVISION}." >&2
    exit 1
  fi

  if ! MAIN_PID="$(systemctl --user show --property MainPID --value "${UNIT_NAME}")" || \
    [[ ! "${MAIN_PID}" =~ ^[1-9][0-9]*$ ]]; then
    echo "ERROR: cannot resolve the running relay MainPID." >&2
    exit 1
  fi
  if ! PROCESS_CWD="$(readlink -f -- "${PROC_ROOT}/${MAIN_PID}/cwd" 2>/dev/null)" || \
    [[ "${PROCESS_CWD}" != "${REPO_ROOT}" ]]; then
    echo "ERROR: running relay working directory does not match deployed repository ${REPO_ROOT}." >&2
    exit 1
  fi
  echo "Verified ${UNIT_NAME} process working directory at requested revision ${REVISION}."
else
  echo ""
  echo "Unit installed but NOT enabled. To start:"
  echo "  systemctl --user enable --now ${UNIT_NAME}"
  echo "  systemctl --user status ${UNIT_NAME}"
  echo "  curl -sf http://192.168.101.6:8443/health  # build_revision must be ${REVISION}"

  if [[ "${NATS_INSTALL}" == "true" ]]; then
    echo ""
    echo "NATS unit installed but NOT enabled. To start:"
    echo "  systemctl --user enable --now ${NATS_UNIT_NAME}"
    echo "  systemctl --user status ${NATS_UNIT_NAME}"
  fi
fi
