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

if [[ ! -f "${CLAUDE_JSON}" ]]; then
  echo "WARN: ${CLAUDE_JSON} does not exist; creating with just the MCP entry."
  echo '{"mcpServers":{}}' > "${CLAUDE_JSON}"
  chmod 600 "${CLAUDE_JSON}"
fi

BACKUP="${CLAUDE_JSON}.bak.$(date +%Y%m%d-%H%M%S)"
cp -p "${CLAUDE_JSON}" "${BACKUP}"
echo "Backup: ${BACKUP}"

# Merge: set .mcpServers["hangar-bridge-peer-agent"] = {command, args, env}.
# `command` is the wrapper, not `node` directly — Claude Code's MCP execvp
# does not inherit nvm's PATH, so bare `node` breaks on hosts that install
# node via nvm (the wrapper finds node via a fallback chain).
PATCHED="$(jq --arg p "${PEER_AGENT_SH}" '
  .mcpServers //= {} |
  .mcpServers["hangar-bridge-peer-agent"] = {
    command: $p,
    args: [],
    env: {}
  }
' "${CLAUDE_JSON}")"

echo "--- diff (BEFORE → AFTER, .mcpServers section only) ---"
echo "${PATCHED}" | jq '.mcpServers' > /tmp/.hb-mcp-after.json
jq '.mcpServers // {}' "${CLAUDE_JSON}" > /tmp/.hb-mcp-before.json
diff -u /tmp/.hb-mcp-before.json /tmp/.hb-mcp-after.json || true
rm -f /tmp/.hb-mcp-before.json /tmp/.hb-mcp-after.json

if [[ "${DRY_RUN}" == "--dry-run" ]]; then
  echo ""
  echo "DRY-RUN: not writing. Backup left at ${BACKUP}."
  exit 0
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
echo "To rollback: cp ${BACKUP} ${CLAUDE_JSON}"
