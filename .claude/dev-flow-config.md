# Dev Flow — Project Config (hangar-bridge)
# Unified config for the dev-flow lifecycle (session start / execution / close).

## Size Rules (override defaults)
- **S**: single package, no public wire-format/interface change → direct commit on a branch
- **L**: 3+ packages OR touches the envelope schema / `<channel>` tag / instructions string → plan + project + PR
- **Fix**: hotfix to a single bug, tests stay green → branch + fast close
- TDD discipline is mandated: each unit of work = failing test → RED → implement → GREEN → one commit.

## Quality Gate
- S/Fix: `pnpm -r typecheck && pnpm -r test:ci`
- L: `pnpm -r typecheck && pnpm -r test:ci` per phase; full review before merge
- NOTE: `pnpm -r lint` is currently a no-op (no package defines a `lint` script). Do not rely on it as a gate.

## Build & Deploy
- Build: `pnpm -r build`
- Deploy: manual — relay/peer-agent run via `packages/operations/systemd/` units; no automated deploy step.

## Project Paths
- Where projects live: `docs/projects/`   (NOTE: plural `docs/`, not autopilot's default `doc/`)
- Backlog: `docs/BACKLOG.md`
- Plans: `docs/plans/` (date-prefixed `YYYY-MM-DD-<name>.md`)

## Bootstrap (L-size)
- No bootstrap script ships yet. Create `docs/projects/<date>-<name>/README.md` by hand from the approved plan
  (see autopilot `skills/project-lifecycle/references/plan-bootstrap.md` for the structure).

## Branch Rules
- Default branch: `main`
- `main` is NEVER force-pushed (鐵律). Feature branches: `feat/<scope>`, `fix/<scope>`, `chore/<scope>`, `docs/<scope>`.
- Branch freshness: rebase/merge `main` before merging if >20 commits behind.

## Knowledge Paths
- Memory dir: `~/.claude/projects/-home-cookys-projects-hangar-bridge/memory/`
- Memory index: `MEMORY.md` in that dir.
- autopilot:learn writes HERE, not to a `.claude/knowledge/` tree — keep one knowledge home.

## Pre-Work Gates
- `git fetch origin && git status`
- `pnpm install` (only if `pnpm-lock.yaml` changed)

## Skip Conditions
- Skip session-start gates when: branch already up-to-date with origin AND working tree clean.

## Knowledge Extraction
- Auto-record triggers: build/native-binding error fixed after 2+ attempts; a `claude/channel` behavior that
  contradicted assumptions; a security-invariant decision (escaping / sender-stamp / roster gate) iterated.
- Output: project memory dir (above).

## Docs Sync (staleness check at session end)
- `README.md`, `SUBJECT_ROUTING_SPEC.md`, `docs/PROJECT_ISOLATION.md`, `CLAUDE.md`

## Backlog Management
- Backlog file: `docs/BACKLOG.md`
- Auto-add deferred items: true

## Post-Work Commands
- `pnpm -r typecheck && pnpm -r test:ci`

## L-5 / H-9 Closing
- Delegated to autopilot:finish-flow. Merge target: `main`. See `.claude/finish-flow-config.md` if present.
