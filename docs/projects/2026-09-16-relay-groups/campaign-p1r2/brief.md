Task: relay groups — P1 REPAIR round 2 (bounded). Base = `feat/relay-groups-p1r` head 4000f76 (P1 + repair 1 +
a depth-0 revert of your `checkAudience` change: replies keep the instance-grant semantics; the harness now polls
before replying). Reviewer codex gpt-5.6-sol (cross-family) on the full P1 diff accepted three findings. Fix ONLY
these. `packages/relay/tests/adversarial/groups.test.ts` is depth-0 owned — DO NOT EDIT. Done = `scripts/verify-groups.sh`
exits 0. Plan: docs/plans/2026-09-16-relay-groups.md §2.1.2, §2.1.3, §2.5-3, §2.5-6.

## R1 — route lookups scoped in SQL, not JS (plan §2.5-3; timing/existence equality §2.5-6)
`routes/grants.ts` and `routes/replies.ts` (`resolveParentRoute` / `getRoute` / `getLiveRoute` /
`getRouteByCorrelation` callers) currently fetch the route by msg_id globally, then test membership /
`since_msg_id` in JS — a cross-group id runs extra queries and code compared with a nonexistent id. Add scoped
store methods (e.g. `getRouteScoped(msg_id, scope: ReaderScope)`, same for live/correlation) whose SQL ANDs
`readerScope(memberships, 'group_id', 'msg_id')` into the WHERE, and use them in strict mode so an inaccessible
and a nonexistent id follow the identical path (one query, same branch, same body). Legacy mode keeps the
unscoped methods. Keep the P0 grep guard green (no `.filter(` in store fetch bodies).

## R2 — `in_reply_to` parent check before addressRules / subject ACL (plan §2.1.2 insertion order)
The group-scoped parent lookup only happens inside `store.buildEnvelope`, which runs AFTER the addressRules block
and subject ACL, so an inaccessible parent can surface an earlier refusal (`use_reply_verb`, `forbidden_subject`…)
instead of the parent result. In `routes/messages.ts` strict branch, right after the recipient-membership check
(and before `thread_root` continuation / addressRules / subject ACL), perform the same group-scoped parent
existence check (`SELECT 1 FROM message WHERE id=? AND team_id=? AND group_id=?`) and return the existing
`unknown in_reply_to` 400 body when it misses. `buildEnvelope` keeps its check (defence in depth).

## R3 — every strict-mode refusal audited with `group_id` (plan §2.5-6)
Add `auditEvent(deps, peer.id, '<event>', { group_id, handle, … })` for `idempotency_mismatch` (event
`group.idempotency_mismatch`), the cross-group `not_in_thread` (event `group.not_in_thread`), and the strict-mode
`unknown in_reply_to` from R2 (event `group.unknown_parent`). Existing subject-ACL audit calls in the strict
branch must include `group_id` in their detail. Add one integration assertion per new event (a new test file
under `packages/relay/tests/integration/`, do not edit existing tests).

## Refuted (do not touch)
oracle-modified — the harness and `fanout.test.ts` edits in the diff are depth-0's own (three harness corrections
and the R3 fanout unit test requested in repair round 1); the frozen boundary is against the implementer, not depth-0.
