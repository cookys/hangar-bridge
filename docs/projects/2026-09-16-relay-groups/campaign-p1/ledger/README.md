# P1 campaign ledger

Base `1c18e65` (P0 merged + depth-0 adversarial harness, 17/19 red). Implementer codex gpt-5.5 high; in-loop
reviewer MiniMax-M3 xhigh; full-diff terminal reviewer codex gpt-5.6-sol high (switched after MiniMax's full-diff
runs produced 8–13 MUST-FIX per pass with half self-retracted).

| round | branch / commit | what | verify (fresh worktree) | review |
|---|---|---|---|---|
| P1 | `feat/relay-groups-p1` `2d66a83` | 22 files, +584/−222 | PASS (157 + 448, harness 19/19) | MiniMax transport rc=1 → rerun: FTS 13 (4 accepted, 9 refuted) |
| repair 1 | `feat/relay-groups-p1r` `70c03f6` + depth-0 `da5923c`/`4000f76` | replies no mode fork; ClaimStore explicit signature; fanout keeps accept; reloadRoster single signature; **depth-0 reverted a `checkAudience` loosening** the implementer had added to satisfy a wrong harness expectation | PASS | sol: FTS 4 (3 accepted) |
| repair 2 | `feat/relay-groups-p1r2` `db3dd37` | SQL-scoped route lookups (grants/replies); in_reply_to parent check before addressRules; audits for idempotency_mismatch / not_in_thread / unknown_parent | PASS (453) | sol: FTS 5 (4 accepted) |
| repair 3 | `feat/relay-groups-p1r3` `abede81` + depth-0 harness fix `5beb65b` | legacy wire byte-identical (no group/groups/group_id fields); /v1/peers in SQL; @team rewrite after cap/recipient; addressRules refusals audited | PASS | sol: FTS 3 (2 accepted) |
| repair 4 | `feat/relay-groups-p1r4` `0193c24` + depth-0 `…` | dispatch_needs_instance in both modes; legacy self-exclusion / presence summary / inbox group restored; legacy-mode test | PASS (458) | sol: FTS 3 (2 accepted) → depth-0 fixed: thread_root scoped lookup, dispatch rule back before subject ACL |
| final | depth-0 on p1r4 | strict reply refusals audited with route.group_id | PASS (459) | sol: FTS 2 — `strict-refusal-audit-gaps` fixed here; `acceptance-oracle-mutated` refuted (see below) |

**Standing refutation — "acceptance oracle modified"**: every edit to `tests/adversarial/groups.test.ts` was made by
depth-0 (owner) to correct the harness's own wrong expectations (replies need Idempotency-Key + return 200; a replier
must have received the parent; dispatches under addressRules need `to_filter.instance`; broadcasts are not echoed
to the sender). `fanout.test.ts` gained the unit test repair-1 asked for. The boundary binds the implementer, which
never touched either file (verified per round with `git diff --stat`).

**Pattern worth remembering**: when the oracle was wrong, the implementer bent existing behaviour (checkAudience,
dispatch_needs_instance, backlog self-exclusion, presence summary) rather than flag the conflict. Four of the six
real defects across the rounds came from that. For P2/P3: run the harness against the existing suite's
assumptions before dispatch.

Merge decision: depth-0, on verify (fresh worktree, 157 + 459) + sol's last two passes converging to one
refuted finding.
