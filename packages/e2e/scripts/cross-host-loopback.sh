#!/usr/bin/env bash
# Cross-host dispatch loopback orchestrator (P7).
#
# Runs on openclaw (this host). Stands up a temp hangar-bridge relay,
# generates two peer secrets, distributes the gentoo-side secret via scp,
# launches the responder on gentoo as a backgrounded process via ssh,
# runs the dispatcher locally, captures the full JSONL transcript to
# packages/e2e/fixtures/cross-host-dispatch.log, and tears down.
#
# Assumes:
#  - cookys-openclaw at 192.168.101.6 (this host)
#  - cookys-gentoo reachable via `ssh cookys-gentoo` with key auth
#  - both hosts have ~/projects/hangar-bridge/ checked out at the same commit
#  - both hosts have node 22 + pnpm 10 on PATH (gentoo via nvm)
#  - port 8443 free on openclaw
#
# Env overrides:
#   RELAY_HOST  (default 192.168.101.6)
#   RELAY_PORT  (default 8443)
#   GENTOO_SSH  (default cookys-gentoo)

set -euo pipefail

RELAY_HOST="${RELAY_HOST:-192.168.101.6}"
RELAY_PORT="${RELAY_PORT:-8443}"
GENTOO_SSH="${GENTOO_SSH:-cookys-gentoo}"
RELAY_URL="http://${RELAY_HOST}:${RELAY_PORT}"

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
FIXTURE_LOG="${REPO_ROOT}/packages/e2e/fixtures/cross-host-dispatch.log"
TMP_DIR="$(mktemp -d /tmp/hangar-bridge-p7-XXXXXX)"

trap 'cleanup' EXIT INT TERM

cleanup() {
  set +e
  if [[ -n "${RELAY_PID:-}" ]] && kill -0 "${RELAY_PID}" 2>/dev/null; then
    kill "${RELAY_PID}" 2>/dev/null || true
    wait "${RELAY_PID}" 2>/dev/null || true
  fi
  if [[ -n "${RESPONDER_PID_REMOTE:-}" ]]; then
    ssh "${GENTOO_SSH}" "kill ${RESPONDER_PID_REMOTE} 2>/dev/null || true" || true
  fi
  rm -rf "${TMP_DIR}" 2>/dev/null || true
}

log() { printf '\n=== [%s] %s\n' "$(date +%H:%M:%S)" "$*"; }

log "P7 cross-host loopback — ${RELAY_URL}, gentoo via ${GENTOO_SSH}"
log "fixture → ${FIXTURE_LOG}"

# -- 1. Generate secrets + peers.json -----------------------------------
SECRET_A="$(openssl rand -base64 32 | tr -d '\n=' | tr '/+' '_-' | head -c 43)"
SECRET_B="$(openssl rand -base64 32 | tr -d '\n=' | tr '/+' '_-' | head -c 43)"
HASH_A="$(printf '%s' "${SECRET_A}" | openssl dgst -sha256 -hex | awk '{print $NF}')"
HASH_B="$(printf '%s' "${SECRET_B}" | openssl dgst -sha256 -hex | awk '{print $NF}')"

cat > "${TMP_DIR}/peers.json" <<JSON
{
  "openclaw": { "secret_sha256_hex": "${HASH_A}", "display_name": "openclaw-cc" },
  "gentoo":   { "secret_sha256_hex": "${HASH_B}", "display_name": "gentoo-cc" }
}
JSON
chmod 600 "${TMP_DIR}/peers.json"

printf '%s' "${SECRET_A}" > "${TMP_DIR}/secret.openclaw"
printf '%s' "${SECRET_B}" > "${TMP_DIR}/secret.gentoo"
chmod 600 "${TMP_DIR}/secret.openclaw" "${TMP_DIR}/secret.gentoo"
log "secrets + peers.json minted in ${TMP_DIR}"

# -- 2. Start relay on openclaw ------------------------------------------
log "starting relay on ${RELAY_URL}…"
export HANGAR_DATA="${TMP_DIR}/relay-data"
export HANGAR_PEERS_FILE="${TMP_DIR}/peers.json"
export PORT="${RELAY_PORT}"
export HOST="${RELAY_HOST}"
mkdir -p "${HANGAR_DATA}"

# Use built dist artifact so script works on both openclaw (node 24 system)
# and gentoo (node 22 nvm) without requiring --experimental-strip-types.
if [[ ! -f "${REPO_ROOT}/packages/relay/dist/index.js" ]]; then
  log "relay dist not found; running pnpm -r build…"
  (cd "${REPO_ROOT}" && pnpm -r build > /dev/null)
