# Relay follow-ups ledger (F-P3-1 + BACKLOG rows) — 2026-09-17

Branch `feat/relay-followups` off develop `565cb42`. Plan `docs/plans/2026-09-17-relay-followups.md` (+ `.rubric.md`).
Run shape: sonnet foremen ×2 (research, plan, red tests, first implementation; both hit the 40-Bash cap) → depth-0
(hangar @ openclaw) finished the renderer, verify, sol review and merge. No sealed campaign was dispatched on this line
(foreman #1 chose to implement red-first directly within budget; foreman #2 was capped before reaching the rail).

## Commits (red before green)

| commit | what |
|---|---|
| `5f425b3`, `49573e5` | plan + rubric; Item 4 corrected after plan-review gen 1 |
| `6ff760b` | test(red): per-session summary (registry) + sibling broadcast delivery (fanout) |
| `9ff06bf` | fix(relay): `PresenceSession.summary`; handle-level summary = most recent non-empty; `@team` excludes only the sending instance |
| `07d7485` → `2d233d8` | test(red) → peer-agent `list_peers`: per-session lines under a multi-session handle; `PeerSummary.sessions[]` gains `instance?`/`summary?` |
| `1f74575` | BACKLOG: `@team` row → Done; presence-durable and ephemeral-reply rows closed as stale |
| `ee6e8f9` → `c24726a` | test(red) → fix: summary selection compares timestamps only among non-empty summaries; `/v1/peers` route-level test |

Red on base: `../red-on-base.txt` (relay 3 failed / 38 passed; peer-agent 1 failed / 85 passed with develop sources).

## Verify (this host, systemd unit, corepack pnpm)

`typecheck` shared/relay/peer-agent ✓ · vitest shared 157 · relay 467 (+ route test → 468 after `ee6e8f9`) · peer-agent 547
(1 skipped) · `scripts/verify-groups.sh` ✓. `@hangar-bridge/e2e` typecheck fails on **develop** already
(`src/harness.ts(63,17) TS2345`) — pre-existing, excluded from the rail here, not touched.

## Reviews

- Plan review gen 1 (`plan-review-gen1.log`): sol (architecture seat) — 4 accepted blockers, all one finding: the
  "ephemeral messages have no working reply path" BACKLOG row is stale (base already mints `correlation_id`,
  persists a route, resolves replies via the alias; unknown parent = 404). Plan Item 4 rewritten to "close only".
- Terminal sol full diff `develop..2d233d8` (`panel1-codex-gpt-5.6-sol.json`): FIX-THEN-SHIP, 3 findings —
  `registry-empty-first` **accepted** → `c24726a` (a newer empty `sessions[0]` suppressed an older non-empty
  sibling; inverse-order test with its own clock); `phase1-route-coverage` **accepted** → `ee6e8f9`
  (`GET /v1/peers` asserts per-session summary + handle-level most-recent non-empty); `ledger-completeness`
  **accepted** → this file.

## Decisions / notes

- **Item 2** (presence heartbeats in the durable buffer): already fixed at base — `presence.ts` only calls
  `fanout.deliver`, never `store.insert`. Closed, no code.
- **Item 4** (ephemeral reply path): stale, see plan review. Closed, no code.
- **Item 5** — three rows left OPEN with a decision note each: *sibling processing rights* needs a product
  decision (pre-emptive claim vs assigned holder), no obviously-correct default, size L; *replay butler raw-row
  ceiling* and *replay butler double-drain* are each S but touch the same hot backlog-scan path without a shared
  regression harness — bundling them blind risks an ordering bug; do them together under one harness, separately.
- `bin/fleet` (dotfiles repo) does not render per-session summaries yet; the wire now carries them — a one-line
  follow-up in dotfiles, not here.
- Wire compatibility: `sessions[].summary` is additive; older peer-agents ignore it. Relay redeploy is the
  operator's hangar `deploy-hangar-bridge` step; nothing was restarted on this host.
