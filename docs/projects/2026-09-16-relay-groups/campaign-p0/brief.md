Task: relay groups — Phase P0 (types, schema v10, peers.json v2, membership helpers) in this repository
(hangar-bridge, pnpm workspace, TypeScript, vitest). The plan is `docs/plans/2026-09-16-relay-groups.md`
(status REVIEWED r4) — read §2.1.1, §2.1.5, §2.1.6, §2.1.7, §2.1.10, §2.1.11, §2.5, §3 and §4 P0 FIRST.
Everything below restates P0 precisely; where this brief and the plan disagree, the plan wins.

P0 adds data structures and helpers ONLY. **No route behaviour changes in P0.** Every existing test must
stay green unchanged (the plan's KR2: legacy peers.json ⇒ byte-identical behaviour). Write ONLY these files:

- `packages/shared/src/constants.ts` (append constants), `packages/shared/src/constants.test.ts` (new or append)
- `packages/shared/src/envelope.ts` (add `isBroadcastHandle`, accept `@group`), `packages/shared/src/envelope.test.ts` (append)
- `packages/relay/src/db/schema.sql`, `packages/relay/src/db/db.ts`, `packages/relay/src/db/db.test.ts`
- `packages/relay/src/auth/peers-file.ts`, `packages/relay/src/auth/peers-file.test.ts`
- `packages/relay/src/groups.ts` (new), `packages/relay/src/groups.test.ts` (new)
- `packages/relay/src/cli/init.ts` (return `{seeded, mode}`), `packages/relay/src/cli/init.test.ts`

Do not edit any other file. Do not touch routes, fanout, store, stream, peer-agent. Do not commit
(the harness commits). Tests first: write each test file, run `scripts/verify-groups.sh` and observe
the new tests FAIL, then implement until it exits 0. Keep the test count of pre-existing tests unchanged.

## Global constraints (verbatim from plan §2.5 — every one applies)

1. `from` 與 `group_id` 都是 relay 蓋章;任何 client 供應的同名欄位一律忽略或剝除,不得成為路由依據。
2. 非成員對一個 group 的任何存在性探測,回應必須與「該物件不存在」無法區分。
3. 讀取側過濾以「讀者當下的 membership + since_msg_id」為準,寫在 SQL WHERE,不在 JS 事後 filter。
4. 頂層無 `peers` 鍵(legacy)的 peers.json 下,既有 peer-facing `/v1/*` 端點行為與回應必須與 v9 逐位元相同;有 `peers` 鍵(v2)則 fail-closed。
5. membership 縮小必須在 SIGHUP 後 ≤ 1 個 heartbeat 內反映到所有 live stream(主動 drop)。(P1 wires this; P0 only exposes the diff.)
6. 每個拒絕都進 `audit_log` 且含 `group_id`。
7. 不引入任何新的 trust 機制;group 只是 relay 內的 authorization 資料。
8. 每個 phase 先紅後綠。

## 1. shared constants + envelope

`packages/shared/src/constants.ts` — append:
```ts
export const GROUP_BROADCAST_HANDLE = '@group' as const
export const GROUP_ID_REGEX = /^[a-z][a-z0-9._-]{0,63}$/      // domains allowed as group ids
export const DEFAULT_GROUP_ID = 'cookys' as const              // the migrated single group
export const MEMBER_CAPS = ['chat', 'broadcast', 'dispatch', 'permission', 'claim'] as const
export type MemberCap = typeof MEMBER_CAPS[number]
export const ALL_MEMBER_CAPS: readonly MemberCap[] = MEMBER_CAPS
export const GROUP_HISTORY = ['since_join', 'all'] as const
export type GroupHistory = typeof GROUP_HISTORY[number]
export const SINCE_ALL = '0' as const                          // since_msg_id for history:all (sorts below any msg_ id)
export function isBroadcastHandle(to: string): boolean         // '@team' (legacy alias) or '@group'
```
`packages/shared/src/envelope.ts`: wherever `to` is compared literally to `TEAM_BROADCAST_HANDLE`
(the `AddressSchema` literal union, `refineToFilter`, the "subjected @team of non-chat kind" refinement,
`classifyLegacyWidth` / `durableReport` if they compare literally), route through `isBroadcastHandle(to)`
and let the schema accept `'@group'` as well as `'@team'`. Add an OPTIONAL `group?: string` (regex
`GROUP_ID_REGEX`) to the outbound message schema and a REQUIRED `group: string` to the stored/inbound
`Envelope` type **with a default of `DEFAULT_GROUP_ID` when parsing rows that lack it**, so every
existing fixture and test still parses. Do not change any existing refinement message text.

Tests (`envelope.test.ts`, `constants.test.ts`): `isBroadcastHandle('@team')===true`, `'@group'===true`,
`'openclaw'===false`, `'@mailbox:x'===false`; outbound `to:'@group'` parses; outbound `group:'sikax.io'`
parses, `group:'Bad Group'` fails; an envelope row without `group` parses with `group==='cookys'`;
`GROUP_ID_REGEX` accepts `cookys`, `guest-lab`, `nikki.cookys.org`, rejects `@x`, `-x`, 65 chars.

## 2. schema v10 + migration

`schema.sql` becomes the v10 shape (canonical for a FRESH db; it runs before migrations, `db.ts:15-16`):
```sql
CREATE TABLE IF NOT EXISTS peer_group (           -- NOT "group": SQLite reserved word
  id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES team(id),
  description TEXT NOT NULL DEFAULT '', history TEXT NOT NULL CHECK(history IN ('since_join','all')),
  created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS group_member (
  group_id TEXT NOT NULL REFERENCES peer_group(id) ON DELETE CASCADE, handle TEXT NOT NULL,
  caps_json TEXT NOT NULL, member_since TEXT NOT NULL, since_msg_id TEXT NOT NULL,
  PRIMARY KEY (group_id, handle));
CREATE INDEX IF NOT EXISTS idx_group_member_handle ON group_member(handle);
```
`message` and `reply_route` gain `group_id TEXT NOT NULL DEFAULT 'cookys'` in their CREATE TABLE;
`claim` PRIMARY KEY becomes `(team_id, group_id, claim_key)` with `group_id TEXT NOT NULL DEFAULT 'cookys'`;
new indexes `idx_message_group_id(team_id, group_id, id)`, `idx_message_group_to(team_id, group_id, to_handle, id)`;
`INSERT OR IGNORE INTO schema_version VALUES (10)` is NOT added to schema.sql (the migration stamps it, like v7–v9).

`db.ts` — add `migrateV9ToV10(db)` after `migrateV8ToV9`, whole body inside one `db.transaction`,
guards per object (follow the `pragma table_info` idiom at `db.ts:163-166` and the
`sqlite_master.sql` idiom at `db.ts:272-278`):
1. `peer_group` / `group_member` / index: `CREATE … IF NOT EXISTS`.
2. **Data backfill runs once** — only when `SELECT 1 FROM schema_version WHERE version=10` is absent:
   `INSERT OR IGNORE INTO peer_group VALUES ('cookys','hangar','migrated single group','all',<now>)`;
   for each `human` row: `INSERT INTO group_member(...) SELECT 'cookys', handle, '<json of ALL_MEMBER_CAPS>', <now>, '0' FROM human WHERE NOT EXISTS (SELECT 1 FROM group_member gm WHERE gm.handle=human.handle)`.
   Rationale (plan §2.1.10 H1): serve opens the DB twice (`index.ts:39-43` then `serve.ts:61`); an
   unguarded backfill would re-admit a handle that strict seeding just removed from `cookys`.
3. `message.group_id`, `reply_route.group_id`: `ALTER TABLE … ADD COLUMN group_id TEXT NOT NULL DEFAULT 'cookys'` only if `pragma table_info` lacks it.
4. `claim` rebuild only if `sqlite_master.sql` for `claim` does not contain `group_id`: create `claim_v10`
   with the new PK, `INSERT INTO claim_v10 SELECT team_id,'cookys',claim_key,owner_handle,owner_label,note,created_at,expires_at FROM claim`,
   assert `COUNT(*)` equal before/after (throw on mismatch), `DROP TABLE claim`, `ALTER TABLE claim_v10 RENAME TO claim`,
   `CREATE INDEX IF NOT EXISTS idx_claim_expires ON claim(team_id, expires_at)`.
5. `CREATE INDEX IF NOT EXISTS` the two message indexes.
6. `INSERT OR IGNORE INTO schema_version(version) VALUES (10)`; `logJson('info','migrate.v9_to_v10',{...})` once.

Tests (`db.test.ts`, use `:memory:` or tmp files; build a v9 fixture by executing the v9 DDL inline in
the test — copy the pre-change `claim` CREATE TABLE and a minimal `message`/`reply_route`/`human` — then
call the exported `migrateV9ToV10`):
(a) v9 fixture with 2 humans, 3 messages, 1 claim, 1 reply_route → after migration: `peer_group` has `cookys`
history `all`; 2 `group_member` rows with caps == ALL_MEMBER_CAPS and since_msg_id `'0'`; every message and
reply_route `group_id='cookys'`; claim count 1 and `idx_claim_expires` exists (`sqlite_master`); schema_version contains 10.
(b) running `migrateV9ToV10` twice is a no-op (row counts identical, no throw).
(c) fresh `openDatabase(':memory:')` does not throw; schema_version contains 10; `pragma table_info(message)` has group_id;
`claim` PK is (team_id, group_id, claim_key) (inspect `pragma table_info` pk columns).
(d) `openDatabase` twice on the same tmp file is idempotent.
(e) fresh v10 db with human `guest` present ONLY in `group_member('guest-lab','guest',…)` and NOT in `cookys`;
run `openDatabase` (which runs the migration) again on it → `(cookys, guest)` still absent.

## 3. peers.json v2 + seedPeers

`peers-file.ts`:
- Keep the existing flat schema as **legacy**: detection = the top-level object has NO `peers` key.
  A flat file whose one handle happens to be named `groups` is still legacy (test i).
- v2 schema (`PeersFileV2Schema`):
  ```json
  { "peers":  { "<handle>": { "secret_sha256_hex": "…", "display_name"?: "…", "subjects"?: {…}, "default_group": "<gid>" } },
    "groups": { "<gid>": { "description"?: "…", "history"?: "since_join|all", "members": { "<handle>": { "caps"?: ["chat", …] } } } } }
  ```
  `history` defaults `since_join`; `caps` defaults ALL_MEMBER_CAPS; `default_group` required and must be
  one of the handle's memberships; every peer must be in ≥1 group; every member handle must exist in
  `peers`; gid matches `GROUP_ID_REGEX`; top-level keys other than `peers`/`groups` → throw; `peers` present
  but `groups` absent → throw (fail-closed). Use zod `.strict()`.
- `loadPeersFile(path)` returns `{ mode: 'legacy'|'strict', peers: PeerEntry[], groups: GroupEntry[] }`
  where `PeerEntry` gains `default_group: string` (legacy ⇒ `DEFAULT_GROUP_ID`) and
  `GroupEntry = { id, description, history, members: Array<{ handle, caps: MemberCap[] }> }`
  (legacy ⇒ exactly one group `cookys`, history `all`, every peer with ALL caps). Legacy load logs ONE
  `logJson('warn','peers.legacy_mode',…)`.
- `seedPeers(db, loaded, now)` — keep the existing human/token upsert byte-for-byte for the legacy path, then:
  * upsert `peer_group` rows (id, description, history) for every group;
  * for each (group, member): if the `group_member` row exists, UPDATE `caps_json` only (never touch
    `member_since`/`since_msg_id`); else INSERT with `member_since=now`, `since_msg_id` = `SINCE_ALL` when
    the group's history is `all`, else `newMessageId()` from `@hangar-bridge/shared` (plan §2.1.5).
  * DELETE `group_member` rows for (group, handle) pairs not in the file; DELETE `peer_group` rows not in the file
    (strict mode only; legacy mode never deletes).
  * **strict mode only**: for every `human` (team `hangar`, `disabled_at IS NULL`) whose handle is NOT in
    the file: `UPDATE human SET disabled_at=now`, `UPDATE token SET revoked_at=now WHERE human_id=? AND revoked_at IS NULL`,
    `DELETE FROM group_member WHERE handle=?`, and `INSERT INTO audit_log(team_id,at,actor_human_id,event,detail_json)`
    with event `peer.removed` and detail `{handle}`. Legacy mode: unchanged (no revocation) — matches today.
  * Return a `SeedDiff`: `{ mode, removed_handles: string[], shrunk: Array<{handle, group, reason:'removed'|'caps'|'group_deleted'}>, grown: Array<{handle, group}> }`
    computed by comparing membership + caps before and after within the same transaction. P1 will use
    `shrunk` to drop streams; P0 only returns it.
- **Mode flip guard (plan §2.1.10 / H5 / J1)**: before writing, if the loaded file is `legacy` and the DB
  looks strict — any of: `peer_group` has an id ≠ `cookys`; any `human` (enabled) not in `(cookys, handle)`;
  `cookys.history ≠ 'all'`; any `group_member` with caps ≠ ALL or `since_msg_id ≠ '0'` — throw
  `Error('groups_section_removed')`. Callers decide (init exits 1, reload keeps the old roster — P1).
- Export a pure `computeStrictSignals(db)` helper used by that guard so tests can hit it directly.

`cli/init.ts`: `initRelayFromPeersFile` returns `{ seeded, mode, diff }` (additive — existing callers
that read `.seeded` keep working). Do NOT change `index.ts` / `serve.ts` in P0.

Tests (`peers-file.test.ts` — extend, keep every existing case; `init.test.ts` — add one case):
(a) on an already-v10 db, load a legacy file containing one handle the db has never seen → all handles
(incl. the new one) in `cookys` with ALL caps, `since_msg_id='0'`, one `peers.legacy_mode` warn, mode `legacy`;
(b) v2 file whose peer lacks `default_group` → throw; (c) `default_group` not in memberships → throw;
(d1) re-seeding an existing member never changes `since_msg_id` or `member_since`; (d2) new member of a
`since_join` group gets `since_msg_id` matching `^msg_[0-9A-HJKMNP-TV-Z]{26}$`; (d3) new member of a
`history: all` group gets `'0'`; (e) removing a member from a group deletes only that `group_member` row;
(f) strict file missing a handle the db has → `human.disabled_at` and every token `revoked_at` set,
`audit_log` has `peer.removed`; the same on a legacy file → nothing disabled;
(g) legacy load then strict load on the same db → `group_member` equals the strict file exactly and (f) applied;
(h1) strict db (has `guest-lab`) then load a legacy file → throws `groups_section_removed`, db unchanged
(compare `group_member` rows before/after); (h3) strict db with only `cookys` but a member `caps:['chat']`
then legacy file → throws; (i) flat file with a handle literally named `groups` → mode `legacy`;
v2 file with an extra top-level key → throw; `peers` without `groups` → throw;
(j) `SeedDiff`: removing handle b from `lab` → `shrunk` contains `{b, lab, removed}`; reducing a's caps →
`{a, cookys, caps}`; adding c to `lab` → `grown` contains `{c, lab}`.

## 4. groups.ts

```ts
export type Membership = { group_id: string; caps: Set<MemberCap>; since_msg_id: string }
export function loadMemberships(db: Db, handle: string): Map<string, Membership>   // indexed lookup on group_member
export function members(db: Db, groupId: string): Set<string>
export function sharedAudience(db: Db, handle: string): Set<string>                 // DISTINCT handles sharing ≥1 group with handle (plan §2.1.4 presence)
export function requireCap(m: Map<string, Membership>, groupId: string, cap: MemberCap): 'ok' | 'unknown_group' | 'cap_denied'
export type ReaderScope = { sql: string; params: string[] }
export function readerScope(m: Map<string, Membership>, column = 'group_id', idColumn = 'id'): ReaderScope
```
`readerScope` returns a SQL fragment to AND into a WHERE clause: `(` + one `(group_id = ? AND id > ?)`
per membership joined by ` OR ` + `)`; empty memberships ⇒ `(0)` (fail-closed). `requireCap` returns
`unknown_group` when the group is not in `m` (existence is not admitted), `cap_denied` when in `m` but
cap missing.

Tests (`groups.test.ts`, `:memory:` db seeded through `openDatabase` + direct inserts): memberships for
a handle in two groups; `members('lab')`; `sharedAudience` for b in cookys+lab returns a,c but never b's
non-shared peers; `requireCap` three outcomes; `readerScope` **executed** against a table with rows in
`cookys`/`lab`/`other` and ids below/above each since → returns exactly the expected ids; empty scope
returns no rows; a grep-style test asserting that `packages/relay/src/messages/store.ts` contains no
`.filter(` call inside the five `fetch*` functions' bodies (read the file, slice by function name) —
this guards plan §2.5-3 for P1 and must PASS on the current file.

## Acceptance (the harness checks these; do not self-report)

- `scripts/verify-groups.sh` exits 0: shared + relay suites green (pre-existing 149 + 408 unchanged, plus
  the new cases above), both typechecks clean.
- `git diff --stat` touches only the files listed at the top.
- No route file, `fanout.ts`, `store.ts`, `stream.ts`, `index.ts`, `serve.ts`, or peer-agent file is modified.
