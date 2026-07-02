#!/usr/bin/env sh

set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROSTER_FILE="${ROSTER_FILE:-${SCRIPT_DIR}/fleet-roster.json}"
NATS_BIN="${NATS_BIN:-${HOME}/.local/bin/nats}"
NATS_URL="${NATS_URL:-nats://127.0.0.1:4222}"
ADMIN_SEED_PATH="${NATS_ADMIN_SEED_PATH:-${HOME}/.config/hangar-bridge/nats/hangar-admin.nk}"
STREAM_NAME="HANGAR_TASKS"
BUCKET_NAME="HANGAR_DEDUP"

if ! command -v "$NATS_BIN" >/dev/null 2>&1; then
  if command -v nats >/dev/null 2>&1; then
    NATS_BIN="$(command -v nats)"
  else
    echo "ERROR: nats CLI not found (set NATS_BIN or install ~/.local/bin/nats)" >&2
    exit 1
  fi
fi

if [ ! -f "$ROSTER_FILE" ]; then
  echo "ERROR: roster file not found: ${ROSTER_FILE}" >&2
  exit 1
fi

if [ ! -f "$ADMIN_SEED_PATH" ]; then
  echo "ERROR: admin seed file not found: ${ADMIN_SEED_PATH}" >&2
  echo "Store the hangar-admin seed at ~/.config/hangar-bridge/nats/hangar-admin.nk (mode 0600)." >&2
  exit 1
fi

if [ ! -s "$ADMIN_SEED_PATH" ]; then
  echo "ERROR: empty hangar-admin seed in ${ADMIN_SEED_PATH}" >&2
  exit 1
fi

read_handles() {
  if command -v jq >/dev/null 2>&1; then
    jq -r 'keys | .[]' "$ROSTER_FILE"
    return 0
  fi

  if ! command -v node >/dev/null 2>&1; then
    echo "ERROR: jq is required or node must be available for fallback roster parsing." >&2
    return 1
  fi

  node -e 'const fs=require("fs"); const path=process.argv[1]; const data=JSON.parse(fs.readFileSync(path, "utf8")) || {}; Object.keys(data).sort().forEach((k)=>process.stdout.write(`${k}\n`));' "$ROSTER_FILE"
}

HANDLES="$(read_handles)"
HANDLES="$(printf '%s\n' "$HANDLES" | sed '/^[[:space:]]*$/d')"

run_nats() {
  "$NATS_BIN" --server "$NATS_URL" --nkey "$ADMIN_SEED_PATH" --inbox-prefix "_INBOX.admin" "$@"
}

STREAM_SUBJECTS=""
for HANDLE in $HANDLES; do
  if [ -z "$HANDLE" ]; then
    continue
  fi

  if [ -n "$STREAM_SUBJECTS" ]; then
    STREAM_SUBJECTS="${STREAM_SUBJECTS},"
  fi
  STREAM_SUBJECTS="${STREAM_SUBJECTS}fleet.*.to.${HANDLE}.task_dispatch,fleet.*.to.${HANDLE}.task_result"
done

if [ -z "$STREAM_SUBJECTS" ]; then
  echo "ERROR: roster ${ROSTER_FILE} has no handles." >&2
  exit 1
fi

if run_nats stream info "$STREAM_NAME" >/dev/null 2>&1; then
  echo "stream exists: ${STREAM_NAME}"
  # Idempotent reconcile: only the mutable subject list is reconciled (retention /
  # replicas / storage are fixed at creation and rejected by `stream edit`, which
  # was the cause of the earlier non-idempotent failure). `-f` = non-interactive.
  if run_nats stream edit "$STREAM_NAME" --subjects "$STREAM_SUBJECTS" -f >/dev/null 2>&1; then
    echo "stream reconciled: ${STREAM_NAME}"
  else
    echo "ERROR: stream reconcile failed: ${STREAM_NAME}" >&2
    exit 1
  fi
else
  run_nats stream add "$STREAM_NAME" --subjects "$STREAM_SUBJECTS" --retention work --replicas 1 --storage file --defaults
  echo "stream created: ${STREAM_NAME}"
fi

for HANDLE in $HANDLES; do
  if [ -z "$HANDLE" ]; then
    continue
  fi

  if run_nats consumer info "$STREAM_NAME" "$HANDLE" >/dev/null 2>&1; then
    echo "consumer exists: ${HANDLE}"
  else
    run_nats consumer add "$STREAM_NAME" "$HANDLE" --filter "fleet.*.to.${HANDLE}.>" --pull --defaults
    echo "consumer created: ${HANDLE}"
  fi
done

if run_nats kv info "$BUCKET_NAME" >/dev/null 2>&1; then
  echo "kv exists: ${BUCKET_NAME}"
else
  run_nats kv add "$BUCKET_NAME" --replicas 1 --storage file
  echo "kv created: ${BUCKET_NAME}"
fi
