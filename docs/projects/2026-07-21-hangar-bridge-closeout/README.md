# Project — hangar-bridge closeout and mainline integration

> **Status:** in progress
> **Date:** 2026-07-21
> **Branch:** `chore/hangar-bridge-closeout`
> **Integration target:** `main`
> **Inputs:** `origin/main@c5a3103` (fleet-coordination stage3) + `origin/develop@a9d72eb` (relay→NATS P0–P4)

## Project Goal

> **Final goal:** Integrate the completed stage3 claim/presence/broadcast work and the completed
> relay→NATS P0–P4 substrate onto the official `main` branch, leave the repository mechanically
> green and clean, document its exact public claim contract and remaining operational gates, push
> the result, remove the closeout branch, and hand the verified state to the agent implementing
> Plan 029 P10.
>
> **Success criteria:** Both input tips are ancestors of `main`; `corepack pnpm -r build`,
> `corepack pnpm -r typecheck`, and `corepack pnpm -r test:ci` exit 0 with all configured coverage
> gates passing; running the quality suite does not modify tracked files; claim schemas/kinds,
> compatibility, and deferred work are documented; local and remote `main` resolve to one SHA;
> the closeout feature branch is absent locally and remotely; a handoff file names the final SHA.
>
> **Scope boundary:** Includes branch integration/conflict reconciliation, tests, a hermetic fixture
> fix, user/operator docs, project tracking, commit/merge/push, branch cleanup, and handoff. Excludes
> P5 real-fleet cutover/soak, P6 irreversible relay deletion, production deployment, and Plan 029
> P10 implementation; those remain explicit downstream work.

## Acceptance Patterns

| Pattern | Application | Evidence |
|---|---|---|
| A1 — Round-trip parity | Preserve producer/consumer agreement for shared envelope, relay, SSE/NATS peer transport, and claim tool/route contracts | typecheck + unit/integration tests; schema field comparison in closeout docs |
| A4 — Idempotency | The full quality run is re-runnable without changing tracked files | run the gate, then `git diff --exit-code` and `git status --porcelain` |
| A6 — Live end-to-end | NATS changes require a real local `nats-server`, not stubs alone | existing `nats-transport.live.test.ts` and P2 independent live test run in `test:ci` |

## Scope Completeness Audit

| Dimension | In scope / disposition |
|---|---|
| Source + tests | Merge all commits from both tips; reconcile shared/relay/peer-agent overlaps; fix fixture mutation; run full workspace gates |
| User-facing docs | Reconcile `README.md`, architecture/spec status, claim contract, compatibility, and caveats |
| API/interface | Document `claim_asset` / `list_claims` input and output schemas plus supported claim kinds |
| Config/examples | Preserve SSE default and opt-in `transport: 'nats'`; document cutover inputs without performing them |
| CHANGELOG/version | No CHANGELOG exists and packages remain private `0.1.0`; no version bump in this closeout |
| Migration/rollback | Preserve SQLite schema v6 claim migration and relay→NATS P5/P6 cutover runbook; no production mutation |
| Consumers | Fleet remains SSE-compatible by default; NATS fleet cutover is deferred and Board-gated |
| Dogfood | Build/typecheck/test:ci plus live local NATS tests; no staging environment exists |
| Credit/attribution | Existing MIT/upstream and NATS references remain intact; no new external design absorbed |

## User Requirements Ledger

| Verbatim requirement | Mapped work |
|---|---|
| 「跑測試」 | P2 + L-5.2 full build/typecheck/test/coverage/live-NATS gate |
| 「更新文件」 | P3 + L-5.4 scoped doc-sync and corrections |
| 「commit」 | Commit conflict resolution/docs on the closeout branch |
| 「merge/push 到正式主分支」 | L-5.3 merge with QC trailer to `main`, then push and remote-SHA verification |
| 「清理 feature branch」 | L-5.7 delete `chore/hangar-bridge-closeout` locally/remotely |
| 「寫 handoff」 | Final `docs/HANDOFF.md` snapshot for the next agent |
| 「列出最終 SHA、claim_asset/list_claims schema、支援的 claim kinds、相容性與 deferred items」 | P3 closeout reference + final handoff |
| 「準備交給另一個 agent 接續 Plan 029 P10」 | Handoff read-order, fixed decisions, first command, and verification contract |

