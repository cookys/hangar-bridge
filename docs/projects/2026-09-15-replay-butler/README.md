# Replay butler

## Project Goal

> **Final goal**: a session that reconnects (or a handle that enrolls) after a long absence receives ONE
> summary of its chat backlog instead of every message, and pulls the rest on its own terms; nothing
> else about delivery changes.
> **Success criteria**: (1) relay: with `replay_max=N` and a chat backlog > N the SSE emits exactly one
> `backlog` event, zero chat `message` events from the backlog, every non-chat row, then `backlog_end`
> (T3/T14); with `replay_max` absent the event sequence is byte-identical to today (T1); (2) peer-agent:
> one synthetic notification, cursor advanced only at `backlog_end`, `pendingBacklog` survives restart
> (T9/T10/T12); (3) `poll_inbox` reports `pending_after` including through the spool merge (T7/T18);
> (4) `pnpm -r typecheck && pnpm -r test:ci` green per phase, coverage thresholds unchanged (shared 95 /
> relay 85 / peer-agent 80); (5) live: a handle offline > 1 day reconnects and `fleet peers` shows
> `backlog:N` while the harness receives one summary (§5 step 3).
> **Scope boundary**: SSE lane only (no NATS); presentation only (no TTL/purge, no mailbox change);
> only `kind === 'chat'` is summarized; stream/poll predicate unification and `replay_max_age` are out.

- Plan: [replay butler r3](../../plans/2026-09-15-replay-butler.md) — hetero plan loop 2 generations,
  receipts exit 0 (see plan §7)
- Base: `65585b6` (develop) · Branch: `feat/replay-butler` · Merge target: `develop`
- Status: phases complete — awaiting finish-flow (merge to develop) and relay-first deploy
- Verification contract: `corepack pnpm -r typecheck && corepack pnpm -r test:ci`, each phase RED first
  (new vitest cases fail on base, pass on head); risk = medium (wire format additive, cursor semantics)
  → hetero review stays gating per phase.
- TaskCreate is unavailable to this model (Claude 5 gated, `CLAUDE_CODE_ENABLE_TODO_TOOLS` unset) —
  the phase table below is the tracking surface; L-1.6 / L-5 forcing functions are recorded here.

## Scope completeness audit (L-1.5)

| Dimension | In scope | Coverage |
|---|---:|---|
| Source code + tests | yes | shared (event types), relay (stream, messages, store), peer-agent (config, stream, index, tools, cursor-store, inbox-spool, agent-call-ingress, switchboard) |
| User-facing docs | yes | `docs/architecture.md` §4 replay butler; hangar runbook rollout order (P5) |
| API/interface reference | yes | additive: SSE `backlog`/`backlog_end` events, `replay_max` query, `pending_after`/`pending_capped` fields; documented in architecture.md |
| Config templates/examples | yes | `inbox.replay_threshold` in peer-agent config schema + `packages/operations` example config if one lists `inbox` |
| CHANGELOG | no | repository has no changelog; project ledger carries notes |
| Version bump | no | no package publication; `RELAY_VERSION` untouched (additive) |
| Migration notes | no | no schema change; cursor-store file gains one optional key (backward-compatible read) |
| Dependent systems | yes | dotfiles `fleet` (poll only — ignores new fields, verified `bin/fleet` parses only messages/next_cursor); ChatGPT courier (gets `pending_after` via poll_inbox header) |
| Credit/attribution | no | nothing absorbed |
| Dogfood target | yes | hub relay + this session's peer-agent after rollout |

User-stated requirements ledger: (a) "一上線就全塞" must stop above a threshold → P2/P4; (b) "管家等待
他 load 完出一個 summary 提醒 harness/user 處理" → P2 `backlog` + P4 synthetic notification; (c) "把控制權
交給 agent/user" → cursor advance + `poll_inbox` resume + `pending_after` (P3/P4).

## Skill routing (L-1.6)

