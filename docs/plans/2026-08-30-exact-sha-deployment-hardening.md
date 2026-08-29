---
status: approved
date: 2026-08-30
merge_target: develop
---

# Exact-SHA deployment hardening

## Goal

Make the SSE relay and peer-agent fleet safely upgradable by an operator or repository agent without
guessing: every rollout pins an immutable source revision, restarts the intended process, proves the
loaded revision, preserves the Claude channel key, and has an explicit rollback boundary.

## Baseline evidence

- The configured live relay reports version `0.4.0`, but its `GET /v1/messages` returns 404 while the
  current source mounts that route. A package version alone therefore does not prove source parity.
- `install-relay.sh --enable` calls `systemctl enable --now`; that does not restart an already-active
  service after a new build is copied into place.
- `install-mcp.sh` writes `env: {}` and removes or omits `HANGAR_MCP_KEY`, disabling the launch-key
  deaf-session check.
- Existing systemd documentation describes first install and unit removal, not exact-SHA upgrade or
  source/database rollback.

## Deliverables

1. Preserve and validate `HANGAR_MCP_KEY` in the Claude MCP installer, including a true no-write dry run.
2. Give relay health an immutable build revision supplied at build/deploy time and regression-test its
   normalization and response contract.
3. Make systemd installation distinguish first install from upgrade and restart an already-active relay
   before smoke verification.
4. Add an exact-SHA SSE fleet runbook: preflight, backup, build/gates, central relay rollout, peer rollout,
   exact-revision verification, failure stop conditions, and code/data rollback.
5. Correct stale schema, Node path, release-provenance, and Docker deployment artifacts.
6. Run the complete repository gates and independent adversarial review before merging to `develop`.
7. Only after source/CI acceptance, roll out central relay first and peer hosts second, with sanitized
   evidence. A failed persistent-messaging check must not silently become worker spawning.

## Acceptance

- New focused regression tests fail on the immutable base and pass on the candidate.
- `pnpm -r typecheck`, `pnpm -r test:ci`, `pnpm -r build`, `pnpm audit --prod --audit-level high`,
  `pnpm audit --audit-level high`, `git diff --check`, and the deterministic doc-drift gate all exit 0.
- Re-running the Claude installer retains a non-empty `HANGAR_MCP_KEY`; `--dry-run` makes no filesystem
  changes.
- Updating an active relay causes an explicit restart; first install still enables and starts it.
- `/health` exposes a validated build revision that can be matched to the intended 40-hex Git SHA.
- The runbook lets an agent execute and prove `openclaw relay -> peer hosts` order without learning a
  secret, publishing packages, changing visibility, or relying on mutable branch names.
- Hosted CI is green on `develop` at the merged SHA before any production rollout is called complete.

## Scope boundary

Included: relay health metadata and tests; Claude MCP installer and tests; systemd installer and tests;
SSE upgrade/rollback documentation; stale source-of-truth docs; legacy relay Docker build correctness;
deployment evidence and ordering.

Excluded: protocol/envelope changes, new scheduler/orchestration behavior, NATS cutover, npm publication,
stable release creation, repository visibility changes, secret rotation, and automatic fallback to worker
spawn. Database v7 is not reversed in place; rollback restores the pre-upgrade database backup together
with the prior exact source revision.

## Requirements ledger

| User requirement | Phase |
|---|---|
| “把 hangar-bridge 裡面該更新的文件更新” | P2 documentation synchronization |
| “那邊的 agent 知道怎樣升級跟部屬” | P2 exact-SHA fleet runbook |
| “主 branch 用 develop” | P4 merge target and hosted-CI verification |
| “不要走 copilot pipeline，走 autopilot 的 heto loop review / qc gate 的 dev-flow” | P3 quality and heterogeneous review |
| Central relay must be upgraded before remote peers | P4 live rollout order |

## Phases

- P0 — Capture red regressions and implementation evidence.
- P1 — Fix installer, systemd lifecycle, build identity, and Docker artifacts.
- P2 — Write the exact-SHA runbook and synchronize operator/architecture docs.
- P3 — Full deterministic gates plus independent adversarial review and bounded repair loop.
- P4 — Merge/push `develop`, confirm hosted CI, then deploy relay before peers and record sanitized evidence.

