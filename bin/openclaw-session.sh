#!/usr/bin/env bash
# Relaunch the openclaw / hangar-bridge Claude session with both inbound channels.
#
# Why a script: the argv has four independent parts and every one of them fails
# SILENTLY when wrong — a session with a malformed channel flag looks completely
# healthy (MCP connects, tools work, /mcp is green, outbound sends fine) while
# every inbound message is dropped. This repo ran that way for two months.
#
# THE SEPARATOR TRAP (verified on this machine 2026-08-31, three ways tried):
#   server:a,server:b   → whole string read as ONE channel name → DEAF
#   "server:a server:b" → same, one name → DEAF
#   repeated flag       → works; the confirmation screen lists both
# Claude does not split a flag value, so ONE CHANNEL PER FLAG OCCURRENCE.
# packages/peer-agent/src/deaf-check.ts encodes the same rule, so a wrong
# separator here is reported as deaf rather than silently tolerated.
#
# Usage:  bin/openclaw-session.sh [--fresh] [extra claude args...]
#         --fresh   start a new conversation instead of resuming
set -euo pipefail

SESSION_NAME="hanger-bridge@openclaw"
AGENT_NAME="openclaw-hangar-bridge"
REPO="/home/cookys/projects/hangar-bridge"

resume=(--resume "$SESSION_NAME")
if [[ "${1:-}" == "--fresh" ]]; then resume=(); shift; fi

cd "$REPO"

# Fail loudly on the preconditions that otherwise fail silently at runtime.
key=$(python3 -c "
import json
print(next((k for k in json.load(open('$HOME/.claude.json')).get('mcpServers',{}) if 'hangar' in k), ''))
")
[[ -n "$key" ]] || { echo "FATAL: no hangar MCP server in ~/.claude.json" >&2; exit 1; }

env_key=$(python3 -c "
import json
print(json.load(open('$HOME/.claude.json'))['mcpServers']['$key'].get('env',{}).get('HANGAR_MCP_KEY',''))
")
if [[ "$env_key" != "$key" ]]; then
  echo "WARN: HANGAR_MCP_KEY='$env_key' != mcpServers key '$key'" >&2
  echo "      P0's flag self-check cannot compare and will skip (fail-open, no protection)." >&2
fi

[[ -f "$REPO/.mcp.json" ]] || {
  echo "FATAL: .mcp.json missing — run:" >&2
  echo "  node ~/projects/agent-call/bin/agent-call.js setup claude --name $AGENT_NAME --config $REPO/.mcp.json" >&2
  exit 1
}

# AGENT_CALL_PERSISTENT + AGENT_CALL_NAME are BOTH required: the agent-call MCP
# entry is deliberately name-neutral, and only a launch carrying both registers
# an inbound channel. Without them the session silently gets outbound tools only.
exec env AGENT_CALL_PERSISTENT=1 AGENT_CALL_NAME="$AGENT_NAME" \
  claude --dangerously-skip-permissions \
         --dangerously-load-development-channels "server:$key" \
         --dangerously-load-development-channels server:agent-call-local \
         "${resume[@]}" "$@"