| Area | Routing entry | Action |
|---|---|---|
| SSE / cursor / resume / ULID ordering | autopilot:debug | invoked for the watermark + cursor-ordering design; evidence-first reading of stream.ts drain and cursor-store done in plan review (file:line in dispositions) |
| envelope / zod schema | autopilot:debug | same invocation; `backlog` event is a new SSE event type, envelope schema untouched |
| coverage / vitest | autopilot:test-strategy | invoked before P2: RED-first per phase, thresholds per memory (shared 95 / relay 85 / peer-agent 80) |
| channel tag / escaping | autopilot:reviewer | synthetic notification text is relay-derived (sender handles) — escaping reviewed at P4 hetero review |

## Phases (plan §3 grouped into mergeable units)

| Phase | Plan steps | Status | Evidence |
|---|---|---|---|
| relay | P1 shared types + P2 stream butler + P3 poll `pending_after` | complete | `9683b66`; T1–T7, T13–T16, T19 (17/17); relay 406 passed, cov 94.85 %; hetero g1 MiniMax-M3 xhigh SHIP-AS-IS (5 findings, all refuted with evidence), receipt exit 0 |
| peer-agent | P4 | complete | `6dc0295`; replay-butler.test.ts 20 cases; peer-agent 520 passed, cov 92.85 %; hetero g1 SHIP-AS-IS (0 findings, invariant proof present), receipt exit 0 |
| docs | P5 | complete | architecture.md §4 replay butler, README (summary suffix + `inbox.replay_threshold`), hangar runbook step 8 (hangar commit); hangar BACKLOG row closes on deploy |
| L-5 finish-flow | — | pending | autopilot:finish-flow |

## Decisions

- Phases grouped 3→relay / 1→peer-agent / 1→docs: relay must deploy first (§5), so relay-side steps
  share one review + one merge; peer-agent is independently revertible.
- `pending` counts the stream population (what SSE would have pushed), not the poll count; poll returns
  a superset and the summary says so (plan §2.1, gen-2 adjudication).

## L-5.1 Final goal review (2026-09-15)

| # | Success criterion | Evidence | Verdict |
|---|---|---|---|
| 1 | relay: `replay_max=N`, chat backlog > N ⇒ exactly one `backlog`, zero chat `message` from the backlog, every non-chat row, then `backlog_end`; absent ⇒ byte-identical | `packages/relay/tests/integration/replay-butler.test.ts` T1 (50 rows, no `backlog`), T3 (`['backlog','backlog_end']`, rows unstamped/ungranted), T14 (`['backlog','message','message','backlog_end']`), T13 watermark; 17/17 green, RED 15/17 on base | PASS |
| 2 | peer-agent: one synthetic notification, cursor advanced only at `backlog_end`, reminder survives restart | `packages/peer-agent/src/replay-butler.test.ts` T8/T10 (event order → callbacks), T14b (drop before end ⇒ no cursor advance), T12 (persist + reload), T9 (no msg_id) ; 20/20 green | PASS |
| 3 | `poll_inbox` reports `pending_after` through the spool merge | relay T7/T7b; peer-agent T18/T18b/T18c + tool-level header test | PASS |
| 4 | typecheck + test:ci green per phase, thresholds intact | relay 406 passed / 94.85 % (≥85); peer-agent 520 passed / 92.85 % (≥80); shared 149 / 100 %; e2e 62 passed | PASS |
| 5 | live: offline > 1 day handle reconnects, `fleet peers` shows `backlog:N`, one summary received | **DEFERRED to deploy** — needs the relay restarted via `install-relay.sh` (drops every fleet SSE for seconds; operator-gated per hangar destructive-op rule) and a peer-agent rebuilt on one host. Procedure: hangar runbook `hangar-bridge-fleet-deployment.md` step 8. | DEFERRED (named) |

Requirements ledger: (a) stop the flood above a threshold → relay P2 (T3) ✔; (b) butler waits, emits one summary → P2 `backlog` + P4 synthetic notification (T8/T9) ✔; (c) control handed to agent/user → cursor advance + `poll_inbox` resume hint + `pending_after` (T7/T18/T20b) ✔.
