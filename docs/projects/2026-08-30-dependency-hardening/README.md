# Project — dependency hardening

> **Status:** in progress
> **Plan:** [dependency-hardening plan](../../plans/2026-08-30-dependency-hardening.md)
> **Base:** `49ecd7522abd5d2579ede69da203cc22ef9b55fa`
> **Branch policy:** direct `develop`, then verified fast-forward to `main`; no unattended PR.

## Project Goal

> **Final goal**: eliminate high/critical dependency advisories without changing Hangar's protocol
> or weakening its verification gates.
> **Success criteria**: production and full `pnpm audit --audit-level=high` both exit 0; full
> typecheck, coverage tests, build, diff check, heterogeneous review, and hosted CI all PASS.
> **Scope boundary**: package manifests, lockfile, CI audit enforcement, and this maintenance record;
> no runtime feature, wire/API, auth, deploy, scheduler, publication, or cross-host acceptance work.

## Scope Completeness Audit (L-1.5)

| Dimension | Coverage |
|---|---|
| Source + tests | No product source change planned; existing full suite and audit red/green are the verification artifacts. |
| User-facing docs | README and CLAUDE verification commands include the new audit gates; no behavior guide changes. |
| API / config / migration | No interface, config, schema, or data migration change. |
| CHANGELOG / version | No CHANGELOG exists; private workspace versions remain unchanged. |
| Version sync | Direct dependency specs and every lockfile occurrence must agree; checked from the complete diff. |
| Consumers | No downstream contract change; clean install and E2E cover workspace consumers. |
| Credit | No external source/design is copied; dependency release metadata is evidence only. |
| Dogfood | Hosted CI will enforce both production and full high-level audits on this repository. |

## User Requirements Ledger

| Requirement | Mapping |
|---|---|
| “不要走 copilot pipeline，走 autopilot 的 heto loop review / qc gate 的 dev-flow” | Dev-flow tracking, non-Copilot heterogeneous review, full QC before push. |
| “然後主 branch 用 develop” | Work lands on `develop`; `main` only fast-forwards after hosted verification. |
| “go” | Continuous CEO execution through the accepted tactical scope. |

## Deliverables

| ID | Deliverable | Evidence | Status |
|---|---|---|---|
| D1 | Runtime dependency remediation | production audit has zero high/critical | complete |
| D2 | Development toolchain remediation | full audit has zero high/critical; coverage unchanged | complete |
| D3 | CI ratchet and clean-install verification | hosted develop/main CI green | in progress |
| D4 | Heterogeneous review and closeout | reviewer PASS; exact SHAs recorded | pending |

## Decisions

- 2026-08-30: Audit output is the RED control; a successful high-level audit after patched direct
  upgrades is GREEN. No advisory is muted or ignored.
- 2026-08-30: Existing owner policy overrides feature-branch/PR defaults: commit verified fixes to
  `develop`, then fast-forward `main` only after hosted CI passes.
- 2026-08-30: Mission routing returned `LEGACY`; no READY/admission authority is claimed.
