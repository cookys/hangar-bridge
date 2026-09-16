Task: relay groups — Phase P1: relay-side enforcement across every route, in this repository
(hangar-bridge, pnpm, TypeScript, vitest). Plan: `docs/plans/2026-09-16-relay-groups.md` (REVIEWED r4) —
read §2.1.2–§2.1.9 and §4 P1 FIRST. P0 is merged: `packages/shared` constants/envelope (`@group`,
`group`, `isBroadcastHandle`), schema v10, `peers-file.ts` v2/strict + `SeedDiff`, `packages/relay/src/groups.ts`
(`loadMemberships / members / sharedAudience / requireCap / readerScope`) all exist — use them, do not reinvent.

**The acceptance oracle is `packages/relay/tests/adversarial/groups.test.ts` (depth-0 owned; DO NOT EDIT).**
It is red now (17/19). P1 is done when `scripts/verify-groups.sh` exits 0: that file green, every
pre-existing test green **unchanged** except the ones listed in §"Allowed test edits", both typechecks clean.
Read the harness first: it fixes the exact interfaces (`new Fanout({ sharedAudience })`, `Deps.metricsToken`,
`Deps.groupsMode`, `reloadRoster(deps, path)`, `GET /v1/whoami`, response shapes, error codes, audit event names).

Write ONLY under these paths (contract `allowed_path_prefixes`): `packages/relay/src/` (P0 files `db/*`,
`auth/peers-file.ts`, `groups.ts` only for the specific edits this brief names — the index drop, the
`default_group` persistence, new exports on `groups.ts`),
`packages/relay/tests/integration/` (existing tests only where §"Allowed test edits" says), `packages/shared/src/`
(only if a constant is missing). Never touch `packages/relay/tests/adversarial/`, `packages/peer-agent/`, docs.
Do not commit (the harness commits). Tests first for anything the adversarial file does not already cover.

## Global constraints (plan §2.5, verbatim; every one applies)
1. `from` 與 `group_id` 都是 relay 蓋章;任何 client 供應的同名欄位一律忽略或剝除,不得成為路由依據。
2. 非成員對一個 group 的任何存在性探測,回應必須與「該物件不存在」無法區分(404 同碼同 body、列表不出現、計數不含)。
3. 讀取側過濾以「讀者當下的 membership + since_msg_id」為準,寫在 SQL WHERE,不在 JS 事後 filter。
4. legacy 模式(`Deps.groupsMode==='legacy'`,即 peers.json 無 `peers` 鍵)下既有 `/v1/*` 端點行為與回應逐位元相同;`/metrics` 閘與 `/v1/whoami` 例外。
5. membership 縮小必須在 SIGHUP 後立即反映到所有 live stream(主動 drop)。
6. 每個拒絕都進 `audit_log` 且 `detail_json` 含 `group_id`;拒絕路徑先查 membership 再查存在性(兩者皆 indexed)。
7. 不引入任何新的 trust 機制。
8. 先紅後綠。

## 1. Deps + app wiring
- `deps.ts`: add `metricsToken?: string`, `groupsMode: 'legacy' | 'strict'` (default `'legacy'` when absent so every
  existing test that builds Deps without it keeps legacy behaviour).
- `cli/serve.ts`: `startServer` passes `groupsMode` from `initRelayFromPeersFile(...).mode` (P0 returns it) and
  `metricsToken: process.env.HANGAR_METRICS_TOKEN`. **`reloadRoster(deps: Deps, peersFile: string): boolean`** (new
  signature; update the SIGHUP handler and `serve.reload.test.ts`): calls `initRelayFromPeersFile(deps.db, …)`;
  on success sets `deps.groupsMode = r.mode`, clears the membership memo (§3), and for every entry of
  `r.diff.shrunk` + `r.diff.removed_handles` calls `deps.fanout.dropHandle(HANGAR_TEAM_ID, handle, reason)`
  (`'membership_changed'` / `'removed'`); returns true. On throw (incl. `groups_section_removed`) logs
  `relay.roster.reload_failed` and returns false with NO side effects (roster and streams untouched).
- `index.ts` serve startup: if the initial load throws `groups_section_removed`, print a one-line reason and
  `process.exit(1)` (plan §2.1.10 H5).

