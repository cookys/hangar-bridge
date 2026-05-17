#!/usr/bin/env bash
# Cross-host permission-relay loopback orchestrator (P8).
# Mirrors cross-host-loopback.sh but exercises permission_request →
# permission_verdict over the LAN instead of task_dispatch → task_result.
#
# Topology: gentoo is the requester (Claude that wants to run a tool);
# openclaw is the approver (Claude / human that says allow/deny). This
# matches the plan: "gentoo CC dispatched-task tries a tool that triggers
# approval ... openclaw CC sees injection; user approves ...".
#
# In the automated path the "user approves" step is the approver script
# POSTing to /v1/permission/respond, which is the same code path a live
# CC session would take via the `respond_to_permission` MCP tool.
#
# Env overrides: same as cross-host-loopback.sh.

set -euo pipefail

RELAY_HOST="${RELAY_HOST:-192.168.101.6}"
RELAY_PORT="${RELAY_PORT:-8443}"
GENTOO_SSH="${GENTOO_SSH:-cookys-gentoo}"
RELAY_URL="http://${RELAY_HOST}:${RELAY_PORT}"

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
FIXTURE_LOG="${REPO_ROOT}/packages/e2e/fixtures/cross-host-permission.log"
TMP_DIR="$(mktemp -d /tmp/hangar-bridge-p8-XXXXXX)"

trap 'cleanup' EXIT INT TERM

cleanup() {
  set +e
  if [[ -n "${RELAY_PID:-}" ]] && kill -0 "${RELAY_PID}" 2>/dev/null; then
    kill "${RELAY_PID}" 2>/dev/null || true
    wait "${RELAY_PID}" 2>/dev/null || true
  fi
  if [[ -n "${REQUESTER_PID_REMOTE:-}" ]]; then
    ssh "${GENTOO_SSH}" "kill ${REQUESTER_PID_REMOTE} 2>/dev/null || true" || true
  fi
  rm -rf "${TMP_DIR}" 2>/dev/null || true
}

log() { printf '\n=== [%s] %s\n' "$(date +%H:%M:%S)" "$*"; }

log "P8 cross-host permission relay — ${RELAY_URL}, gentoo via ${GENTOO_SSH}"

# -- 1. secrets + peers.json --------------------------------------------
SECRET_O="$(openssl rand -base64 32 | tr -d '\n=' | tr '/+' '_-' | head -c 43)"
SECRET_G="$(openssl rand -base64 32 | tr -d '\n=' | tr '/+' '_-' | head -c 43)"
HASH_O="$(printf '%s' "${SECRET_O}" | openssl dgst -sha256 -hex | awk '{print $NF}')"
HASH_G="$(printf '%s' "${SECRET_G}" | openssl dgst -sha256 -hex | awk '{print $NF}')"

cat > "${TMP_DIR}/peers.json" <<JSON
{
  "openclaw": { "secret_sha256_hex": "${HASH_O}", "display_name": "openclaw-cc" },
  "gentoo":   { "secret_sha256_hex": "${HASH_G}", "display_name": "gentoo-cc" }
}
JSON
chmod 600 "${TMP_DIR}/peers.json"
printf '%s' "${SECRET_O}" > "${TMP_DIR}/secret.openclaw"
printf '%s' "${SECRET_G}" > "${TMP_DIR}/secret.gentoo"
chmod 600 "${TMP_DIR}/secret.openclaw" "${TMP_DIR}/secret.gentoo"

# -- 2. relay on openclaw -----------------------------------------------
export HANGAR_DATA="${TMP_DIR}/relay-data"
export HANGAR_PEERS_FILE="${TMP_DIR}/peers.json"
export PORT="${RELAY_PORT}"
export HOST="${RELAY_HOST}"
mkdir -p "${HANGAR_DATA}"

if [[ ! -f "${REPO_ROOT}/packages/relay/dist/index.js" ]]; then
  log "relay dist missing; building…"
  (cd "${REPO_ROOT}" && pnpm -r build > /dev/null)
fi
node "${REPO_ROOT}/packages/relay/dist/index.js" > "${TMP_DIR}/relay.log" 2>&1 &
RELAY_PID=$!

for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -sf "${RELAY_URL}/health" -m 1 >/dev/null 2>&1; then break; fi
  sleep 0.3
