#!/usr/bin/env bash
# Bounded verify command for the relay-groups campaigns (plan docs/plans/2026-09-16-relay-groups.md).
# The engine runs this in a FRESH detached worktree (no node_modules), so bootstrap deps first
# (offline from the shared pnpm store). Then shared + relay suites once, then both typechecks.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ ! -d node_modules ] || [ ! -d packages/relay/node_modules ]; then
  corepack pnpm install --frozen-lockfile --prefer-offline --silent
fi
# relay resolves @hangar-bridge/shared through its dist entry: a fresh tree has none and a
# long-lived checkout has a STALE one (P0 bit this: undefined ALL_MEMBER_CAPS). Always rebuild.
corepack pnpm -F @hangar-bridge/shared run build
corepack pnpm -F @hangar-bridge/shared exec vitest run
corepack pnpm -F @hangar-bridge/relay exec vitest run
corepack pnpm -F @hangar-bridge/shared run typecheck
corepack pnpm -F @hangar-bridge/relay run typecheck
