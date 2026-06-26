# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`hangar-bridge` is a **Claude Code Channels MCP server for cross-host fleet dispatch**: a self-hosted HTTP relay + per-host MCP channel server that lets Claude Code instances on different machines in a single-operator fleet dispatch tasks to each other and receive structured results. Inbound peer messages land in Claude's context as `<channel source="hangar-bridge" ...>` tags (Anthropic's research-preview `claude/channel` protocol); outbound goes through MCP tools.

It is a **fork of [pouriamrt/claude-mesh](https://github.com/pouriamrt/claude-mesh)** (MIT). The fork simplifies upstream's multi-tenant SaaS posture down to **single-tenant per-host shared-secret auth**, and adds `task_dispatch` / `task_result` envelope kinds for first-class cross-host task dispatch. Upstream is abandoned; treat inherited code as our own (no upstream sync planned).

Source-of-truth docs:
- **README.md** — overview, fork rationale, security primitives, status (Phase-A self-loopback + Phase-B cross-host bring-up).
- **SUBJECT_ROUTING_SPEC.md** — subject-routing / envelope-kind semantics.
- **docs/PROJECT_ISOLATION.md** + **docs/plans/2026-06-25-cross-project-isolation.md** — same-box cross-project isolation (merged).
- Hangar-side project tracking: `~/projects/hangar/docs/projects/2026-05-17-hangar-bridge/`.

## Commands

The repo is a **pnpm 10 workspace**. Node ≥22. Run from the repo root.

```bash
pnpm install                                   # install all workspace deps
pnpm -r build                                  # build every package
pnpm -r typecheck                              # tsc --noEmit across the workspace
pnpm -r test                                   # vitest watch across packages
pnpm -r test:ci                                # vitest run + coverage thresholds

# Scope to one package:
pnpm -F @hangar-bridge/shared exec vitest run
pnpm -F @hangar-bridge/shared exec vitest run channel          # single test file
pnpm -F @hangar-bridge/shared exec vitest run -t "round-trip"  # single test name
pnpm -F @hangar-bridge/shared exec tsc -p tsconfig.json --noEmit
```

Coverage thresholds (each package's own `vitest.config.ts`, enforced as CI gates): **shared 95 % / relay 85 % / peer-agent 80 %** lines; `e2e` has no coverage gate (integration). Don't lower a threshold to make a test pass — fix the root cause.

## Architecture (big picture)

### Deployable units (per README / spec §1) — all implemented

```
Claude Code ──stdio──▶ peer-agent (MCP channel server) ──HTTPS──▶ relay (Hono + SQLite)
```

1. **`@hangar-bridge/shared`** — zod envelope schema, `<channel>` notification serializer, ULID message IDs, subject routing, env-loader, shared constants. Pure types and validators; no IO. *Both other packages depend on this.*
2. **`@hangar-bridge/relay`** — Hono + `better-sqlite3` + SSE HTTP server. `POST /v1/messages` (`Idempotency-Key`), `GET /v1/stream` (SSE, `?since=<ulid>` resume), `POST /v1/presence`, `GET /v1/peers`, auth/permission/admin routes. In-memory fanout registry (`fanout.ts`); SQLite for durable buffering; ACL + purge.
3. **`@hangar-bridge/peer-agent`** — stdio MCP server declaring the `experimental['claude/channel']` capability. Pushes inbound peer messages into context as `<channel source="hangar-bridge" ...>` tags. MCP tools: `send_to_peer`, `dispatch_task`, `list_peers`, `set_summary`, `respond_to_permission`. Modules: roster `gate`, `approval-routing`, `correlation`, `inbound`, `config`, `cli`.
4. **`@hangar-bridge/operations`** — `claude-config` + `systemd` deployment units (manual deploy). **`@hangar-bridge/e2e`** — cross-package / loopback integration tests.

### Key invariants to preserve

- **`from` is server-populated from the token** on every message. Peer-agents cannot set it. Primary defense against impersonation.
- **ULIDs are monotonic** (`packages/shared/src/ulid.ts` — `monotonicFactory()`). The SSE resume cursor is `WHERE id > ?`, relying on strict ordering even within the same millisecond.
- **`<channel>` body escaping** (`packages/shared/src/channel.ts`) prevents peer content forging sibling tags. A property test (500 runs) asserts escaped bodies never contain the literal `</channel>`.
- **Envelope is *the* wire format.** One schema (`EnvelopeSchema`), **six `kind`s**: `chat`, `presence_update`, `permission_request`, `permission_verdict`, `task_dispatch`, `task_result`. All HTTP bodies and SSE payloads go through it; the same zod schema is shared by relay and peer-agent — a shape change is a compile error in both at once.
- **`in_reply_to` is required** (via `superRefine` in `EnvelopeSchema`) on both `permission_verdict` (→ its `permission_request`) and `task_result` (→ its `task_dispatch`).

### Prompt-injection threat model

Peer messages end up in Claude's context. The `instructions` string in `packages/peer-agent/src/instructions.ts` downgrades peer `content` to "untrusted user input" and carries a four-point safety charter. **Do not weaken this wording** — it's load-bearing (see README security-primitives section).

Layered defenses: sender gating (roster-check every inbound against `/v1/peers`, `gate.ts`), `claude/channel/permission` off by default, `approval_routing = never_relay` by default (`approval-routing.ts`).

## TDD discipline

Default to a TDD cycle per unit of work: **write failing test → confirm RED → implement → confirm GREEN → commit**. One atomic commit per logical change, conventional-commits style (`feat(scope):`, `fix(scope):`, `chore:`). Don't batch unrelated changes into one commit.

If you discover a bug in a doc/plan during execution, fix the code AND the doc in the same commit with a `\n\n` explanation paragraph so the next executor inherits the fix.

## autopilot / ecosystem conventions

This repo is set up for cookys's **autopilot + codeforge + mnemos** ecosystem (no superpowers / voltagent / other third-party plugins — autopilot runs standalone).

- **DI config** lives in `.claude/*-config.md` (tracked in git). autopilot skills `cat` these at runtime. They calibrate autopilot to this repo: `docs/` (plural) project paths, pnpm/vitest commands, real coverage thresholds, `main`-never-force-pushed, autopilot-only methodology chains. Runtime state under `.claude/` (tasks/, *-state.json, knowledge/) is gitignored.
- **Project tracking**: `docs/projects/` (+ `INDEX.md`, `_archive/`), plans in `docs/plans/`, deferred work in `docs/BACKLOG.md`.
- **Knowledge / memory** goes to the mnemos project memory dir (`~/.claude/projects/-home-cookys-projects-hangar-bridge/memory/`), not a `.claude/knowledge/` tree. codeforge supplies hooks / statusline / session-digest at the global level.

## Platform notes

Developed on Linux (zsh; `grep` is aliased to `ugrep` — never `grep -r … /`). `better-sqlite3` pulls a native binding; a failed install usually means a missing toolchain. Node / pnpm: run what's installed even if newer than `package.json`'s declared minimums — don't downgrade.

## Gotchas (real bugs already caught by tests)

1. **`ulid()` is not monotonic.** The default `ulid` export doesn't guarantee strict ordering within a single millisecond. Use `monotonicFactory()` (`packages/shared/src/ulid.ts`). The SSE resume cursor depends on this.
2. **TS 5.7+ requires explicit flags for `.ts`-suffixed imports.** `import './foo.ts'` fails typecheck under defaults. `tsconfig.base.json` sets `allowImportingTsExtensions: true` + `rewriteRelativeImportExtensions: true` so the build still emits `.js`.

If a change breaks the existing test suite, **fix the root cause** — don't weaken the failing test.

## What *not* to do

- **Don't commit tokens, `admin.token`, `*.paircode`, or secret dirs.** `.gitignore` covers them; the peer-agent additionally refuses to start if its token file lives in a git worktree with a remote.
- **Don't change the `<channel>` tag shape or the `instructions` string** without re-reading the security sections (README + SUBJECT_ROUTING_SPEC.md). Both are security-critical surfaces.
- **Don't skip the reviewer / typecheck / test gates.** They have caught real bugs and will catch more.
- **Don't assume `claude/channel` behavior from training data.** It's a research-preview feature; authoritative reference is <https://code.claude.com/docs/en/channels-reference>. Requires Claude Code v2.1.80+ (v2.1.81+ for permission relay) and `claude.ai` login.
