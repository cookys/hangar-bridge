# Projects Index — hangar-bridge

autopilot project-tracking lives here (plural `docs/`, per `.claude/project-lifecycle-config.md`).
One row per tracked L-size project. Archived projects move to `_archive/`.

| Status | Project | Plan | Notes |
|--------|---------|------|-------|
| ✅ merged | same-box cross-project isolation | [docs/plans/2026-06-25-cross-project-isolation.md](../plans/2026-06-25-cross-project-isolation.md) | Phases 1–4; merged in `bc8fcf3` |

## Active

| Status | Project | Plan | Notes |
|--------|---------|------|-------|
| ✅ deployed | [pane final mile P3b — peer-agent local_target decline](2026-09-19-pane-final-mile-p3b/DEPLOY.md) | fleet-comms plan `2026-09-19-cockpit-owns-the-pane-final-mile.md` §4 P3b | `5524043` on relay hub + 8 peer clones + itx courier, 2026-09-20; relay untouched (package unchanged) |
| 🔄 in progress | [exact-SHA deployment hardening](2026-08-30-exact-sha-deployment-hardening/README.md) | [docs/plans/2026-08-30-exact-sha-deployment-hardening.md](../plans/2026-08-30-exact-sha-deployment-hardening.md) | relay-first upgrade runbook, build identity, installer regressions |
| 🔄 in progress | [relay→NATS migration](2026-07-02-relay-to-nats-migration/README.md) | [docs/plans/2026-07-02-relay-to-nats-migration.md](../plans/2026-07-02-relay-to-nats-migration.md) | /l6 hetero 執行;P0–P4 自主,P5/P6 Board 閘 |

## Archive

| Status | Project | Plan | Notes |
|--------|---------|------|-------|
| ✅ complete | [replay butler](_archive/2026-09-15-replay-butler/README.md) | [docs/plans/2026-09-15-replay-butler.md](../plans/2026-09-15-replay-butler.md) | merged `c094b52` 2026-09-15; relay-first deploy pending (operator) |
| ✅ complete | [dependency hardening](_archive/2026-08-30-dependency-hardening/README.md) | [docs/plans/2026-08-30-dependency-hardening.md](../plans/2026-08-30-dependency-hardening.md) | Remediation `356f5f1`; hosted `develop` and `main` CI green |
| ✅ complete | [hangar-bridge mainline closeout](_archive/2026-07-21-hangar-bridge-closeout/README.md) | — | official integration merge `134e2bc`; verified handoff for Plan 029 P10 |