## 2. Fanout (`fanout.ts`)
- `constructor(opts: { sharedAudience?: (team_id: string, handle: string) => Set<string> } = {})` — every existing
  `new Fanout()` keeps working.
- `dropHandle(team_id, handle, reason: 'membership_changed' | 'removed'): number` — for each subscriber of that
  handle call `sub.close?.(reason)` then unsubscribe; return the count. Extend `Subscriber.close` to
  `close?: (reason?: string) => void` (existing callers pass nothing).
- `deliverDetailed` for `kind === 'presence_update'`: audience = `sharedAudience(team, e.from)` ∩ subscribed
  handles (when `sharedAudience` is provided; without it, legacy `@team` fan-out as today). The subscriber
  `accept` gate must NOT re-check group for presence (§3).
- `@group` broadcast (`isBroadcastHandle(e.to)`): candidate handles = `members(db, e.group)`; the route passes
  the member set — add an optional `audience?: Set<string>` field on the envelope delivery call or a
  `deliverDetailed(e, { audience })` option, whichever keeps `fanout.test.ts` unchanged.
- `onlineHandlesIn(team_id, handles: Set<string>): string[]` helper for the `delivered_at` rule (§4.6).

## 3. Membership memo + `deliverable`
- `groups.ts`: add `class MembershipMemo { constructor(db); get(handle): Map<string, Membership>; clear(): void }`
  keyed by handle, filled lazily via `loadMemberships`; `reloadRoster` clears it. One instance lives on `Deps`
  as `memberships` (create it in `buildApp` if absent so tests need not pass it).
- `stream.ts` `deliverable(e)`: for every kind except `presence_update`, require
  `deps.memberships.get(handle).has(e.group)` AND `e.id > since_msg_id` of that membership. Presence skips it.
  Cold-start / resume drains (`fetchPendingSince` / `fetchSince`) receive `readerScope(memberships)`.
- On `close('membership_changed' | 'removed')` the stream writes `event: reauth\ndata: {"reason": "<reason>"}\n\n`
  then ends the response.

## 4. `POST /v1/messages` (`routes/messages.ts`) — order is the security property
Insert immediately after the B1 meta-strip and the `x-hangar-instance` parse, BEFORE `thread_root` continuation,
BEFORE the addressRules block, BEFORE subject ACL:
1. strip `meta.group` (add to the reserved-meta list).
2. `group = body.group ?? defaultGroup(db, handle)`. P0 validated `default_group` but did not persist it (no
   `human` column; no schema change wanted). **Decision:** `seedPeers` (allowed edit, this one behaviour) writes it into the
   existing `human.subjects` JSON as `default_group` (`{owned, interest, default_group}`; legacy ⇒ `'cookys'`);
   `groups.ts` gains `loadDefaultGroup(db, handle): string` (falls back to `DEFAULT_GROUP_ID` when the key is absent).
   `loadOwnedSet` must keep ignoring the extra key. Add a P0-style unit test for both.
3. `requireCap(memberships, group, cap)` where cap = `chat` for chat to a handle, `broadcast` for `@group`/`@team`,
   `dispatch` for task_dispatch/task_result, `permission` for permission_request/permission_verdict,
   `presence_update` needs none. `unknown_group` → **404 `{error:'unknown_group'}`**, audit `group.unknown_group`;
   `cap_denied` → **403 `{error:'cap_denied'}`**, audit `group.cap_denied {group_id, handle, cap}`.
4. direct `to`: strict mode → `members(db, group).has(to)` else **404 `{error:'unknown_recipient'}`** with a body
   byte-identical to the nonexistent-handle case (make the nonexistent case go through the SAME code path:
   compute membership first, existence never separately reported), audit `group.unknown_recipient`.
   Legacy mode → keep today's 400 `invalid_message` "unknown recipient" path untouched.
5. `@team` → rewrite `to` to `@group` (normalise before build/persist), audit `deprecated_team_alias` once per send.
6. `in_reply_to`: `store.buildEnvelope(team, from, msg, group)` — parent lookup gains `AND group_id=?`; not
   found → the existing `unknown in_reply_to` 400 path (same body as nonexistent).
7. `thread_root` continuation: after `resolveThreadContinuation`, require `route.group_id === group` else the
   existing 403 `not_in_thread` body.
8. addressRules refusals run only after 3–4 passed; `live_instances` only lists instances of the recipient
   (already a member by then).
