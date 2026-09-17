# Handoff — relay follow-ups line (F-P3-1 + BACKLOG rows) — foreman #2

Foreman #2 hit the 40-Bash-call cap (ironlaw #6) almost immediately after
finishing the commit-splitting step; writing this instead of a final report.
Repo: `~/projects/hangar-bridge`, branch `feat/relay-followups` (off develop
tip `565cb42`). This supersedes the previous HANDOFF-foreman.md (foreman #1's),
whose "NOT done — pick up here" list is still the authoritative TODO except
for item 2 (commit the implementation), which is now done — see below.

## What foreman #2 did (all of it — small session, capped fast)

1. Read `common.md`, this handoff (foreman #1's version), and the plan file
   (`docs/plans/2026-09-17-relay-followups.md`) sections it pointed at.
2. Verified the uncommitted working-tree diff on `packages/relay/src/fanout.ts`
   and `packages/relay/src/presence/registry.ts` matched foreman #1's
   description exactly (per-session `summary` field + most-recent-non-empty
   handle-level selection; `@team` fanout excludes only the sending instance).
3. Fixed one comment typo in `fanout.ts` ("most likest" → "most likely") —
   cosmetic, no logic change.
4. **Committed the implementation, split into two commits** (foreman #1 had
   left `docs/plans/...md`'s Item-4 correction + the new rubric file +ancillary
   the two code files all uncommitted together):
   - `49573e5` — `docs(plans): relay follow-ups — correct Item 4 after gen-1
     review, add rubric` (the plan.md Phase-3→Item-4 rewrite + new
     `docs/plans/2026-09-17-relay-followups.rubric.md`, both from foreman #1's
     gen-1 review cycle, previously uncommitted).
   - `9ff06bf` — `fix(relay): per-session summary (F-P3-1) + @team excludes
     only sending instance` (the two source files only).
   - **Correction made mid-step**: my first attempt at the docs commit
     accidentally swept up the two source files too (they were already
     `git add`-ed from a prior step) — caught it immediately via
     `git show --stat`, `git reset --soft HEAD~1`, `git reset <src files>`,
     and re-committed cleanly as the two commits above. No push happened at
     any point, so this was a safe local fix, not a history rewrite of shared
     work.
5. Confirmed `AUTOPILOT_SESSION_MODE_DIR` mask dir still exists and is empty:
   `/tmp/claude-1000/-home-cookys-projects-hangar/194c026e-dd23-4721-a1d0-9fc7334e3b4d/scratchpad/empty-mode`.
6. Confirmed `package.json` has `test:ci` / `typecheck` scripts (via `pnpm -r`)
   and `scripts/verify-groups.sh` exists at repo root.
7. Ran `node ~/projects/autopilot/bin/autopilot.js status readiness --json
   --probe` — tail of output showed `usable_now: true` for at least one
   role/tuple; did not capture the full JSON or check every role before the
   cap hit.
8. For Phase 1's `tools.ts` renderer step (task item c): read
   `packages/peer-agent/src/tools.ts` (`renderPeerLine`/`renderGroupedPeers`,
   lines ~464-490) and `packages/peer-agent/src/outbound.ts` (`PeerSummary`
   interface, line 74). **Found a gap the plan did not call out**: `PeerSummary`
   client-side TypeScript type declares `sessions: Array<{ label, cwd?,
   branch?, repo? }>` with **no `summary` field** — so even though the relay
   now sends per-session `summary` on the wire (Phase 1 backend fix, `9ff06bf`),
   `renderPeerLine`/`renderGroupedPeers` cannot type-safely read
   `peer.sessions[i].summary` until `PeerSummary`'s session element type in
   `outbound.ts` is extended too. This is an additional real edit needed
   beyond what the plan's step 4 described (which only names `tools.ts`).
9. Read the rubric's R4 invariant (`docs/plans/2026-09-17-relay-followups.rubric.md`
   line ~24-27): the renderer change must ONLY add indented per-session lines
   when a handle has **>1** session; the existing single-session
   `renderPeerLine` output string must stay byte-identical (existing tests may
   assert equality on it).
10. Looked for the campaign-contract shape to reuse
    (`docs/projects/2026-09-16-relay-groups/campaign-p1/campaign.json` +
    `.seal.json`, sealed with `mission_mode: off` via
    `node scripts/implementation-campaign-check.js seal`) — read the JSON
    shape but the `brief.md` read for that example was the call that tripped
    the 40-call cap (denied before output returned). **No campaign contract
    or seal file was created for the Phase 1 renderer work; `engine
    implement-review` was never invoked this session** — so there is no
    "refusal" to record yet; it simply was not attempted before the cap.

## NOT done — everything else in foreman #1's original list, still open

Unchanged from foreman #1's handoff except item 2 (now done, see above):

1. **Full verify** (`pnpm -r test:ci`, `pnpm -r typecheck` or relay's own
   `typecheck`, `scripts/verify-groups.sh`) — still NOT run against the two
   new commits.
2. ~~Commit the implementation~~ — DONE this session (`9ff06bf`), as two
   commits per the split above.
3. **Phase 1's `tools.ts` renderer** — NOT started (no red test written yet).
   Next foreman should:
   - First extend `packages/peer-agent/src/outbound.ts` `PeerSummary.sessions[]`
     element type to include `summary?: string` (or non-optional `string` if
     the relay always sends it now — check `packages/relay/src/routes/peers.ts`
     response shape against the fixed `registry.ts` before deciding optionality).
   - Then write the red test (peer-agent test dir — find the existing
     `tools.test.ts` or equivalent) asserting: (a) a >1-session handle's
     grouped/strict text output gets one indented line per session with that
     session's own summary, (b) a single-session handle's `renderPeerLine`
     output is BYTE-IDENTICAL to today's (rubric R4).
   - Try the sealed `/l5` campaign rail ONCE per common.md (codex gpt-5.5
     high override via `REVIEW_LOOP_CONFIG_OVERRIDE`, `AUTOPILOT_LEVEL=l5`,
     `AUTOPILOT_SESSION_MODE_DIR` mask, inside a `systemd-run --user` unit) —
     genuinely not attempted yet, not refused. If it refuses or the budget
     doesn't cover watching it to completion, self-implement red-first and
     record the reason (budget vs. refusal — be honest about which).
   - `bin/fleet` (dotfiles repo) stays a ledger note only, per plan step 5 —
     do not edit it.
4. **Terminal full-diff review** by `scripts/dispatch-review.sh --runner
   codex --model gpt-5.6-sol --effort high` against `develop..tip` — NOT run.
5. **Merge `feat/relay-followups` `--no-ff` into `develop`, push. Delete the
   feature branch on origin afterward.** NOT done — branch is still local-only
   relative to develop (never pushed this session either).
6. **BACKLOG.md edits** (hangar-bridge `docs/BACKLOG.md`) — NOT done:
   - Flip "presence heartbeats must not enter the durable message buffer" →
     Done (evidence: plan § Item 2, code-read only, no campaign).
   - Flip "ephemeral messages have no working reply path" → Done (evidence:
     plan § Item 4, stale row — fix shipped in an earlier line).
   - Flip "`@team` fanout skips the sending handle" → Done **once merged**
     (evidence: `9ff06bf` + `fanout.test.ts`).
   - Add F-P3-1 as Done **once merged** (not a BACKLOG row originally — came
     from the fleet-comms cockpit handoff; note the closure per
     `hangar-bridge-followups.md`'s framing).
   - One-paragraph decision note (not code) for "sibling processing rights
     unassigned" + the two replay-butler rows — reasoning already written in
     plan § Item 5; copy it in.
7. **hangar's own `docs/BACKLOG.md`** — check whether it mirrors any of these
   rows before touching it (operator note: cookys edits hangar's BACKLOG,
   foreman edits hangar-bridge's). Not checked this session.
8. **Ledger** under `docs/projects/2026-09-17-relay-followups/ledger/` — not
   created. Needs: gen-1 plan-review JSON (copy from
   `/tmp/claude-1000/-home-cookys-projects-hangar/194c026e-dd23-4721-a1d0-9fc7334e3b4d/scratchpad/relay-followups/plan-review-gen1.log`
   **before session scratchpad GC** — still not durable anywhere as of this
   handoff), the existing-test-rewrite justification (already in the
   `6ff760b` commit message), the Phase-1/Phase-2 self-implement rationale
   (this was foreman #1's decision, budget-driven not refusal-driven — now
   recorded twice, here and in foreman #1's handoff), sol's verdict once run,
   and this session's campaign-attempt outcome once item 3 above is resolved.
   **Ledger lands on develop AFTER the merge commit.**

## Facts for the report the next foreman/depth-0 should give the operator

- Tip SHA on `feat/relay-followups` right now: `9ff06bf` (still off develop
  `565cb42`; no merge, no push, this branch has never been pushed to origin).
- Commits added this session: `49573e5` (docs, plan correction + rubric),
  `9ff06bf` (the Phase-1 + Phase-2 relay implementation, split cleanly from
  the docs commit after a caught staging mistake — no bad state was ever
  pushed).
- Verify: still only foreman #1's targeted vitest (`fanout.test.ts` +
  `registry.test.ts`, 41/41) — full suite/typecheck/verify-groups.sh **still
  NOT run** by anyone in this line yet. This is the single most important
  next step; do it before anything else.
- New finding this session: `packages/peer-agent/src/outbound.ts`
  `PeerSummary.sessions[]` element type has no `summary` field — the Phase 1
  `tools.ts` renderer step cannot be implemented without extending that type
  first. Not previously called out in the plan.
- Sealed `/l5` campaign rail: NOT attempted (session capped before reaching
  it) — no refusal to report, just not yet tried.
- Terminal sol review: NOT run.
- BACKLOG edits: NOT done.
- Merge/push: NOT done.
