#!/usr/bin/env bash
# Locates a working `node` and execs the peer-agent's MCP stdio server.
#
# Why a wrapper: Claude Code spawns MCP `command:` via execvp with whatever
# PATH the parent CC process had — often empty of nvm-installed node, even
# though the user's interactive shell sees it fine. Hard-coding the absolute
# path in ~/.claude.json works but breaks on every nvm patch bump and forces
# per-machine editing. This wrapper auto-locates node so the same config
# fragment ships everywhere.
#
# Resolution order:
#   1. $NODE_BIN env (explicit override, useful for testing)
#   2. ~/.nvm/alias/node22/bin/node (stable cookys symlink, patch-safe)
#   3. PATH lookup via `command -v node`
#   4. source ~/.nvm/nvm.sh then retry PATH (slow, last resort)

set -euo pipefail

NODE="${NODE_BIN:-}"
if [ -z "${NODE}" ] && [ -x "${HOME}/.nvm/alias/node22/bin/node" ]; then
  NODE="${HOME}/.nvm/alias/node22/bin/node"
fi
if [ -z "${NODE}" ] && command -v node >/dev/null 2>&1; then
  NODE="$(command -v node)"
fi
if [ -z "${NODE}" ] && [ -s "${HOME}/.nvm/nvm.sh" ]; then
  export NVM_DIR="${HOME}/.nvm"
  # shellcheck disable=SC1091
  . "${HOME}/.nvm/nvm.sh" >/dev/null 2>&1 || true
  if command -v node >/dev/null 2>&1; then
    NODE="$(command -v node)"
  fi
fi
if [ -z "${NODE}" ]; then
  echo "peer-agent: cannot locate node (tried \$NODE_BIN, ~/.nvm/alias/node22, PATH, nvm.sh sourcing)" >&2
  exit 127
fi

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
INDEX_JS="${SCRIPT_DIR}/../dist/index.js"
if [ ! -f "${INDEX_JS}" ]; then
  echo "peer-agent: dist/index.js not found at ${INDEX_JS} — run 'pnpm -r build'" >&2
  exit 1
fi

exec "${NODE}" "${INDEX_JS}" "$@"