9. `delivered_at`: `@group` → `fanout.onlineHandlesIn(team, members(group)).some(h => h !== from)`; direct →
   `isOnline(to)` as today.
10. persist with `group_id`; `reply_route.group_id = group`; response envelope carries `group`.
11. `idempotency-key` hit (strict only): parse body, resolve `group`, compare with cached `group` (absent ⇒
    `'cookys'`): differ → **422 `{error:'idempotency_mismatch'}`**; equal but no longer a member → 404
    `unknown_group`; else replay 201. Legacy: unchanged early return.
`GET /v1/messages` (poll) and replay-butler counts: `fetchInboxSince` / `fetchInboxIdsAfter` take `readerScope`.

## 5. Other routes
- `GET /v1/whoami` (new `routes/whoami.ts`, bearer): `{handle, default_group, groups:[{id, caps, history}]}`
  (history from `peer_group`).
- `GET /v1/peers`: keep the ARRAY shape; filter humans to `sharedAudience(reader) ∪ {reader}`; each entry gains
  `groups: [{id, caps}]` = groups shared with the reader (reader's own entry: all its groups); cache key =
  sorted group ids of the reader (`Map<string, {at, body}>`), TTL unchanged.
- `POST /v1/presence`: unchanged body; fan-out goes through `deliverDetailed` with the presence audience (§2).
- `routes/inbox.ts` (`fetchMailboxSince`), `routes/replies.ts` (`resolveParentRoute` query gains
  `AND group_id IN readerScope` **before** `checkAudience`; miss → existing 404 `unknown_parent` body),
  `routes/grants.ts` (route lookup gains group scope; miss → same body as unknown msg),
  `routes/permission.ts` (the request SELECT gains group scope; miss → existing 404 `request_not_found`).
- `routes/claims.ts` + `claims/store.ts`: `AcquireBody`/`ReleaseBody` gain optional `group`; resolve
  `group ?? default_group`; `requireCap(…, 'claim')` (404 unknown_group / 403 cap_denied); store methods take
  `group_id`; `ON CONFLICT(team_id, group_id, claim_key)`; **drop `idx_claim_legacy_unique`** — the ONE permitted
  edit to `db/schema.sql` (remove the line) and `db/db.ts` (remove it from `migrateV9ToV10`, add
  `DROP INDEX IF EXISTS idx_claim_legacy_unique` guarded like the other steps, update `db.test.ts` expectation if any);
  `GET /v1/claims` returns the reader's groups' union, each row with `group_id`; `release` returns
  `{released:false}` when the key is absent in that group.
- `routes/metrics.ts`: `deps.metricsToken` absent → route returns 404 for everything; present → require
  `authorization: Bearer <token>` (timing-safe compare) else 401; peer bearers are 401.
- `messages/store.ts`: `fetchSince / fetchPendingSince / fetchInboxSince / fetchInboxIdsAfter / fetchMailboxSince`
  gain a `scope: ReaderScope` parameter ANDed into the WHERE; keep the P0 grep guard green (no `.filter(` in those
  bodies); `insertRoute` writes `group_id`; `getRoute*` return `group_id`.

## 6. Audit
Every refusal above: `auditEvent(deps, peer.id, '<event>', { group_id, handle, ...})`. Events: `group.unknown_group`,
`group.unknown_recipient`, `group.cap_denied`, `deprecated_team_alias`, `peer.removed` (P0 writes it).

## Allowed test edits (pre-existing files; list any other change in your final note with a reason)
- `serve.reload.test.ts`: new `reloadRoster(deps, path)` signature.
- `fanout.test.ts`: only if the constructor default changed a type (it should not).
- `tests/integration/claims.test.ts`: response rows gain `group_id`; nothing else.
No other pre-existing test may change; if one fails, your implementation broke legacy byte-identity — fix the code.

## Acceptance (harness-checked)
- `scripts/verify-groups.sh` → 0 (adversarial 19/19, shared 157, relay ≥ 429 + new).
- `git diff --stat` only inside `packages/relay/src/`, `packages/relay/src/auth/peers-file.ts` (default_group field),
  `packages/relay/tests/integration/{claims,…}.test.ts`, `packages/relay/src/cli/serve.reload.test.ts`, and the two
  db files for the index drop only.
