#!/usr/bin/env bash
# Adds the hangar-bridge-peer-agent MCP server entry to ~/.claude.json.
# Idempotent: re-running is safe (existing entry is replaced, not duplicated).
#
# Why this is its own script and not a one-liner:
#   - ~/.claude.json is shared state across every Claude Code session on this
#     host. A bad merge breaks every project, not just hangar-bridge. The
#     script does a backup, an atomic write, and prints a diff so you can
#     bail before committing.
#   - The peer-agent's absolute path differs by host (gentoo at
#     /home/cookys/projects/hangar-bridge, openclaw at the same path but
#     different node binary), so the fragment can't be a static check-in.
#
# Usage:
#   packages/operations/claude-config/install-mcp.sh [--dry-run]
#
# Prereqs:
#   - jq on PATH
#   - this repo cloned at ~/projects/hangar-bridge (or REPO_DIR env override)
#   - dist built (`pnpm -r build`) so the entry's `command`+`args` are
#     immediately runnable

set -euo pipefail

CLAUDE_JSON="${HOME}/.claude.json"
REPO_DIR="${REPO_DIR:-${HOME}/projects/hangar-bridge}"
PEER_AGENT_JS="${REPO_DIR}/packages/peer-agent/dist/index.js"
PEER_AGENT_SH="${REPO_DIR}/packages/peer-agent/bin/peer-agent.sh"
DRY_RUN="${1:-}"
MCP_KEY="hangar-bridge-peer-agent"

if [[ $# -gt 1 ]] || [[ -n "${DRY_RUN}" && "${DRY_RUN}" != "--dry-run" ]]; then
  echo "Usage: $0 [--dry-run]" >&2
  exit 2
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq not on PATH. Install jq first." >&2
  exit 1
fi
if [[ ! -f "${PEER_AGENT_JS}" ]]; then
  echo "ERROR: peer-agent dist not found at ${PEER_AGENT_JS}" >&2
  echo "Run 'pnpm -r build' in ${REPO_DIR} first." >&2
  exit 1
fi
if [[ ! -x "${PEER_AGENT_SH}" ]]; then
  echo "ERROR: peer-agent wrapper not executable at ${PEER_AGENT_SH}" >&2
  echo "Run 'chmod +x ${PEER_AGENT_SH}'." >&2
  exit 1
fi

# Merge: set .mcpServers["hangar-bridge-peer-agent"] = {command, args, env}.
# `command` is the wrapper, not `node` directly — Claude Code's MCP execvp
# does not inherit nvm's PATH, so bare `node` breaks on hosts that install
# node via nvm (the wrapper finds node via a fallback chain).
# shellcheck disable=SC2016 # jq variables, not shell variables
PATCH_FILTER='
  .mcpServers //= {} |
  .mcpServers["hangar-bridge-peer-agent"] = {
    command: $p,
    args: [],
    env: ((.mcpServers["hangar-bridge-peer-agent"].env // {}) + {HANGAR_MCP_KEY: $key})
  }
'

if [[ -f "${CLAUDE_JSON}" ]]; then
  PATCHED="$(jq --arg p "${PEER_AGENT_SH}" --arg key "${MCP_KEY}" \
    "${PATCH_FILTER}" "${CLAUDE_JSON}")"
  BEFORE_TARGET="$(jq --arg key "${MCP_KEY}" '.mcpServers[$key] // null' "${CLAUDE_JSON}")"
else
  echo "WARN: ${CLAUDE_JSON} does not exist; the install would create it with just the MCP entry."
  PATCHED="$(printf '{"mcpServers":{}}\n' | \
    jq --arg p "${PEER_AGENT_SH}" --arg key "${MCP_KEY}" "${PATCH_FILTER}")"
  BEFORE_TARGET="null"
fi

# Show only the entry this installer owns. Redact every field value so a
# pre-existing command argument or environment secret can never leak through
# installer output; key names and structural changes remain reviewable.
redact_target() {
  jq '
    if . == null then null else {
      command: (if has("command") then "<redacted>" else null end),
      args: ((.args // []) | map("<redacted>")),
      env_keys: ((.env // {}) | keys)
    } end
  '
}

AFTER_TARGET="$(printf '%s\n' "${PATCHED}" | jq --arg key "${MCP_KEY}" '.mcpServers[$key]')"

echo "--- diff (BEFORE → AFTER, managed MCP entry; field values redacted) ---"
set +e
diff -u \
  <(printf '%s\n' "${BEFORE_TARGET}" | redact_target) \
  <(printf '%s\n' "${AFTER_TARGET}" | redact_target)
DIFF_STATUS=$?
set -e
if ((DIFF_STATUS > 1)); then
  echo "ERROR: failed to render the managed MCP entry diff." >&2
  exit "${DIFF_STATUS}"
fi

if [[ "${DRY_RUN}" == "--dry-run" ]]; then
  echo ""
  echo "DRY-RUN: no files written."
  exit 0
fi

BACKUP=""
if [[ -f "${CLAUDE_JSON}" ]]; then
  BACKUP="${CLAUDE_JSON}.bak.$(date +%Y%m%d-%H%M%S).$$"
  cp -p "${CLAUDE_JSON}" "${BACKUP}"
  echo "Backup: ${BACKUP}"
fi

# Atomic write: jq writes to a tempfile, then mv replaces the original.
TMP="$(mktemp "${CLAUDE_JSON}.XXXX")"
printf '%s\n' "${PATCHED}" > "${TMP}"
chmod 600 "${TMP}"
mv "${TMP}" "${CLAUDE_JSON}"

echo ""
echo "Installed. Verify in a NEW Claude Code session:"
echo "  claude --dangerously-load-development-channels server:hangar-bridge-peer-agent"
echo "  > /mcp"
echo "Expected: server 'hangar-bridge-peer-agent' connected, tools include"
echo "  send_to_peer, list_peers, set_summary, dispatch_task,"
echo "  and (if permission_relay.enabled in config) respond_to_permission."
echo ""
if [[ -n "${BACKUP}" ]]; then
  echo "To rollback: cp ${BACKUP} ${CLAUDE_JSON}"
else
  echo "To rollback: rm ${CLAUDE_JSON}"
fi
