Task: relay groups — P1 REPAIR round 4 (bounded, final). Base = `feat/relay-groups-p1r3` head 5beb65b (P1 + 3 repairs
+ depth-0 harness corrections: dispatches now carry `to_filter.instance`, broadcast echo expectations fixed).
Reviewer codex gpt-5.6-sol accepted two findings — both are places where the implementation bent EXISTING legacy
behaviour to satisfy an (at the time wrong) harness expectation. Restore the original behaviour; the corrected
harness no longer needs the bends. `packages/relay/tests/adversarial/groups.test.ts` is depth-0 owned — DO NOT EDIT.
Done = `scripts/verify-groups.sh` exits 0.

## R1 — `dispatch_needs_instance` applies in BOTH modes (routes/messages.ts ~:393)
Remove the `!strictGroups &&` guard: a `task_dispatch` without `to_filter` under addressRules=on is refused in strict
mode too (route it through the strict `refuse` helper so it is audited with `group_id`).

## R2 — legacy byte-identity regressions (plan §2.5-4)
1. `routes/stream.ts` backlog-drain self-exclusion: remove the added `&& !isBroadcastHandle(e.to)` — the sender's own
   instance never gets its own queued message back, broadcast or not, exactly as before.
2. `routes/presence.ts`: restore `summary: z.string().max(200)` (no `.default('')`); a missing summary is the prior
   validation error in every mode.
3. `routes/inbox.ts` (and any other legacy-mode JSON path: poll, stream `data:` frames, replies): in legacy mode the
   envelope on the wire must not carry `group`. Apply the same strip used by /v1/messages (one helper, e.g.
   `envelopeForWire(e, strictGroups)`), and make sure `fetchMailboxSince` / poll / SSE serialisation all use it.
Add a small legacy-mode integration test file asserting: inbox and poll envelopes have no `group` key; presence
without summary → 400; a legacy `@team` broadcast queued while its sender was offline is not replayed to the
sender's instance on cold start.

## Refuted (do not touch)
acceptance-oracle-modified — depth-0's own edits to the harness and the requested fanout unit test.
