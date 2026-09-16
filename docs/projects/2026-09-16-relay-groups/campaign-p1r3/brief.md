Task: relay groups — P1 REPAIR round 3 (bounded, final). Base = `feat/relay-groups-p1r2` head db3dd37. Reviewer
codex gpt-5.6-sol (full P1 diff) — four accepted findings below; fix ONLY these. Plan: docs/plans/2026-09-16-relay-groups.md.
`packages/relay/tests/adversarial/groups.test.ts` is depth-0 owned — DO NOT EDIT. Done = `scripts/verify-groups.sh` exits 0.

## R1 — legacy mode is byte-identical on the wire (plan §2.5-4 wins over the "additive" wording in §2.6)
In `groupsMode === 'legacy'`: `/v1/peers` entries must NOT carry `groups`; `/v1/claim` (acquire) and `/v1/claims`
rows must NOT carry `group_id`; `/v1/messages` / `/v1/replies` envelopes must NOT carry `group` (strip it from the
JSON the route returns; the DB row keeps `group_id='cookys'`). Strict mode keeps all of them. Every pre-existing
integration test must pass unchanged — if you had modified `tests/integration/claims.test.ts` earlier, restore it to
the base version and keep the group_id assertions strict-mode-only in a new test file.

## R2 — `/v1/peers` visibility in SQL (plan §2.5-3)
Replace the "select every enabled human + every membership, then filter in JS" shape with SQL restricted by the
reader's memberships: e.g. `SELECT h.id, h.handle, h.display_name FROM human h WHERE h.team_id=? AND h.disabled_at IS NULL
AND (h.handle=? OR h.handle IN (SELECT gm2.handle FROM group_member gm JOIN group_member gm2 ON gm2.group_id=gm.group_id
WHERE gm.handle=?))`, and `groups[]` per entry via a query bounded to groups the reader shares with that handle. Legacy
mode keeps today's single query. Cache key unchanged (sorted reader group ids).

## R3 — `@team` alias normalisation AFTER cap + recipient enforcement (plan §2.1.2 order)
In the strict branch of `POST /v1/messages`, the `@team` → `@group` rewrite and its `deprecated_team_alias` audit
currently run before `requireCap` / recipient-membership; a request that is then refused (`unknown_group`,
`cap_denied`) has already written the alias audit. Treat `@team` as broadcast for the cap decision (`broadcast` cap)
without mutating `data.to`; perform the rewrite + audit only after cap and recipient checks pass. `isBroadcastHandle`
already covers both spellings for the cap decision.

## R4 — every post-group-resolution refusal is audited with `group_id` (plan §2.5-6)
The addressRules refusals (`use_reply_verb`, `sender_instance_required`, `handle_needs_all_sessions`,
`dispatch_needs_instance`, `direct_needs_instance` and any sibling) and any other refusal emitted after `group` is
resolved in the strict branch must go through one helper, e.g. `refuse(c, status, body, event)` that calls
`auditEvent(deps, peer.id, event, { group_id: group, handle, error: body.error })` then returns `c.json(body, status)`.
Legacy mode unchanged (no new audit rows). Add assertions for two of them to `tests/integration/group-audit.test.ts`.

## Refuted (do not touch)
test-oracle-integrity — `groups.test.ts` and `fanout.test.ts` changes are depth-0's own (harness corrections + the
fanout unit test requested in repair 1); the frozen boundary binds the implementer, not depth-0.
