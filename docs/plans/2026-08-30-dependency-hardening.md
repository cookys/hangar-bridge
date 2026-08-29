---
status: approved
date: 2026-08-30
---

# Dependency hardening

## Goal

Remove all high and critical advisories from Hangar Bridge's production and development dependency
graphs without changing the wire protocol, lowering coverage, or hiding advisories with audit
exceptions.

## Baseline

- Full audit: 1 critical, 19 high, 30 moderate, 6 low.
- Production audit: 0 critical, 8 high, 25 moderate, 5 low.
- Runtime high paths: Hono, Undici, and MCP SDK transitive dependencies.
- Development critical/high paths: Vitest 2 and its Vite/PostCSS dependency graph.

## Deliverables

1. Upgrade the smallest direct dependency set that reaches published patched versions.
2. Keep Node >=22 and the existing runtime/API contracts.
3. Add high-level audit commands to hosted CI so the baseline cannot silently regress.
4. Run clean-install typecheck, coverage tests, build, audit, diff check, and heterogeneous review.

## Acceptance

- `pnpm audit --prod --audit-level=high` exits 0.
- `pnpm audit --audit-level=high` exits 0; high and critical counts are both zero.
- `pnpm -r typecheck`, `pnpm -r test:ci`, `pnpm -r build`, and `git diff --check` exit 0.
- Hosted CI is green on `develop` and `main` at one identical SHA.

## Exclusions

- No wire schema, auth, routing, scheduler, or deployment behavior changes.
- No audit suppression, override outside an upstream-compatible semver range, or lowered test gate.
- No unrelated major upgrades, npm publication, or cross-host live acceptance in this project.