done
HEALTH_OPENCLAW="$(curl -sf "${RELAY_URL}/health")"
log "openclaw → relay /health: ${HEALTH_OPENCLAW}"

# -- 3. distribute gentoo secret + scripts ------------------------------
GENTOO_SECRET_DIR=".config/hangar-bridge-p8"
ssh "${GENTOO_SSH}" "mkdir -p ${GENTOO_SECRET_DIR} && chmod 700 ${GENTOO_SECRET_DIR}"
scp -q "${TMP_DIR}/secret.gentoo" "${GENTOO_SSH}:${GENTOO_SECRET_DIR}/secret"
ssh "${GENTOO_SSH}" "chmod 600 ${GENTOO_SECRET_DIR}/secret"
GENTOO_SCRIPT="/tmp/cross-host-permission.mjs"
scp -q "${REPO_ROOT}/packages/e2e/scripts/cross-host-permission.mjs" "${GENTOO_SSH}:${GENTOO_SCRIPT}"

HEALTH_GENTOO="$(ssh "${GENTOO_SSH}" "curl -sf '${RELAY_URL}/health' -m 5")"
log "gentoo → relay /health: ${HEALTH_GENTOO}"

# -- 4. Validate request_id alphabet up front ---------------------------
REQUEST_ID="${REQUEST_ID:-axkmz}"
if ! [[ "${REQUEST_ID}" =~ ^[a-km-z]{5}$ ]]; then
  log "ERROR: request_id ${REQUEST_ID} violates /^[a-km-z]{5}$/ (excludes 'l')"
  exit 1
fi
log "request_id=${REQUEST_ID} (validated against /^[a-km-z]{5}$/)"

# -- 5. start requester on gentoo (background, awaiting verdict) --------
log "starting requester on gentoo…"
ssh "${GENTOO_SSH}" "rm -f /tmp/p8-requester.out"
REQUESTER_PID_REMOTE=$(ssh "${GENTOO_SSH}" "
  export NVM_DIR=\$HOME/.nvm && . \$NVM_DIR/nvm.sh >/dev/null
  nohup node ${GENTOO_SCRIPT} \
    --role requester \
    --relay '${RELAY_URL}' \
    --secret-path \$HOME/${GENTOO_SECRET_DIR}/secret \
    --self gentoo --remote openclaw \
    --request-id ${REQUEST_ID} \
    --tool Bash --input-preview 'rm -rf dist/' \
    --timeout-ms 30000 \
    > /tmp/p8-requester.out 2>&1 &
  echo \$!
")
log "requester PID on gentoo: ${REQUESTER_PID_REMOTE}"

# Give the requester a moment to subscribe + send.
sleep 1

# -- 6. run approver locally (one-shot) ---------------------------------
log "running approver on openclaw (auto-allow)…"
APPROVER_OUT="${TMP_DIR}/approver.out"
node "${REPO_ROOT}/packages/e2e/scripts/cross-host-permission.mjs" \
  --role approver \
  --relay "${RELAY_URL}" \
  --secret-path "${TMP_DIR}/secret.openclaw" \
  --self openclaw --remote gentoo \
  --verdict allow --reason "p8 e2e auto-approve" \
  --timeout-ms 30000 \
  | tee "${APPROVER_OUT}"

# Pull requester transcript
REQUESTER_OUT="${TMP_DIR}/requester.out"
ssh "${GENTOO_SSH}" "cat /tmp/p8-requester.out" > "${REQUESTER_OUT}" || true

# -- 7. compose fixture -------------------------------------------------
{
  echo "# hangar-bridge P8 cross-host permission round-trip"
  echo "# captured $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# relay=${RELAY_URL}  openclaw=$(hostname)  gentoo=$(ssh ${GENTOO_SSH} hostname)"
  echo "# request_id=${REQUEST_ID} (alphabet [a-km-z], 'l' excluded — validated)"
  echo "# /health (openclaw): ${HEALTH_OPENCLAW}"
  echo "# /health (gentoo):   ${HEALTH_GENTOO}"
  echo ""
  echo "# --- requester (gentoo) ---"
  cat "${REQUESTER_OUT}"
  echo ""
  echo "# --- approver (openclaw) ---"
  cat "${APPROVER_OUT}"
} > "${FIXTURE_LOG}"
log "fixture written → ${FIXTURE_LOG}"
