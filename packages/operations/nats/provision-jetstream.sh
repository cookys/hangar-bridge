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

consumer_matches() {
  EXPECTED_FILTER="$1"
  if command -v jq >/dev/null 2>&1; then
    jq -e --arg filter "$EXPECTED_FILTER" '
      .config.filter_subject == $filter
      and ((.config.ack_policy // "") | ascii_downcase) == "explicit"
      and ((.config.deliver_subject // "") == "")
    ' >/dev/null
    return $?
  fi

  if ! command -v node >/dev/null 2>&1; then
    echo "ERROR: jq is required or node must be available for consumer reconciliation." >&2
    return 1
  fi

  node -e '
    const fs = require("fs");
    const expected = process.argv[1];
    const info = JSON.parse(fs.readFileSync(0, "utf8"));
    const c = info.config || {};
    const ok = c.filter_subject === expected
      && String(c.ack_policy || "").toLowerCase() === "explicit"
      && !c.deliver_subject;
    process.exit(ok ? 0 : 1);
  ' "$EXPECTED_FILTER"
}

stream_invariants_match() {
  if command -v jq >/dev/null 2>&1; then
    jq -e '
      ((.config.retention // "") | ascii_downcase) == "workqueue"
      and ((.config.storage // "") | ascii_downcase) == "file"
      and .config.num_replicas == 1
    ' >/dev/null
    return $?
  fi

  node -e '
    const fs = require("fs");
    const c = (JSON.parse(fs.readFileSync(0, "utf8")).config || {});
    const ok = String(c.retention || "").toLowerCase() === "workqueue"
      && String(c.storage || "").toLowerCase() === "file"
      && c.num_replicas === 1;
    process.exit(ok ? 0 : 1);
  '
}

kv_invariants_match() {
  if command -v jq >/dev/null 2>&1; then
    jq -e '
      ((.config.retention // "") | ascii_downcase) == "limits"
      and ((.config.storage // "") | ascii_downcase) == "file"
      and .config.num_replicas == 1
      and .config.max_msgs_per_subject == 1
      and .config.max_age == 0
      and .config.allow_direct == true
    ' >/dev/null
    return $?
  fi

  node -e '
    const fs = require("fs");
    const c = (JSON.parse(fs.readFileSync(0, "utf8")).config || {});
    const ok = String(c.retention || "").toLowerCase() === "limits"
      && String(c.storage || "").toLowerCase() === "file"
      && c.num_replicas === 1
      && c.max_msgs_per_subject === 1
      && c.max_age === 0
      && c.allow_direct === true;
    process.exit(ok ? 0 : 1);
  '
}

consumer_names() {
  if command -v jq >/dev/null 2>&1; then
    jq -r '.[]'
    return $?
  fi

  node -e '
    const fs = require("fs");
    const names = JSON.parse(fs.readFileSync(0, "utf8"));
    if (!Array.isArray(names) || names.some((v) => typeof v !== "string")) process.exit(1);
    names.forEach((name) => process.stdout.write(`${name}\n`));
  '
}

is_roster_handle() {
  CANDIDATE="$1"
  for KNOWN_HANDLE in $HANDLES; do
    if [ "$KNOWN_HANDLE" = "$CANDIDATE" ]; then
      return 0
    fi
  done
  return 1
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
  STREAM_INFO="$(run_nats stream info "$STREAM_NAME" --json)"
  if ! printf '%s\n' "$STREAM_INFO" | stream_invariants_match; then
    echo "ERROR: ${STREAM_NAME} has unsafe immutable drift (require workqueue/file/R1); recreate it deliberately." >&2
    exit 1
  fi
  # Subjects are mutable and are reconciled idempotently. Durability invariants above
  # are fail-closed because silently editing/recreating them could discard live work.
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

  EXPECTED_FILTER="fleet.*.to.${HANDLE}.>"
  CONSUMER_INFO=""
  if CONSUMER_INFO="$(run_nats consumer info "$STREAM_NAME" "$HANDLE" --json 2>/dev/null)"; then
    if printf '%s\n' "$CONSUMER_INFO" | consumer_matches "$EXPECTED_FILTER"; then
      echo "consumer reconciled: ${HANDLE}"
      continue
    fi
    run_nats consumer rm "$STREAM_NAME" "$HANDLE" -f
    echo "consumer removed for reconcile: ${HANDLE}"
  fi

  run_nats consumer add "$STREAM_NAME" "$HANDLE" --filter "$EXPECTED_FILTER" --pull --ack explicit --defaults
  echo "consumer created: ${HANDLE}"
done

# A handle removed from the roster must not leave a durable consumer behind. Such a
# consumer can retain/misroute work indefinitely, so remove it explicitly and report it.
EXISTING_CONSUMERS="$(run_nats consumer list "$STREAM_NAME" --names --json | consumer_names)"
for EXISTING in $EXISTING_CONSUMERS; do
  if ! is_roster_handle "$EXISTING"; then
    run_nats consumer rm "$STREAM_NAME" "$EXISTING" -f
    echo "orphan consumer removed: ${EXISTING}"
  fi
done

if run_nats kv info "$BUCKET_NAME" >/dev/null 2>&1; then
  echo "kv exists: ${BUCKET_NAME}"
else
  run_nats kv add "$BUCKET_NAME" --replicas 1 --storage file
  echo "kv created: ${BUCKET_NAME}"
fi

KV_INFO="$(run_nats stream info "KV_${BUCKET_NAME}" --json)"
if ! printf '%s\n' "$KV_INFO" | kv_invariants_match; then
  echo "ERROR: ${BUCKET_NAME} has unsafe drift (require limits/file/R1/history=1/no-expiry/direct-read)." >&2
  exit 1
fi
echo "kv invariants verified: ${BUCKET_NAME}"
