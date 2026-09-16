Task: relay groups — P1 REPAIR round (bounded). Base is `feat/relay-groups-p1` head (commit da5923c: your P1
implementation 2d66a83 + a depth-0 fix to the adversarial harness). Plan: docs/plans/2026-09-16-relay-groups.md;
your original brief: docs/projects/2026-09-16-relay-groups/campaign-p1/brief.md. Reviewer (MiniMax-M3 r2) findings
were dispositioned by depth-0; fix ONLY the four accepted items below. Everything else stays as is.
`packages/relay/tests/adversarial/groups.test.ts` is depth-0 owned — DO NOT EDIT. Done = `scripts/verify-groups.sh`
exits 0 and no pre-existing test changed beyond serve.reload.test.ts / claims.test.ts / claims store tests.

## R1 — `/v1/replies`: no behaviour fork by mode (accepted: replies-strict-201-status, replies-synthesized-idem-key)
The harness bug is fixed (it now sends `Idempotency-Key` and expects 200). Remove BOTH hacks in `routes/replies.ts`:
the `?? newMessageId()` synthesized key in strict mode (a missing key must return the existing 400
`idempotency_key_required` in every mode) and the `strict ? 201 : 200` status forks (always 200). The group
scoping of `resolveParentRoute` (404 `unknown_parent`) stays.

## R2 — `ClaimStore`: one explicit signature, no duck-typed overloads (accepted: claim-acquire-shape, claim-release-shape)
`acquire(team_id, group_id, claim_key, owner_handle, owner_label, ttl_seconds, note)` and
`release(team_id, group_id, claim_key, owner_handle)` — positional, typed, no `oldShape` / `ownerMaybe` detection.
Update every caller (`routes/claims.ts`, legacy path passes `DEFAULT_GROUP_ID`) and the store/integration tests.
`list(team_id, group_ids: string[])` if not already explicit.

## R3 — Fanout: presence keeps the subscriber `accept` gate; only the GROUP check is skipped (accepted: fanout-presence-update-bypass-accept)
`fanout.ts:194` currently skips `sub.accept` entirely for `presence_update`. Restore `sub.accept(e)` for every kind;
instead make the stream route's `deliverable` skip the *membership* check when `e.kind === 'presence_update'`
(plan §2.1.3 / brief §3) so to_filter and subject gates still apply. Audience narrowing to `sharedAudience` stays in
Fanout. Add one fanout unit test: a presence_update whose subscriber `accept` returns false is not delivered.

## R4 — `reloadRoster(deps, path)` single signature (accepted: cleanup of the dual `depsOrDb` shim)
Drop the `Db` overload that builds a throwaway Deps (it silently runs a reload against a Fanout nobody subscribes to,
so `dropHandle` is a no-op). Update `serve.reload.test.ts` to build a minimal Deps (`buildApp`-style) and pass it.

## Refuted (do not touch; recorded in the ledger)
messages-strict-idempotency-default-key (key is optional on /v1/messages in both modes — same as before);
messages-thread-continuation-group-check (reviewer concluded the order is correct); metrics 401-vs-404 (operator-only
endpoint; plan §2.1.8 chose 404-when-unconfigured / 401-otherwise); reload-roster-mode-flip (legacy→strict is allowed by
plan §2.1.10 G2 and applies the full strict diff; strict→legacy is refused by seedPeers); claims idempotency (never
existed, out of scope); replies idem replay vs group (plan G9: reply_idem replay does not re-verify group);
presence-broadcast-audience (verified: `sharedAudience` SQL returns only co-members, empty set with no memberships);
index.ts exit-1 (reviewer: no fix needed).
