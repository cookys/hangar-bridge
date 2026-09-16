#!/usr/bin/env bash
# P2 verify: everything verify-groups.sh checks, plus the peer-agent suite and typecheck.
set -euo pipefail
cd "$(dirname "$0")/.."
scripts/verify-groups.sh
corepack pnpm -F @hangar-bridge/peer-agent exec vitest run
corepack pnpm -F @hangar-bridge/peer-agent run typecheck