## Phases

| Phase | Work | Status |
|---|---|---|
| P1 | Merge `origin/develop` into the main-based closeout branch and reconcile six overlapping files | complete |
| P2 | Make the test gate hermetic; verify combined behavior, coverage, and real local NATS paths | complete |
| P3 | Reconcile docs/project tracking and write the claim/compatibility/deferred closeout reference | complete |
| L-5 | Quality review, merge/push, post-merge doc-sync, archive/session cleanup, branch deletion | in progress |
| Handoff | Snapshot final `main` state for Plan 029 P10 | prepared; SHA seal follows merge |

## Decisions

- `main` is the official integration target per project config; `develop` is an input branch, not
  the final delivery branch.
- P5/P6 remain deferred because fleet cutover needs real host/operator inputs and relay deletion is
  explicitly irreversible; this closeout does not broaden authorization to those operations.
- Stage3 relay claims remain available while SSE is the default. The NATS substrate stays opt-in,
  so integrating P0–P4 must preserve both transport paths until a later cutover.
- There is one generic asset claim kind; `repo:` / `file:` / `config:` prefixes are conventions, not
  schema-enforced variants. [`docs/CLAIMS.md`](../../CLAIMS.md) is the contract authority.
- NATS core messaging starts independently of claims. Claim tools are advertised only after a
  bounded authenticated relay probe; failure omits them. Durable task consumption separately waits
  and retries until permanent KV dedup is ready.
- NATS durable addressing is handle-scoped, so a host-global lock enforces one live local process
  per handle. Multi-session/session-addressed NATS routing remains deferred.

## Verification evidence

- `corepack pnpm -r build`: PASS.
- `corepack pnpm -r typecheck`: PASS after reconciling the stage3 `Deps.claims` requirement in E2E.
- `corepack pnpm -r test:ci`: PASS — 523 passed, 3 explicitly gated skips; shared/relay/peer-agent
  coverage thresholds all passed and live local-NATS tests ran.
- Test hermeticity: tested staged tree `fb3584819fbc7cb86cd58f51d6eb510643bc8cc9` stayed unchanged;
  its binary staged-diff hash stayed
  `5234b3a155f0b6657bf46d769513a8f8b7ddf1d1917e90b11584989c225c5485`, and the porcelain-status
  hash stayed `e94426b61cc124c14ac4e64e4c5df8b199276ee1b47ab03e1a813c1f34b49e2e`
  before and after the full build/typecheck/test run.
- Independent review found one final durable-correlation blocker: a wrong-peer `task_result` could
  be dropped by the dispatcher but still consume the permanent completion marker. The callback now
  returns an explicit delivery disposition; terminal rejections do not write the marker. The
  application dedup cache binds each `msg_id` to a stable envelope fingerprint, so reusing a prior
  ID with different sender/kind/content/meta cannot forge `already-delivered`. A composed regression
  primes that collision and proves the legitimate peer can still complete the same correlation.

## Deferred register

- NATS P5 real-host cutover/soak and all fleet credential/config mutations.
- NATS P6 relay deletion, including the prerequisite claim-authority decision/migration.
- A transport bridge if the operator requires simultaneous SSE↔NATS interoperation.
- A production MCP tool that emits structured `task_result`; receivers currently return task
  completion through `send_to_peer` chat even though the wire kind remains supported.
- Session-addressed NATS task routing so multiple local Claude sessions can share one fleet handle.
- Two-real-Claude outbound permission relay smoke (`CLAUDE_DRIVER=cli`).
- Operator rollout of production subject ownership/interest settings.
- Legacy Docker packaging repair/deprecation and the remaining items in [`docs/BACKLOG.md`](../../BACKLOG.md).
- Plan 029 P10 implementation; this closeout only prepares its verified handoff.
