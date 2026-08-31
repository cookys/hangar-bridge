# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`hangar-bridge` is a **Claude Code Channels MCP server for cross-host fleet dispatch**: a per-host MCP channel server using either the default self-hosted HTTP/SSE relay or an opt-in NATS transport. It lets Claude Code instances on different machines in a single-operator fleet coordinate, dispatch tasks, and receive structured results. Inbound peer messages land in Claude's context as `<channel source="hangar-bridge" ...>` tags (Anthropic's research-preview `claude/channel` protocol); outbound goes through MCP tools.

It is a **fork of [pouriamrt/claude-mesh](https://github.com/pouriamrt/claude-mesh)** (MIT). The fork simplifies upstream's multi-tenant SaaS posture down to **single-tenant per-host shared-secret auth**, and adds `task_dispatch` / `task_result` envelope kinds for first-class cross-host task dispatch. Upstream is abandoned; treat inherited code as our own (no upstream sync planned).

Source-of-truth docs:
- **docs/architecture.md** — system + connection diagrams, inherited-vs-fork provenance audit, and the verified protocol deep-dive (membership, auth, envelope, subject-ACL, delivery, correlation). Start here for the big picture.
- **README.md** — current SSE/NATS status, supported setup/CLI surface, security primitives, and closeout verification baseline.
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
pnpm audit --prod --audit-level high           # production high/critical advisory gate
pnpm audit --audit-level high                  # full dependency high/critical advisory gate

# Scope to one package:
pnpm -F @hangar-bridge/shared exec vitest run
pnpm -F @hangar-bridge/shared exec vitest run channel          # single test file
pnpm -F @hangar-bridge/shared exec vitest run -t "round-trip"  # single test name
pnpm -F @hangar-bridge/shared exec tsc -p tsconfig.json --noEmit
```

Coverage thresholds (each package's own `vitest.config.ts`, enforced as CI gates): **shared 95 % / relay 85 % / peer-agent 80 %** lines; `e2e` has no coverage gate (integration). Don't lower a threshold to make a test pass — fix the root cause.

## Architecture (big picture)

### Deployable units (per README / spec §1) — all implemented

```text
Claude Code ──stdio──▶ peer-agent ──default HTTP/SSE──▶ relay (Hono + SQLite v7)
                                  └─opt-in NATS───────▶ NATS + JetStream/KV
```

1. **`@hangar-bridge/shared`** — zod envelope schema, `<channel>` notification serializer, monotonic ULID message IDs, subject routing, claim bounds, env-loader, and shared constants. Pure types and validators; both transports depend on it.
2. **`@hangar-bridge/relay`** — Hono + `better-sqlite3` + SSE HTTP server. It provides durable messages, subject ACL/fanout, TTL presence, permission routes, and schema-v6 cooperative claims (`POST /v1/claim`, `GET /v1/claims`, `POST /v1/claim/release`). SSE remains the default transport.
3. **`@hangar-bridge/peer-agent`** — stdio MCP channel server. It selects SSE or opt-in NATS transport, pushes inbound messages as `<channel source="hangar-bridge" ...>` tags, and exposes `send_to_peer`, `dispatch_task`, `list_peers`, `set_summary`, the relay-backed claim tools when available, and optionally `respond_to_permission`.
4. **`@hangar-bridge/operations`** — relay/NATS config, provisioning, and systemd deployment artifacts. **`@hangar-bridge/e2e`** — cross-package, loopback, config, and live local-NATS integration tests.

### Key invariants to preserve

- **`from` is authoritative.** The relay stamps it from the token on SSE; NATS derives and validates it against the authenticated sender lane/roster. Peer payloads cannot impersonate another handle.
- **ULIDs are monotonic** (`packages/shared/src/ulid.ts` uses `monotonicFactory()`). SSE cursor resume relies on strict ordering even within one millisecond.
- **`<channel>` body escaping** (`packages/shared/src/channel.ts`) prevents peer content forging sibling tags. A property test (500 runs) asserts escaped bodies never contain literal `</channel>`.
- **Envelope is *the* wire format.** One schema, six `kind`s (`chat`, `presence_update`, `permission_request`, `permission_verdict`, `task_dispatch`, `task_result`), and an optional dotted `subject`. SSE and NATS must preserve the same schema and ACL semantics; subjected `@team` is allowed only for chat and is receiver-filtered.
- **`in_reply_to` is required** on both `permission_verdict` and `task_result`; replies must use `subject=null`.
- **Claims are cooperative and relay-backed.** They are advisory, team-scoped, single-live-owner locks with TTL expiry. During NATS P5 the relay token/API is an optional compatibility path; P6 relay deletion is blocked until claims are ported or deliberately retired.

### Prompt-injection threat model

Peer messages end up in Claude's context. The `instructions` string in `packages/peer-agent/src/instructions.ts` downgrades peer `content` to "untrusted user input" and carries a six-point safety charter (points 5 and 6 forbid peer-requested configuration changes and executing command-like text in peer content). **Do not weaken this wording** — it's load-bearing (see README security-primitives section).

Layered defenses: sender gating (roster-check every inbound against `/v1/peers`, `gate.ts`), `claude/channel/permission` off by default, `approval_routing = never_relay` by default (`approval-routing.ts`).

## TDD discipline

Default to a TDD cycle per unit of work: **write failing test → confirm RED → implement → confirm GREEN → commit**. One atomic commit per logical change, conventional-commits style (`feat(scope):`, `fix(scope):`, `chore:`). Don't batch unrelated changes into one commit.

If you discover a bug in a doc/plan during execution, fix the code AND the doc in the same commit with a `\n\n` explanation paragraph so the next executor inherits the fix.

## autopilot / ecosystem conventions

This repo is set up for cookys's **autopilot + codeforge + mnemos** ecosystem (no superpowers / voltagent / other third-party plugins — autopilot runs standalone).

- **DI config** lives in `.claude/*-config.md` (tracked in git). autopilot skills `cat` these at runtime. They calibrate autopilot to this repo: `docs/` (plural) project paths, pnpm/vitest commands, real coverage thresholds, `develop`-never-force-pushed, autopilot-only methodology chains. Runtime state under `.claude/` (tasks/, *-state.json, knowledge/) is gitignored.
- **Project tracking**: `docs/projects/` (+ `INDEX.md`, `_archive/`), plans in `docs/plans/`, deferred work in `docs/BACKLOG.md`.
- **Knowledge / memory** goes to the mnemos project memory dir (`~/.claude/projects/-home-cookys-projects-hangar-bridge/memory/`), not a `.claude/knowledge/` tree. codeforge supplies hooks / statusline / session-digest at the global level.

## Platform notes

Developed on Linux (zsh; `grep` is aliased to `ugrep` — never `grep -r … /`). `better-sqlite3` pulls a native binding; a failed install usually means a missing toolchain. Node / pnpm: run what's installed even if newer than `package.json`'s declared minimums — don't downgrade.

## Diagnosing the live fleet

**Before comparing two numbers from different systems, ask whether they measure the same
INSTANT.** This is the single most repeated diagnostic error in this project — three
distinct occurrences in one day, each with different surface symptoms:

- two presence snapshots taken 69 minutes apart, read as a same-moment field diff
- a 20-minute window of DB rows, compared against a live registry snapshot
- an hour-old `ps` listing, used as the current process set

Both numbers are true, both readable, units identical. The only thing that differs is
*when* each measured, and that dimension is invisible in the number itself. The fleet
also changes faster than the observation cycle — a peer-agent died between two `ps`
runs an hour apart.

**Make it structural, not a habit: write both timestamps on the same line.**
`ps @ 05:12 → 4 procs` next to `DB window @ 04:50–05:10` makes the mismatch visible on
sight, instead of waiting for someone to re-derive it later.

A reference point can be stale even when a tool calls it current. `git status` reporting
*up to date* means your HEAD matches the remote-tracking ref from your **last fetch**, not
the remote. Three fleet peers audited a repo the same afternoon and all three reasoned
from a stale ref; one happened to be correct only because it had pushed an hour earlier.
This case is nastier than the others here because the tool *asserts* the healthy state
rather than merely returning nothing — it hands you a green light on a question it did
not actually answer.

Read the remote without writing to the repo, since `git fetch` updates refs and these
boxes run several sessions against one checkout — an audit should not mutate what it is
auditing:

```bash
git rev-parse --short HEAD                    # where I am
git rev-parse --short origin/master           # where I THINK the remote is (stale)
git ls-remote origin master | cut -c1-7       # where it actually is, writes nothing
```

The second and third disagreeing is the whole finding. A verification method with side
effects is a different tool from a read-only one whenever a checkout is shared.

**Integrating on a shared checkout.** Several sessions on this box work out of one
worktree, and git's non-fast-forward rule protects pushes, not working trees — a sibling's
ordinary `pull` silently invalidated another session's freshly-stated understanding of the
repo today. Before merging, prove the incoming commits do not touch anyone's in-flight
files:

```bash
comm -12 <(git diff --name-only) <(git diff --name-only HEAD origin/master)   # must be empty
```

Then `merge`, never `rebase` — rebase moves someone else's uncommitted work out from under
them. Note also that a statement about your own repo state expires the moment you act:
a peer announced it would not pull, then merged three minutes later for an unrelated
reason and picked up the change as a side effect.

Prefer an INVARIANT over a sample when one exists. Example: to decide whether a process
is publishing presence, do not count rows in a time window — `POST /v1/presence`
unconditionally calls `presence.set()`, and the registry TTL (90s) exceeds the heartbeat
interval (30s), so anything still publishing *cannot* be absent from `/v1/peers`. Absence
proves it is not publishing, with no sampling window to get wrong.

## Gotchas (real bugs already caught by tests)

1. **`ulid()` is not monotonic.** The default `ulid` export doesn't guarantee strict ordering within a single millisecond. Use `monotonicFactory()` (`packages/shared/src/ulid.ts`). The SSE resume cursor depends on this.
2. **TS 5.7+ requires explicit flags for `.ts`-suffixed imports.** `import './foo.ts'` fails typecheck under defaults. `tsconfig.base.json` sets `allowImportingTsExtensions: true` + `rewriteRelativeImportExtensions: true` so the build still emits `.js`.

**An assertion that nothing changed must bind a known concrete value.** `expect(after).toBe(before)`
passes when both sides are correct AND when both were wiped, so it certifies the exact
regression it was written to catch. Assert the value itself — `expect(v).toBe(104300)` —
whenever the point of the test is that something survived an operation.

If a change breaks the existing test suite, **fix the root cause** — don't weaken the failing test.

## What *not* to do

- **Don't commit tokens, `admin.token`, `*.paircode`, or secret dirs.** `.gitignore` covers them; the peer-agent additionally refuses to start if its token file lives in a git worktree with a remote.
- **Don't change the `<channel>` tag shape or the `instructions` string** without re-reading the security sections (README + SUBJECT_ROUTING_SPEC.md). Both are security-critical surfaces.
- **Don't skip the reviewer / typecheck / test gates.** They have caught real bugs and will catch more.
- **Don't assume `claude/channel` behavior from training data.** It's a research-preview feature; authoritative reference is <https://code.claude.com/docs/en/channels-reference>. Requires Claude Code v2.1.80+ (v2.1.81+ for permission relay) and `claude.ai` login.
