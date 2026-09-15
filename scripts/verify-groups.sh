#!/usr/bin/env bash
# Bounded verify command for the relay-groups campaigns (plan docs/plans/2026-09-16-relay-groups.md).
# Runs the shared + relay suites once (no watch), then typechecks. Exit non-zero on any failure.
set -euo pipefail
cd "$(dirname "$0")/.."
corepack pnpm -F @hangar-bridge/shared exec vitest run
corepack pnpm -F @hangar-bridge/relay exec vitest run
corepack pnpm -F @hangar-bridge/shared run typecheck
corepack pnpm -F @hangar-bridge/relay run typecheck
