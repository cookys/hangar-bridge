#!/usr/bin/env sh

set -eu

NATS_BIN="${NATS_BIN:-${HOME}/.local/bin/nats}"
NKEYS_DIR="${HOME}/.config/hangar-bridge/nats"
FORCE_OVERWRITE=0

if [ "${1:-}" = "--force" ]; then
  FORCE_OVERWRITE=1
  shift
fi

TARGET_HANDLE="${1:-}"

if [ "$#" -gt 1 ]; then
  echo "ERROR: expected at most one handle." >&2
  exit 1
fi

# Public NKeys are committed in nats-server.conf; private seed material is
# generated per-host and stored in ~/.config/hangar-bridge/nats/<handle>.nk
# with mode 0600. Never commit seeds.
if [ "${TARGET_HANDLE}" = "--help" ]; then
  echo "Usage: $(basename "$0") [--force] [handle]" >&2
  echo "  Generates a user NKey pair and prints seed + public key." >&2
  echo "  If [handle] is set, stores ~/.config/hangar-bridge/nats/<handle>.nk (mode 0600)." >&2
  exit 0
fi

if [ "${TARGET_HANDLE}" != "" ]; then
  case "${TARGET_HANDLE}" in
    [a-z]*) ;;
    *)
      echo "ERROR: invalid handle: must start with a lowercase letter." >&2
      exit 1
      ;;
  esac
  case "${TARGET_HANDLE}" in
    *[!a-z0-9_-]*)
      echo "ERROR: invalid handle: use only lowercase letters, digits, underscore, or hyphen." >&2
      exit 1
      ;;
  esac
  if [ "${#TARGET_HANDLE}" -gt 32 ]; then
    echo "ERROR: invalid handle: maximum length is 32 characters." >&2
    exit 1
  fi
  if [ "${TARGET_HANDLE}" = "team" ]; then
    echo "ERROR: invalid handle: team is reserved for the broadcast lane." >&2
    exit 1
  fi
  KEY_FILE="${NKEYS_DIR}/${TARGET_HANDLE}.nk"
  if [ -e "${KEY_FILE}" ] && [ "${FORCE_OVERWRITE}" -ne 1 ]; then
    echo "ERROR: key already exists: ${KEY_FILE} (pass --force to rotate it)." >&2
    exit 1
  fi
fi

if command -v nk >/dev/null 2>&1; then
  NKEY_TOOL="$(command -v nk)"
elif command -v "$NATS_BIN" >/dev/null 2>&1; then
  NKEY_TOOL="$NATS_BIN"
elif command -v nats >/dev/null 2>&1; then
  NKEY_TOOL="$(command -v nats)"
else
  echo "ERROR: nkey generator not found. Install ~/.local/bin/nats or nk." >&2
  exit 1
fi

generate_pair_output() {
  if [ "${NKEY_TOOL##*/}" = "nats" ]; then
    "$NKEY_TOOL" nkey gen user 2>/dev/null
    return
  fi

  "$NKEY_TOOL" -gen user 2>/dev/null || "$NKEY_TOOL" gen user 2>/dev/null || "$NKEY_TOOL" -gen user -pubout 2>/dev/null
}

RAW_OUTPUT="$(generate_pair_output)"

if [ -z "${RAW_OUTPUT}" ]; then
  echo "ERROR: failed to generate nkey pair (generator unavailable or no output)." >&2
  exit 1
fi

SEED="$(printf '%s\n' "${RAW_OUTPUT}" | awk 'match($0,/S[A-Z0-9]+/){print substr($0,RSTART,RLENGTH); exit}')"
PUBLIC_KEY="$(printf '%s\n' "${RAW_OUTPUT}" | awk 'match($0,/U[A-Z0-9]+/){print substr($0,RSTART,RLENGTH); exit}')"

if [ -z "${SEED}" ]; then
  echo "ERROR: failed to parse seed from generator output." >&2
  exit 1
fi

if [ -z "${PUBLIC_KEY}" ] && [ "$NKEY_TOOL" = "$NATS_BIN" ]; then
  TMP_SEED_FILE="$(mktemp)"
  trap 'rm -f "${TMP_SEED_FILE}"' EXIT
  printf '%s\n' "${SEED}" > "${TMP_SEED_FILE}"
  chmod 600 "${TMP_SEED_FILE}"
  PUBLIC_KEY="$(
    "$NATS_BIN" auth nkey show "${TMP_SEED_FILE}" 2>/dev/null \
      | awk 'match($0,/U[A-Z0-9]+/){print substr($0,RSTART,RLENGTH); exit}'
  )"
  if [ -z "${PUBLIC_KEY}" ]; then
    rm -f "${TMP_SEED_FILE}"
    trap - EXIT
  fi
fi

if [ -z "${PUBLIC_KEY}" ]; then
  echo "ERROR: failed to derive the public key from generated seed." >&2
  exit 1
fi

echo "public=${PUBLIC_KEY}"

if [ -n "${TARGET_HANDLE}" ]; then
  # Handle mode: seed goes ONLY to the 0600 keyfile, NEVER to stdout — avoids
  # leaking private seed material into shell history / CI logs (R5 hygiene).
  mkdir -p "${NKEYS_DIR}"
  chmod 700 "${NKEYS_DIR}"
  printf '%s\n' "${SEED}" > "${KEY_FILE}"
  chmod 600 "${KEY_FILE}"
  echo "path=${KEY_FILE}"
else
  # Ephemeral mode (no handle): the caller must capture the seed. Emit it, but
  # WARN loudly on stderr that it is private and must not be logged/committed.
  echo "WARNING: seed is PRIVATE key material — do not log, share, or commit it." >&2
  echo "seed=${SEED}"
fi