fi
node "${REPO_ROOT}/packages/relay/dist/index.js" > "${TMP_DIR}/relay.log" 2>&1 &
RELAY_PID=$!

# Wait for /health to come up
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -sf "${RELAY_URL}/health" -m 1 >/dev/null 2>&1; then break; fi
  sleep 0.3
done
HEALTH_OPENCLAW="$(curl -sf "${RELAY_URL}/health")"
log "openclaw → relay /health: ${HEALTH_OPENCLAW}"

# -- 3. Distribute gentoo secret + check reachability --------------------
GENTOO_SECRET_DIR=".config/hangar-bridge-p7"
scp -q "${TMP_DIR}/secret.gentoo" "${GENTOO_SSH}:${GENTOO_SECRET_DIR}/secret" 2>/dev/null || {
  ssh "${GENTOO_SSH}" "mkdir -p ${GENTOO_SECRET_DIR} && chmod 700 ${GENTOO_SECRET_DIR}"
  scp -q "${TMP_DIR}/secret.gentoo" "${GENTOO_SSH}:${GENTOO_SECRET_DIR}/secret"
}
ssh "${GENTOO_SSH}" "chmod 600 ${GENTOO_SECRET_DIR}/secret"

HEALTH_GENTOO="$(ssh "${GENTOO_SSH}" "curl -sf '${RELAY_URL}/health' -m 5")"
log "gentoo → relay /health: ${HEALTH_GENTOO}"

# -- 4. NTP delta -------------------------------------------------------
T_LOCAL_NS="$(date +%s%N)"
T_REMOTE_NS="$(ssh "${GENTOO_SSH}" 'date +%s%N')"
T_DELTA_MS=$(( (T_REMOTE_NS - T_LOCAL_NS) / 1000000 ))
log "NTP delta (gentoo - openclaw): ${T_DELTA_MS} ms"

# -- 5. Start responder on gentoo (background) --------------------------
log "shipping responder script to gentoo…"
GENTOO_SCRIPT="/tmp/cross-host-peer.mjs"
scp -q "${REPO_ROOT}/packages/e2e/scripts/cross-host-peer.mjs" "${GENTOO_SSH}:${GENTOO_SCRIPT}"

log "starting responder on gentoo…"
ssh "${GENTOO_SSH}" "rm -f /tmp/p7-responder.out /tmp/p7-responder.pid"
RESPONDER_PID_REMOTE=$(ssh "${GENTOO_SSH}" "
  export NVM_DIR=\$HOME/.nvm && . \$NVM_DIR/nvm.sh >/dev/null
  nohup node ${GENTOO_SCRIPT} \
    --role responder \
    --relay '${RELAY_URL}' \
    --secret-path \$HOME/${GENTOO_SECRET_DIR}/secret \
    --self gentoo --remote openclaw \
    --timeout-ms 30000 \
    > /tmp/p7-responder.out 2>&1 &
  echo \$!
")
log "responder PID on gentoo: ${RESPONDER_PID_REMOTE}"

# Give the responder a moment to subscribe to /v1/stream
sleep 1

# -- 6. Run dispatcher locally ------------------------------------------
log "running dispatcher on openclaw…"
DISPATCHER_OUT="${TMP_DIR}/dispatcher.out"
node "${REPO_ROOT}/packages/e2e/scripts/cross-host-peer.mjs" \
  --role dispatcher \
  --relay "${RELAY_URL}" \
  --secret-path "${TMP_DIR}/secret.openclaw" \
  --self openclaw --remote gentoo \
  --timeout-ms 30000 \
  | tee "${DISPATCHER_OUT}"

# Pull the responder transcript back
RESPONDER_OUT="${TMP_DIR}/responder.out"
ssh "${GENTOO_SSH}" "cat /tmp/p7-responder.out" > "${RESPONDER_OUT}" || true

# -- 7. Compose fixture log ---------------------------------------------
{
  echo "# hangar-bridge P7 cross-host dispatch round-trip"
  echo "# captured $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# relay=${RELAY_URL}  openclaw_host=$(hostname)  gentoo_host=$(ssh ${GENTOO_SSH} hostname)"
  echo "# /health (openclaw): ${HEALTH_OPENCLAW}"
  echo "# /health (gentoo):   ${HEALTH_GENTOO}"
  echo "# NTP delta (gentoo − openclaw): ${T_DELTA_MS} ms"
  echo ""
  echo "# --- dispatcher (openclaw) ---"
  cat "${DISPATCHER_OUT}"
  echo ""
  echo "# --- responder (gentoo) ---"
  cat "${RESPONDER_OUT}"
} > "${FIXTURE_LOG}"

log "fixture written → ${FIXTURE_LOG}"
log "tearing down (relay PID ${RELAY_PID})"
