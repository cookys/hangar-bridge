# Exact-SHA deployment hardening

## Project Goal

> **Final goal**: make Hangar Bridge's SSE fleet safely and reproducibly upgradable from an exact Git SHA.
> **Success criteria**: all commands and behavioral checks in the linked plan pass, hosted `develop` CI is
> green at the merged SHA, and any live rollout proves the same SHA at `/health` while following relay-first
> ordering.
> **Scope boundary**: relay/peer deployment correctness, immutable revision evidence, runbook and related
> documentation; no wire-protocol, scheduler, publication, visibility, or NATS-cutover changes.

- Plan: [exact-SHA deployment hardening](../../plans/2026-08-30-exact-sha-deployment-hardening.md)
- Base: `9eeb4855089c52f0d8c06fd3d73053aa4f78b2f5`
- Merge target: `develop`
- Status: in progress

## Scope completeness audit

| Dimension | In scope | Coverage |
|---|---:|---|
| Source code + tests | yes | relay health, MCP installer, systemd installer, Docker build |
| User-facing docs | yes | root README and fleet upgrade runbook |
| API/interface reference | yes | additive `/health.build_revision` field |
| Config templates/examples | yes | Claude MCP env and Docker compose peers mount |
| CHANGELOG | no | repository has no changelog; project ledger and README carry release notes |
| Version bump | no | no package publication; build identity is separate from semver |
| Migration notes | yes | runbook records schema-v7 backup/restore boundary |
| Dependent systems | yes | openclaw relay and peer hosts, deployed only after CI acceptance |
| Credit/attribution | no | no external implementation is absorbed |
| Dogfood target | yes | the current Hangar Bridge fleet is the final acceptance target |

## Progress

| Phase | Status | Evidence |
|---|---|---|
| P0 regressions | complete | relay health RED 7; MCP installer RED 5; relay installer RED 15; systemd limiter RED 1; Docker RED 2; Node-path repair RED 6; health-revision mutant RED 1 |
| P1 implementation | complete | focused GREEN; shellcheck; systemd-analyze; relay deploy artifact generated |
| P2 runbook/docs | complete | `docs/DEPLOYMENT.md`; deterministic doc-drift links/fences/script-refs PASS |
| P3 quality/review | in progress | full typecheck/test/build/audit PASS; heterogeneous final review pending |
| P4 merge/deploy | pending | pending |

## Decisions

- `develop` is the authoritative integration/merge target for this project, overriding the older local
  dev-flow config that names `main`.
- A static package version is not deployment identity. Live acceptance requires a full 40-hex build SHA.
- Relay rollout precedes peer rollout so peer behavior is never judged against an unknown relay build.
- Rollback means restoring code and database as a pair; disabling a unit is not rollback.
