<!--
STATUS: v7 — PROPOSED, not implemented. LOOP CLOSED at the five-round cap: round 5
was 3× FIX-THEN-SHIP (codex 2 Critical, both folded: unaddressable routes are
tombstoned not deleted; takeover CASes lease AND reserved_at). Findings were
still arriving at implementation granularity each round; the operator's call
is to proceed to implementation with per-PR panel review rather than a sixth
spec round. Residuals are listed in §17. v6 folded round 4 (codex FIX, 1
Critical: idempotency lease fencing; MiniMax FIX; glm parse failure): lease token,
failure transitions, key scope + request digest, finalise state machine,
no-selector predicate, fanout uses the frozen snapshot, sender_state on
matched:0, pins schema. v5 folded round 3 (codex FIX with 2
Critical; MiniMax transport failure; glm parse failure): courier grant
finalisation as a relay operation, delivered_at rules restated, `~none` in the
header grammar, limiter and idempotency persistence, crew attach after the
harness is up, name resolved before launch, thread membership tuple, evidence
manifest in the gate. v4 folded round 2 (2× FIX, 1 parse failure): harness allowlist + pid ancestry before attach, `~none` unreplyable
selector, per-pane grants via selector, idempotency reserved before effects,
presentation invariant restated, /v1/inbox API, cascade + alias index,
NULL-instance backfill policy, gate collector. v3 folded round 1 (3× FIX):
registration generation in the return selector, atomic pane lookup, mailbox
branch of the reply verb, /v1/replies write order, backfill mapping, error
contract columns, use_reply_verb behind the flag. v2 added the address model (§8.0):
registration is the only return path a harness has, because a harness never
pulls; a pane sender without a registration gets one lazily at first send;
the operator mailbox is scoped to senders outside any pane. Mechanism half of hangar
ADR-_global/0015 ("a fleet reply addresses a session, never a host"); the
ADR carries the decision and rationale, this file carries everything an
implementer needs. Where the two disagree, fix both; neither overrides.
Review history: six ADR revisions through a five-round three-family panel
(gpt-5.6-sol / MiniMax-M3 / glm-5.2, union-on-verified-critical), 2026-09-04.
Round 5 closed at the cap with no Critical outstanding. Per-round findings are
in hangar log/2026-09.md § 2026-09-04.
Source re-verified against tree as of 2c4ede3 (2026-09-03).
-->

# Reply Routing — Implementation Spec (v7)

Status: **proposed**. Target: `hangar-bridge` (relay + peer-agent + shared),
`dotfiles/bin/fleet` (CLI), `@cookys/agent-call` (local lane). Companion to
[SUBJECT_ROUTING_SPEC.md](./SUBJECT_ROUTING_SPEC.md); this spec does not change
subject / ACL semantics and everything here is subject-null unless stated.

Decision and rationale: hangar
`decisions/_global/0015-fleet-reply-addresses-a-session.md`. One sentence of
it: **a handle is a mailbox for a host; an address is a session; a reply is a
verb with no address, resolved on the relay.**

## 1. Goal & non-goals

### 1.1 Goal

1. Answering the message in front of you takes **zero addressing decisions**
   and cannot reach anyone but the session that sent it.
2. Every send that would reach more than one session says so up front
   (explicit flag) and reports afterwards exactly who it reached.
3. CLI and courier-lane senders (operator shells, codex/kimi/agy/opencode
   panes) become answerable; today they have no session identity at all.
   For a harness in a pane the **only** return path is the courier pasting
   into that pane, and the courier's only map is the `agent-call` registry —
   so "answerable" means "registered", and registration must not depend on
   the operator remembering to launch through `crew`.

### 1.2 Non-goals

- `reply_all` / thread-wide answers. Deferred; re-open when a concrete thread
  needed three or more participants to see one answer.
- Per-instance credentials. Same-bearer mutual trust stays (§10).
- Routing the protocol-generated kinds (`task_result`, `permission_*`,
  `presence_update`) through the route table. They are **exempt** (§6.4).
- Message retention / purge. Named as a follow-up in §3.4.

## 2. Vocabulary

| Term | Meaning |
|---|---|
| handle | the relay principal a bearer authenticates; one per host (`cuda`), shared by every session on it |
| instance | per-process id a session declares in `x-hangar-instance` on send and on stream subscribe; syntax-checked only |
| session | `handle#instance` — the unit of address |
| route | relay-side record keyed by message id that says who sent a message and to whom it may be answered |
| grant | `(route, handle, instance)` — a session that was eligible to receive the route's message |
| registration | an `agent-call` registry entry: name → pane (tmux ingress) or channel socket, pid, cwd; the courier's delivery map |
| user-authored kinds | `chat`, `task_dispatch` |
| protocol kinds | `task_result`, `permission_request`, `permission_verdict`, `presence_update` |

## 3. Data model

### 3.1 `reply_route` table (new, relay)

```
reply_route(
  msg_id           TEXT PRIMARY KEY,   -- == the envelope id the receiver sees
  team_id          TEXT NOT NULL,
  from_handle      TEXT NOT NULL,
  sender_instance  TEXT,               -- relay-stamped; NULL only on pre-rollout rows
  return_selector  TEXT,               -- from x-hangar-return-selector header; courier panes only
  to_handle        TEXT NOT NULL,      -- '@team', a handle, or '@mailbox:<handle>'
  to_filter_json   TEXT,
  thread_root      TEXT NOT NULL,      -- effective root, never NULL (§3.3)
  legacy_width     TEXT,               -- NULL | 'handle' | 'team-not-sender' | 'unreplyable' (§5.3)
  correlation_id   TEXT,               -- alias key for ephemeral chat (existing meta.correlation_id)
  created_at       TEXT NOT NULL,
  expires_at       TEXT,               -- NULL = follows the message row; set for ephemeral + legacy
  unaddressable_at TEXT                -- tombstone (§5.4): set, never deleted, so later grants still insert
)
reply_grant(
  msg_id TEXT NOT NULL REFERENCES reply_route(msg_id) ON DELETE CASCADE,
  handle TEXT NOT NULL,
  instance TEXT NOT NULL,              -- '~cli' for the operator mailbox
  selector TEXT NOT NULL DEFAULT '',   -- '<name>@<generation>' when the courier pasted into a pane; '' otherwise (§5.2)
  PRIMARY KEY (msg_id, handle, instance, selector)
)
CREATE UNIQUE INDEX reply_route_correlation ON reply_route(correlation_id) WHERE correlation_id IS NOT NULL;
```

A route is **never deleted** while its message row can still be presented:
`parent_unaddressable` sets `unaddressable_at` (a tombstone the reply verb
refuses on) so a later drain or poll can still insert its grant. Routes go
away only with their message row (durable) or at `expires_at` (ephemeral,
legacy); the cascade covers those. The alias index makes `correlation_id`
resolution deterministic.

Two more small tables so §5.1 can commit everything in one transaction:

```
reply_limiter(
  thread_root TEXT NOT NULL, handle TEXT NOT NULL,
  window_start TEXT NOT NULL,          -- fixed window, floor(now / window) as ISO
  count INTEGER NOT NULL,
  PRIMARY KEY (thread_root, handle, window_start)
)                                       -- rows older than 2 windows are swept by the purge loop
reply_idem(
  key_hash BLOB PRIMARY KEY,            -- sha256 of length-prefixed (team_id, handle, key): len‖bytes for each
  request_digest BLOB NOT NULL,         -- sha256 of RFC 8785 (JCS) canonical JSON of {in_reply_to, content, meta}
  state TEXT NOT NULL CHECK(state IN ('pending','committed','final','error')),
  lease TEXT NOT NULL,                  -- ULID; changes on every takeover (fencing token)
  reserved_at TEXT NOT NULL,            -- refreshed on every takeover
  result_status INTEGER,                -- HTTP status to replay
  result_json TEXT,                     -- body to replay: at 'committed' (before fanout), 'final', or 'error'
  error_until TEXT                      -- for 'error' rows that may be re-executed (reply_storm): retry_after
)
```

`Idempotency-Key` grammar: 1–64 chars of `[A-Za-z0-9_-]`, else 400
`idempotency_key_invalid`.

`Idempotency-Key` is **required** on `/v1/replies` (400 `idempotency_key_required`
otherwise); the CLI and MCP mint a ULID per call and reuse it on retry. The
key is scoped to `(team, authenticated handle)`, so two handles cannot see
each other's results; the same key with a different `request_digest` is 422
`idempotency_mismatch`.

A route exists for every accepted user-authored message, persisted or not,
**except** a directed `task_dispatch` that matched nobody (today: no row;
here: no route; a later reply is `unknown_parent`). The table is invisible to
`poll_inbox` and the cold-start drain: directed chat stays ephemeral in the
sense that matters (nothing replays it) while becoming answerable.

### 3.2 Write order (the load-bearing part)

On `POST /v1/messages` for a user-authored kind:

1. Validate the envelope as today.
2. Take the **matched snapshot** from the live subscription set — the same
   set `deliverDetailed` already reports as `matched_sessions`
   (`handle#instance`). Zero matches is a valid snapshot.
3. In **one transaction**: insert the route; insert one grant per snapshot
   entry; insert the `message` row where the kind calls for it (unchanged
   rules: project chat, bare-handle chat, `@team` chat, and directed
   `task_dispatch` only when the snapshot is non-empty).
4. Only then call `deliverDetailed` — with **the frozen snapshot**, not a
   fresh match — and write events to streams. A session that subscribed
   between snapshot and fanout is not delivered to live (it has no grant);
   a durable row reaches it on drain, which grants it then. For ephemeral
   directed chat the order is the same: transaction commits, then
   `deliverDetailed` with the snapshot, then stream writes; there is no
   persist call at all.

A route insert failure aborts the send (500, nothing delivered). A fast
recipient can therefore never reply before its route and grant exist. The
route PK **is** the message id where a `message` row exists and a standalone
ULID otherwise; the transaction commits before any stream event, so a
`fetchSince` that beats the commit sees neither the row nor the route. The
`message` row keeps its already-stamped `meta.sender_instance`; the route
copies it, it does not move it.

A grant is **delivery eligibility**, not proof of receipt. SSE cannot prove
consumption and nothing here pretends it can. The invariant, stated once for
every presentation path (live, drain, poll, inbox): **grant commits before
the message is written; a grant-insert failure aborts before presentation;
a transport failure after commit leaves the grant standing** — the session
was eligible, and what the row does next is exactly today's behaviour
(below): a null-subject durable row that was stamped `delivered_at` at send
time is **not** replayed after a failed write (accepted, unchanged); a
subjected row stays pending and drains later. The audience report lists the
session in `live` as `(write failed)`. Nothing is rolled back after commit.

`delivered_at` keeps **today's** rules, restated so nothing is invented: for
a null-subject durable row it is stamped at send time when any recipient
handle is online (the existing P4'b optimisation, including the
sender-is-only-subscriber case); for a subjected row it is stamped only
after a successful `writeSSE` by the stream loop; a directed chat has no
row and therefore no stamp; partial fanout leaves the row stamped or not by
those same rules. This spec adds routes and grants beside that, and changes
none of it.

A reply (§5.1) goes through the same order for its own route; that route's
`thread_root` is the parent route's `thread_root`, copied, never recomputed.

### 3.3 Effective `thread_root`

Never NULL. For a new root message it is the message's own id; for a reply it
is the parent route's `thread_root`; for a thread continuation (§7) it is the
validated supplied root's `thread_root`. Every descendant and the limiter
(§9) key on this value. (`buildEnvelope` already computes
`parent.thread_root ?? parent.id`; the route stores the result.)

### 3.4 Lifetime

| Route for | Lives |
|---|---|
| a durable `message` row | exactly as long as the row (today: forever — a retention decision is a follow-up; the table grows with `message` and no faster) |
| ephemeral directed chat | `expires_at = created_at + 7d` (tunable, §12) |
| a backfilled legacy row (§5.3) | `expires_at = migration + 7d`, which takes precedence over "follows the row" |
| a mailbox reply row (§5.1 mailbox branch) | exactly as long as its `message` row (`expires_at` NULL) |

Expired route ⇒ reply is `unknown_parent`, same as an unknown id.

## 4. Grants on every presentation path

Every path that hands a message to a session writes the grant **before**
returning the message:

| Path | Grant written |
|---|---|
| live SSE fanout | from the snapshot, in the send transaction (§3.2) |
| cold-start drain / `?since=` replay (`fetchSince`) | `(msg_id, handle, subscriber instance)` before the SSE write |
| `poll_inbox` | `(msg_id, handle, poller's declared instance)` before the response |
| mailbox inbox (`GET /v1/inbox`, §8.2) | `(msg_id, handle, '~cli')` — written once at persistence time, since a mailbox row is never fanned out |

Grants are unique per key; a replay from an old cursor adds nothing. The
peer-agent's cursor remains the dedup authority that keeps a replayed message
from being presented for a second answer.

**Drain self-exclusion.** Today `fetchSince` excludes the sender's own handle
only for `@team` rows (`to_handle='@team' AND from_handle != ?`), so a durable
bare-handle self-send would replay into the sender's own session on its next
cold start. The predicate gains, for direct rows,
`AND (json_extract(meta_json,'$.sender_instance') IS NULL OR
json_extract(meta_json,'$.sender_instance') != <poller instance>)` — the
column the send chokepoint already writes. `poll_inbox` and the drain never
see mailbox rows (`to_handle = '@mailbox:…'` is outside their predicate);
`GET /v1/inbox` (§8.2) owns those exclusively, so a mailbox row is granted
once, at persistence, and nowhere else. Replay grants are idempotent
re-assertions of the same `reply_grant` row; the table is the single source
of truth the reply verb reads. A courier that subscribed after the snapshot is granted on drain like any
other late subscriber (durable rows only; an ephemeral directed message
aimed at a courier instance that held no subscription at snapshot time is
`matched: 0` for the sender and is lost, as today). A grant is pinned to the
instance it was presented to: a restarted process is a new session and inherits nothing —
it is granted again only if a row is re-presented to it (`poll_inbox`, or a
still-pending row on cold start). A session that restarts mid-thread
therefore cannot answer what its predecessor received unless it reads it
again; that is the same rule as "a restarted sender is a visible miss",
seen from the receiving side.

## 5. The reply verb

### 5.1 Surface and resolution

| Surface | Shape |
|---|---|
| MCP | `reply_to_peer({ in_reply_to: msg_id, content, meta? })` |
| CLI | `fleet reply <msg_id> "<text>"` |
| relay | `POST /v1/replies` `{ in_reply_to, content, meta? }` |

It accepts **no** `to`, `to_filter`, `fleet_wide`, `all_sessions`, `subject`.
`meta` is informational; the relay deletes `local_target`, `instance`,
`sender_instance`, `session_id`, `attribution_status`, `ephemeral` from it as
it does on `/v1/messages`.

`POST /v1/replies` runs, in this order:

1. Idempotency (`reply_idem`): **reserve** the key first — insert
   `state='pending'` with a fresh `lease` ULID, remembering it as *my
   lease*. A duplicate that finds `pending` waits up to 10 s for the state
   to change, then returns 409 `reply_in_progress` (retryable);
   `committed`, `final` or `error` returns `result_json` as-is (200 for the
   first two, the stored status for `error`). A `pending` row older than
   60 s is a crashed reservation: the next holder **takes it over by one
   CAS that sets `lease` to a new ULID AND `reserved_at = now`** (both, or
   every concurrent retry could keep re-taking it) and re-runs **every** step
   below as if fresh — the limiter counts the takeover attempt, not the
   original's. Every
   write below that changes state runs `… WHERE key_hash = ? AND lease = <my
   lease>` and aborts with 409 `reply_in_progress` if zero rows changed —
   so a worker that was taken over cannot commit, increment the limiter,
   mint a route, or fan out; the token is the fence. Steps 2–5 refusing
   (`unknown_parent`, `not_a_recipient`, `legacy_unreplyable`,
   `parent_unaddressable`, `reply_storm`) move the row to `error` with the
   refusal as `result_status`/`result_json` in the same fenced statement
   (the step-4 tombstone write is in that statement too, so a fenced-out
   worker cannot tombstone), so a retry gets the same answer without
   re-running the checks — except `reply_storm`, whose row carries
   `error_until = retry_after` and is re-executed by a retry after that
   time. Every `error` body carries `retry_with_new_key: true` so a caller
   that meant a *new* reply knows to mint a new key. Nothing below
   runs twice for one key, and a duplicate neither mints a route nor counts
   against §9.
2. `route = reply_route[in_reply_to]` (or by `correlation_id` alias); missing
   or expired ⇒ `unknown_parent`.
3. Audience check (§5.2) against `reply_grant`; legacy width (§5.3) if set.
4. `route.sender_instance` NULL (legacy rows included), `route.return_selector
   = '~none'`, `from_handle` disabled/removed, or `unaddressable_at` already
   set ⇒ `parent_unaddressable`; the route is tombstoned
   (`unaddressable_at = now`), never deleted.
5. Limiter (§9): the check **and** the increment are one conditional
   statement inside the fenced step-6 transaction (`… WHERE count < 10`,
   zero rows ⇒ `reply_storm`), so two concurrent replies cannot both see
   `count < 10`.
6. Build the envelope:
   - **session branch** (the normal case): `to = route.from_handle`,
     `to_filter.instance = route.sender_instance`, `in_reply_to =
     route.msg_id`, `thread_root = route.thread_root`, `kind = chat`,
     `subject = null`, `meta.local_target = route.return_selector` when set.
     Then the §3.2 write order applies to the reply itself: snapshot → one
     transaction (new route with the reply's own id and the parent's
     `thread_root`, its grants, the limiter increment, **and the
     idempotency row → `committed` under the lease fence**) → fanout with
     the frozen snapshot. The mailbox branch runs the same transaction
     (message row, route, single grant, limiter, `committed`). A crash after commit and before fanout
     leaves `reply_idem` at `committed`; the drain paths do not replay the
     reply (no `message` row) and a retry returns the committed result with
     `fanout: unknown` instead of sending again — an accepted lost reply.
     After fanout the row moves to `final` with the actual `live` list; a
     crash between the two leaves `committed`, which is the honest state. Zero matches ⇒
     `matched: 0` result with `sender_state: offline` (the sender's instance
     holds no subscription right now; a restarted sender looks the same),
     route still written; a non-zero match carries `sender_state: live`.
     The caller distinguishes this from `parent_unaddressable` by status
     (200 vs 410).
   - **mailbox branch**: when `route.sender_instance` is the reserved `~cli`,
     the envelope is `to = '@mailbox:<route.from_handle>'`, no `to_filter`,
     never fanned out; one transaction persists the `message` row (so
     `GET /v1/inbox` can drain it), the reply's route, and the reply's own
     single grant `(reply id, from_handle, '~cli', '')`. The *parent* that a
     mailbox user answers is a mailbox row too, and already carries its
     grant `(parent id, handle, '~cli', '')` from §4, which is what §5.2
     matches for a `~cli` replier. Result: `live: []`, `durable:
     <handle>~cli`. The reserved-address refine (§6.5) applies to
     client-supplied addresses only; relay-internal resolution is exempt.
7. Respond with the stored result.

`send_to_peer` / `POST /v1/messages` refuse `in_reply_to` on user-authored
kinds with `use_reply_verb` **when the rollout flag is on** (§16); flag off,
today's behaviour stands. Protocol kinds keep `in_reply_to` regardless
(§6.4). Same control shape as the fleet-wide gate: a different tool, not a
different argument.
### 5.2 Audience check

Accepted only if `(replier handle, replier declared instance)` is in
`reply_grant` for the route; otherwise `not_a_recipient`. When the grant
carries a `selector` (the courier pasted the parent into one pane), the
reply must present the same `x-hangar-return-selector`; a pane on the same
host that was not pasted into is `not_a_recipient`. This narrows the shared
courier instance back to the pane that actually holds the parent (§8.1) —
against mistakes, not against a hostile sibling: the selector is presented
by the sender, and a pane on the same host runs under the same bearer and
can read the same registry, so it could present another pane's selector.
That is the §10 boundary, unchanged. A `@team` or repo
parent grants every session that actually received it and nobody else.
Message ids are therefore not capabilities: learning one from a log grants
nothing. Same-bearer siblings can pass the instance half only under §10.

### 5.3 Legacy mode (backfill)

At migration a route is backfilled for every retained `message` row. Who
consumed those rows cannot be reconstructed (no delivery ledger), so the
backfill records a `legacy_width` and the audience check applies it
**verbatim** — legacy is data, not a policy branch, and flipping the rollout
flag changes nothing about it:

| Row shape | `legacy_width` | Reply accepted from |
|---|---|---|
| direct handle, no `to_filter` | `handle` | any instance of that handle |
| `@team`, no `to_filter` | `team-not-sender` | any handle except `from_handle` (the drain predicate excluded those siblings) |
| `@team` + `{repo}` (project chat) | `repo:<name>` | any session whose current presence publishes that repo (the audience it had when live) |
| anything else with a `to_filter` (instance-narrowed) | `unreplyable` | nobody (`legacy_unreplyable`) |

A reply to a legacy route is reported with `legacy_parent: true`.

Backfill mapping, per retained `message` row **of kind `chat` or
`task_dispatch` only** — protocol rows get no route and stay non-parents
(§6.4):

| route column | from |
|---|---|
| `msg_id` | `message.id` |
| `from_handle`, `to_handle`, `to_filter_json` | same columns |
| `sender_instance` | `json_extract(meta_json,'$.sender_instance')` — NULL for rows sent by the CLI or pre-attribution peers. **Policy, stated:** such a route is `parent_unaddressable` even in legacy mode, because no session exists to deliver to; legacy width answers *who may reply*, not *where a reply can go*. This includes the incident row itself (`msg_01M1MCFRQPT1RCK5KK04DYERVJ`, CLI-sent). Accepted: those parents were unanswerable before this spec too, and the migration report prints the count. |
| `thread_root` | `COALESCE(thread_root, id)` |
| `legacy_width` | by row shape, table above |
| `correlation_id` | `json_extract(meta_json,'$.correlation_id')` |
| `created_at` / `expires_at` | `sent_at` / migration time + 7 d |

### 5.4 Unaddressable and gone

| Condition | Result |
|---|---|
| `route.sender_instance` NULL, or `from_handle` disabled/removed | `parent_unaddressable` (terminal; route dropped). Never widens to the handle. |
| sender session offline | `matched: 0` + the existing "NO live session matched" report. **Not retried automatically**; the caller re-runs `list_peers` and sends a fresh message if it still matters. |
| sender restarted | new instance id ⇒ `matched: 0` for its own earlier outbound. A visible miss, never re-aimed. |
| legacy route with NULL `sender_instance` (CLI-sent, pre-attribution) | `parent_unaddressable` (§5.3 policy, enforced here) |
| target pane re-attached (restart, harness change, lazy re-attach) | new generation ⇒ the route's `return_selector` is stale ⇒ `return_target_gone` with `reason: generation_stale` at the courier; the sender is told to send a fresh message |

From rollout step 3 the relay requires `x-hangar-instance` on every
user-authored send (`sender_instance_required`), so the only unaddressable
parents left are pre-step-3 rows.

## 6. Address rules on ordinary sends

### 6.1 Bare handle needs `all_sessions`

A bare handle `to` (no `to_filter`) on `chat` is accepted only with
`all_sessions: true` (CLI `--all-sessions`) — regardless of how many sessions
are live. Reason is temporal: a bare-handle row is durable and `fetchSince`
hands it to every sibling that connects later, so "one session live now" is
not "one recipient". "Every sibling that connects later" is the accepted
meaning of a host-wide send, not a defect. Refusal
`handle_needs_all_sessions` lists the handle's live instances.

`all_sessions` is a boolean acknowledgement, not a selector: the relay
validates its shape and the sender's authorization only; zero live sessions
is accepted as a durable row. It is chat-only, one concrete handle only
(never `@team`, never with `fleet_wide`). It does **not** override
self-exclusion; the hint reads "that is every *other* session on this box".

### 6.2 `task_dispatch` requires an instance

A bare-handle dispatch is refused (`dispatch_needs_instance`). Closes the
latent "one command, many executions" path that `envelope.ts` guards only when
a `to_filter` is present. A host-wide command is permanently unsupported; it
is expressed as one dispatch per instance from `list_peers`.

### 6.3 Own handle

`to = <own handle>` follows §6.1 unchanged. The incident command
(`fleet send --to cuda` from a `cuda` session) is refused by it.

### 6.4 Protocol kinds are exempt

`task_result` (schema requires `in_reply_to` to its dispatch and forbids
`to_filter`, so it is bare-handle by construction), `permission_request` /
`permission_verdict` (request-id keyed, `in_reply_to` the request) and
`presence_update` keep today's addressing and are never reply parents. Their
receivers already filter by `correlation_id` / `request_id`.

### 6.5 Reserved addresses

Instance ids are ULIDs (`isValidInstanceId`, `shared/ulid.ts`), so the
reserved instance `~cli` cannot collide with a real one and cannot appear in
a stream subscription — `parseInstanceHeader` already rejects it as
malformed; the spec adds the explicit `reserved_instance` code for the
message. The relay accepts the literal `~cli` **only** as the value of
`x-hangar-instance` on `/v1/messages` and `/v1/replies` (the CLI's mailbox
identity, §8.2); it is never a valid `to_filter.instance`, `--instance`, or
registration name (`agent-call` rejects a name containing `~`). The
recipient `@mailbox:<handle>` is likewise never a valid `to` on
`/v1/messages` (`reserved_address`); only the reply verb's mailbox branch
writes it.
## 7. Thread continuation (not a reply)

`send_to_peer` accepts `thread_root`. The relay validates it as the id of a
route the caller **sent or holds a grant on** (else `not_in_thread`) and
canonicalises to that route's effective root. The predicate is **sent OR granted**: "sent" is
`route.from_handle = caller handle AND route.sender_instance = caller
instance AND (route.return_selector IS NULL OR route.return_selector IN
('', '~none') OR route.return_selector = caller selector)` — NULL, empty and
`~none` all mean "no selector", which is every ordinary bridge session and
every `~cli` caller; "granted" is the §5.2 match including the selector
rule, and a mailbox row's `(id, handle, '~cli', '')` grant qualifies like
any other. A recipient that was not the sender may therefore continue the
thread for a different audience, which is the ADR's stated intent. A
legacy route counts as sent only on the handle (its instance may be NULL). The message then goes through
§6 in full. This is the only sanctioned path to a wider audience inside a
thread; it cannot name an arbitrary root and it is deliberately not called a
reply.

## 8. CLI identity and the address model (R1-CLI)

`fleet send` and `fleet reply` always send `x-hangar-instance`. Today the CLI
sends none, which is why every operator and courier send is
`attribution_status: unverifiable` and unanswerable — and why the incident's
sender received its own message (no self-exclusion without an instance).

### 8.0 Address model

A harness never pulls. Whatever reaches a harness in a pane is **pasted** by
the switchboard courier (one daemon per Unix user) or by `agent-call send`,
and both look the target up in the `agent-call` registry. A registration is
therefore the one and only return address a pane has; a mailbox a harness
would have to poll is not a return path, it is a black hole with a name.

| Sender | Address | Lifetime | Who delivers a reply |
|---|---|---|---|
| any harness in a tmux pane, however launched | registration `<dir>--<harness>` — created by `crew` at launch, or **lazily at first send** (§8.1) | the pane process's lifetime; cleanup detaches on pid death or harness mismatch | courier pastes into the pane; `agent-call send <name>` likewise |
| a Claude session with the bridge MCP | relay instance id (and, when in a pane, a registration too) | the process's lifetime | relay delivers to the instance; `fleet reply` resolves to it |
| a shell or script outside any pane | operator mailbox `<handle>~cli` (§8.2) | durable | nobody — pull with `fleet inbox` |

Three consequences. Registration is a **precondition of being answered, not
of sending**: one-way sends from anything stay legal. A sender that has no
registration and cannot get one (not in a pane) is told so on the way out
and its frame says "reply route unavailable" (§14). And `crew` stops being
the only door: it is the tidy way to get an address at launch, and the lazy
path is the safety net for whatever was launched by hand.

### 8.1 Inside a pane → registration, courier identity, return selector

`fleet send` / `fleet local send` / `fleet reply` run inside a tmux pane
(`$TMUX_PANE` set) resolve the pane's registration **before** stamping any
header, in one idempotent call:

```
agent-call attach --if-absent --tmux-pane $TMUX_PANE \
  [--name <AGENT_CALL_NAME>] --harness <pane current command>
```

which returns the pane's existing registration if one exists **for this
pane id** with a live pid and a `harness` equal to the pane's current
command (the `ac_taken` check, made at lookup time, not only at cleanup),
else creates one and returns it — **only if two preconditions hold**, checked
by `agent-call` itself, not by the caller: (a) the caller's pid **is** the
pane's pid or has it as an ancestor (walk `PPid` in `/proc/<pid>/status`
until 1), so a process cannot register a pane it is not running in, and (b) the pane's current command is in the harness
allowlist (`claude`, `codex`, `opencode`, `agy`, `kimi`, `qoder`,
`cursor-agent`, `grok`, extended in one place, `agent-call`'s
`SUPPORTED_HARNESSES`). A pane whose foreground is a shell (`zsh`, `bash`)
or anything else is **never** registered: pasting peer content into a shell
executes it. Either precondition failing takes the one-way path below. The call is
**synchronous**: `fleet send` / `fleet reply` block on it and stamp
`x-hangar-return-selector` from its return value — `<name>@<generation>` on
success, `~none` with the reason on failure — and never proceed without one
of the two. Lookup is by pane, never by name, so a
lazily attached pane finds itself again on the next send without exporting
anything, and a name held by a live registration elsewhere yields `-2`,
`-3` … exactly as `crew` does. Name precedence for a new registration:
`AGENT_CALL_NAME` if set (a `crew`-launched Claude keeps the name its
`--resume` was started with — never a derived one that would split the
transcript), else `<basename of cwd>--<pane current command>`
(`revival.3d--opencode`). Print one line: `fleet: this pane is <name>;
replies will land here`.

Every registration carries a **generation**: a ULID minted at attach, stored
in the registry and returned by the call. The return selector is
`<name>@<generation>`; the courier delivers only when the registry's current
entry for `<name>` has that generation and a live pid whose pane still runs
the registered harness. A pane that was re-attached (restart, harness
change, lazy re-attach after cleanup) has a new generation, so an old reply
is `return_target_gone` — the pane-lane equivalent of "a restarted sender is
a visible miss" (§5.4), not a paste into whoever lives there now.

If the call fails inside a pane (precondition, no `agent-call` on the host,
registry unwritable), the send still goes out **one-way** with the courier
instance and the explicit selector `~none`: the route records
`return_selector = '~none'`, the reply verb treats it as
`parent_unaddressable` (a manual reply cannot black-hole into the courier),
the frame's reply line reads "reply route unavailable", and the sender is
told `fleet: could not register this pane (<reason>); the receiver cannot
reply`. It does **not** fall through to the mailbox: a harness never pulls
(§8.0).

With a registration in hand, the identity is the host's switchboard courier
instance. The courier is the host's peer-agent running with
`final_mile.kind = agent-call` + `switchboard`; it holds one authenticated
SSE subscription under its instance like any peer, so a reply resolved to
`to_filter.instance = <courier instance>` reaches it through ordinary
fanout, and it recognises a paste job by the relay-stamped
`meta.local_target`. Today that instance is minted per process
(`newInstanceId()` at peer-agent start); the courier **persists** it
(`~/.config/hangar-bridge/config.json` → `instance`, honoured at start) so a
restart keeps every route valid. Because the instance persists, no grant migration is needed on restart; if
the persisted id is lost (config wiped) the new courier is a new instance,
every blank grant keyed to the old one is orphaned, finalisation returns
`grant_not_found` and each such delivery is a final-mile failure —
accepted, and the same shape as a wiped registry. Two couriers alive during
a restart are handled by the relay's existing stream supersession — a newer stream from
the same instance supersedes the older one (`routes/stream.ts`,
`relay.stream.superseded`; `stream-superseded.test.ts`). The send carries
`x-hangar-return-selector: <name>@<generation>`.

Relay chokepoint: parse and syntax-check the header — grammar
`<name>@<ULID>` **or** the literal `~none` — store it in
`route.return_selector`; on the reply verb delete any client-supplied
`meta.local_target` and stamp it from the route. On `send_to_peer` a
sender-supplied `meta.local_target` remains what it is today — a pane
address (`--local`), no more privileged than `to_filter.instance` — and it
never enters a route.

Courier delivery of a reply: resolve `meta.local_target` (`name@generation`)
against the live registry as above; mismatch or dead ⇒ `return_target_gone`
with `reason: not_registered | generation_stale | harness_changed |
pid_dead | none_selector`, surfaced as a final-mile failure (`FINAL-MILE-FAILED(n)` in the presence
summary, as today). **Never** fall back to "all panes in the project". A
courier whose registry was wiped answers `return_target_gone` for every old
selector; the sender then issues a new message, which lazily re-registers.
Courier delivery is **unconfirmed** by construction: the reply result lists
it as `courier#instance (unconfirmed)`.

**A bridge Claude session in a pane.** Its own messages arrive on its
relay instance (no selector), but a parent that the courier pasted into
its pane carries a selector grant. `reply_to_peer` therefore presents the
pane's selector automatically: when `$TMUX_PANE` is set, the peer-agent
reads the pane's current registration (`name@generation`) from the local
registry at call time and sends it as `x-hangar-return-selector`, exactly
as the CLI does. Nothing about that is a caller decision.

**Grant finalisation (courier → relay).** The send transaction gave the
courier a blank grant `(msg_id, handle, courier instance, '')`. Before
pasting into a pane the courier calls `POST /v1/grants/finalize
{ msg_id, selector: '<name>@<generation>' }` under its own bearer and
instance header; the relay verifies that exact blank grant exists and
atomically **replaces** it with the selector-bearing row (no blank row
survives, so §5.2's pane check cannot be bypassed), returning 404
`grant_not_found` otherwise. Only on 200 does the courier paste. A
finalisation failure suppresses the paste and is reported as a final-mile
failure with `reason: finalize_failed` (the message is ephemeral and lost,
which is the same outcome as any other final-mile failure today). State machine, per `(msg_id, handle, courier instance)`: **blank** (one
row, selector `''`, written by the send transaction) → first finalise
**replaces** it with `selector = S1` → each further finalise from the same
authenticated courier instance **inserts** a row for `S2`, `S3` … as long
as at least one non-blank row exists for that key (that is the
authorisation: only the courier that already holds the grant may widen it,
and only to panes it is pasting into now); a finalise for a selector that
already exists is a no-op 200; a finalise when neither a blank nor a
non-blank row exists is 404 `grant_not_found`. The blank row is never
re-created. §5.2 then reads "the replier's selector equals one of the
granted selectors".

Ordering guarantee: the registration exists before the send leaves the
host, and the route exists before any recipient sees the message, so no
reply can arrive at the courier before its target is registered. There is
no attach-vs-delivery race to serialise beyond "attach first".
### 8.2 Outside any pane → operator mailbox (pull-only, humans and scripts)

Applies only outside a tmux pane (`$TMUX_PANE` unset): a plain shell, a
cron job, a script. The identity header value is the literal `~cli`; the
handle comes from the bearer, and `<handle>~cli` is display syntax only
(`fleet peers`, audience reports). It is provisioned lazily on first use.

`GET /v1/inbox?since=<msg_id|''>&limit=<1..500>` (bearer of the handle):
returns `{ messages: Envelope[], last_id: msg_id | null, has_more: bool }`,
rows with `to_handle = '@mailbox:<handle>' AND id > since`, ascending by id,
at most `limit` (default 100); `last_id` is the last id returned on every
non-empty page (`null` only for an empty page), `has_more` says whether a
further page exists. It never stamps `delivered_at` and never deletes: the
client cursor is the only progress. `fleet inbox` keeps its cursor in
`~/.config/hangar-bridge/inbox-cursor.json`, sets it to `last_id` after
printing each page, starts from `''` (everything) when the file is absent,
and `fleet inbox --peek` reads without advancing. Retention is the
durable-row retention (§3.4 follow-up). This is deliberately **not** offered to a
harness: nothing would ever read it. The sender is told at send time:
`fleet: no pane to deliver replies into; they will queue in this host's
mailbox (fleet inbox)`. A reply to it is stored durably with recipient `@mailbox:<handle>`,
outside the `to_handle` predicate, and drained only by the authenticated
`GET /v1/inbox?since=<cursor>` of that handle (`fleet inbox`). It is **never
pushed** to any session and lives as long as any durable row. Its single grant
is `(msg_id, handle, '~cli')`, so any shell under that bearer may reply. A
mailbox is not a widening: it interrupts nobody.

### 8.3 Frames

The reply line names a message id, never a handle or a harness name, and
names the verb that will actually pass §5.2 for that receiver: a relay
channel frame into a bridge Claude session says `Reply: reply_to_peer
in_reply_to=<msg_id>` (the MCP tool, which stamps the pane selector itself
when there is one); a courier paste into a pane and a mailbox row say
`Reply: fleet reply <msg_id> "…"`; a `~none` route prints "reply route
unavailable" and no command.

### 8.4 Registration lifecycle (crew + cleanup)

- `crew` attaches every harness it launches, **Claude included**: today
  Claude gets only `AGENT_CALL_NAME` and relies on an `agent-call-local`
  channel that exists only in projects with a `.mcp.json`, so most `crew`
  Claude sessions have a name and no registration (cuda 2026-09-03: three
  of four). When that channel is absent, `crew` runs the same
  `agent-call attach --tmux-pane` it runs for codex. Tmux ingress into a
  Claude pane is already how `revival.3d--claude` is reached.
- **Attach after the harness is up, never before.** Today `crew` attaches
  while the pane's foreground is still the launcher shell, which the §8.1
  preconditions (allowlisted foreground, caller ancestry) would refuse, and
  which is also why its snapshot went stale. `crew` therefore launches the
  harness, then in a background job polls `pane_current_command` (up to
  30 s) until it is the expected harness and only then calls `attach
  --if-absent`; a timeout prints `crew: <name> never came up; not
  registered` and leaves the lazy path (§8.1) to catch the first send. The
  §8.1 preconditions apply to **every** registration mutation, `crew`'s
  included — there is one `attach` and it always checks.
- **Names are resolved before launch.** `crew` picks the unique name first
  (the existing `-2`/`-3` loop against live registrations), then uses that
  one name for `--resume`, `AGENT_CALL_NAME` and the attach, so the three
  can never disagree. An explicit name that is held by a live registration
  is a launch refusal, not a silent `-2`.
- `crew` detaches on normal exit (trap on the harness process ending) so a
  clean shutdown does not wait for cleanup. `crew`'s Claude attach uses the
  same retry loop and `-2`/`-3` collision rule as its non-Claude path, and
  the name it attaches is the one it started the process with.
- Every attach mints a generation (§8.1); re-attaching a pane invalidates
  every return selector issued under the previous generation. **Detach and
  cleanup are generation-fenced**: `agent-call detach <name>@<generation>`
  removes only that generation, so a stale exit trap or cleanup pass cannot
  remove a newer registration that reused the name.
- Only **generated** names take `-2`/`-3` on a live collision; an explicit
  name held by a live registration fails closed (launch refusal, attach
  refusal), in `crew` and in the lazy path alike.
- Cleanup (`fleet-pulse --health` and the operator's detach pass) keeps its
  objective rules — pid dead, or pane current command ≠ registered harness
  (`ac_taken`) — and gains nothing to guess: a lazily attached registration
  is indistinguishable from a `crew` one.
- Restarting a harness in the same pane re-registers on its next send if
  `crew` did not; a stale entry for the previous occupant is what
  `ac_taken` catches.

## 9. Relay-side reply limiter

Keyed on `(thread_root, replier handle)` — the handle because it is the only
unforgeable dimension, the thread because each reply mints a new route and a
per-route limit would never trip on a ping-pong. **Fixed window** in
`reply_limiter` (§3.1): `window_start = floor(now / 10 min)`; the increment
is an `INSERT … ON CONFLICT DO UPDATE SET count = count + 1` inside the
§5.1 transaction, and the check is `count < 10` before it. Survives relay
restart because it is a row, not memory; a window boundary resets it, and
the burst that a fixed window allows across the boundary (up to 2× for a
few seconds) is accepted. Refused with `reply_storm`, `retry_after_s` = time
to the next window. The peer-agent's per-process
limiter stays as preflight. Retries of one reply reuse the existing
idempotency-key header and are neither re-minted nor re-counted (§5.1 step
1). The per-handle key is a deliberate same-bearer choice (ADR risks
accepted); a hostile sibling can starve its own handle's budget and nobody
else's.

## 10. Trust boundary

A bearer authenticates a **handle**. Processes sharing it are mutually
trusted and any of them may declare a sibling's instance id on send or on
subscription. Consequently a same-handle sibling can (a) receive replies meant
for another sibling by subscribing under its id, (b) send with a sibling's
stamped `sender_instance` so replies go there, (c) pass the audience check
with a sibling's instance. The credential boundary is unchanged —
`to_filter.instance` already routes positively under this trust, and a sibling
can already subscribe as any instance. What is new and accepted is that the
*sender's* declared instance and return selector now steer automatic replies,
a confused-deputy shape that did not exist before. The "never positive
routing" comment in `routes/messages.ts` is rewritten to "positive routing for
replies, under same-bearer mutual trust; never authorization". A peer on a
different handle cannot forge either header for this handle, and the grant
check keeps it out of threads it did not receive.

## 11. Audience report (every send)

```
{ live:    ["cuda#01M1…", "cuda-kimi#… (unconfirmed)"],   // from the snapshot
  durable: [] | ["<handle>"] | ["repo:<name>"] | ["team"] | ["<handle>~cli"],  // the ADR's second list
  matched: N, sender_state?: "live"|"offline", legacy_parent?: true }
```

`durable: ["team"]` is an unfiltered `@team` chat (every handle may drain
it); `durable` is a list so the ADR's "two separate lists" holds even when
it has one entry.
`live` is the live subscription set (a session mid-reconnect is missing, one
connected but not yet publishing presence is present) and is never presented
as the complete audience; `durable` says which handle, repo, or mailbox may
drain the row later.

## 12. Tunables (relay config, not normative)

| Key | Default |
|---|---|
| ephemeral route TTL | 7 d |
| legacy route TTL after migration | 7 d |
| reply limiter | 10 per 10 min per `(thread_root, handle)` |
| reserved instance suffix | `~cli` |
| mailbox recipient encoding | `@mailbox:<handle>` |

## 13. Error vocabulary (shared by relay, CLI, MCP)

Response shape on every refusal: `{ error: <code>, message: <hint>,
retryable: bool, ...detail }` with the HTTP status below. `detail` carries
the machine-readable extra named in the last column.

| Code | Where | HTTP | Retryable | Meaning / hint / detail |
|---|---|---|---|---|
| `use_reply_verb` | `/v1/messages`, `send_to_peer` (flag on) | 400 | no | `in_reply_to` on a user-authored kind; "use `fleet reply <msg_id>`; to continue the thread for a different audience send a new message with `thread_root`" |
| `unknown_parent` | `/v1/replies` | 404 | no | no route (never existed, expired, zero-match dispatch) |
| `not_a_recipient` | `/v1/replies` | 403 | no | replier not in the route's grants |
| `legacy_unreplyable` | `/v1/replies` | 403 | no | backfilled row that carried a `to_filter` |
| `parent_unaddressable` | `/v1/replies` | 410 | no | route has no `sender_instance`, has `return_selector = '~none'`, or `from_handle` disabled/removed; the route row is deleted on this response |
| `reply_storm` | `/v1/replies` | 429 | after `retry_after_s` | §9; detail `retry_after_s` |
| `sender_instance_required` | `/v1/messages`, `/v1/replies` (flag on) | 400 | no | no `x-hangar-instance` on a user-authored kind |
| `handle_needs_all_sessions` | `/v1/messages` (flag on) | 400 | no | bare handle without `all_sessions`; detail `live_instances[]` |
| `dispatch_needs_instance` | `/v1/messages` (flag on) | 400 | no | bare-handle `task_dispatch` |
| `not_in_thread` | `/v1/messages` | 403 | no | `thread_root` names a route the caller neither sent nor was granted |
| `reserved_address` / `reserved_instance` | `/v1/messages`, `/v1/stream` | 400 | no | §6.5 |
| `use_relay_lane` | `fleet local send` preflight | — | no | §14: a Claude sender addressing a Claude registration; "use `fleet send --instance <id>`" |
| `return_target_gone` | courier final mile | — | no | §8.1; surfaces as `FINAL-MILE-FAILED(n)`; detail `reason` |
| `reply_in_progress` | `/v1/replies` | 409 | yes | §5.1 step 1: another request holds this idempotency key, or this worker lost its lease |
| `idempotency_key_required` / `idempotency_mismatch` | `/v1/replies` | 400 / 422 | no | §3.1: header missing / same key, different request |
| (not an error) retry of a `committed` reply | `/v1/replies` | 200 | — | stored result with `fanout: unknown`; do not resend |
| (not an error) `matched: 0` on a reply | `/v1/replies` | 200 | no | `sender_state: offline`; do not retry automatically (§5.4) |
| `grant_not_found` | `/v1/grants/finalize` | 404 | no | §8.1: neither a blank nor any non-blank grant exists for `(msg_id, handle, courier instance)` |
| `idempotency_key_invalid` | `/v1/replies` | 400 | no | §3.1 grammar |
| `instance_required` | `poll_inbox` (flag on) | 400 | no | §4: a poll without `x-hangar-instance` cannot be granted; flag off, the message is presented ungranted with `attribution_status: unverifiable` and cannot be answered |

Presentation-path semantics are the §3.2 invariant: a grant-insert failure
aborts before the message is presented; a transport failure after commit
leaves the grant standing and the row pending.
## 14. `agent-call` and `fleet` local-lane changes

- One-way sends from an unregistered sender stay (`fleet local send` from a
  shell outside tmux is `from=local-cli`); inside a pane the sender is
  registered first (§8.1), so `from=` is a real address and the CLI passes
  it explicitly (`agent-call send --from <name>`), never relying on
  `AGENT_CALL_NAME` alone.
- The local frame's return address is `<name>@<generation>` and
  `agent-call send` compares the generation with the registry before
  pasting (`return_target_gone` otherwise), so a delayed local reply cannot
  land in a session that reused the name.
- **One lane per pair (ADR R4).** `fleet local send` refuses, at preflight,
  a send from a Claude pane (registered harness `claude`) to a registration
  whose harness is `claude` (`use_relay_lane`): Claude ↔ Claude goes over the
  relay with `--instance`, so it gets routes, grants and the reply verb. A
  non-bridge harness (codex, opencode, agy) may use the local lane or the
  relay with its courier identity; either way its return path is the
  courier.
- A frame prints a copyable reply line **only when the sender owns the
  registration it names**: `agent-call send` checks, sender-side, that the
  effective sender identity — `--from <name>` as returned by `attach
  --if-absent`, falling back to `AGENT_CALL_NAME` — is a live registration
  with the current generation and that its own pid ancestry contains that
  registration's pid. Otherwise the frame prints "reply route
  unavailable" (`reply=none` form, already supported) — for every receiver
  kind. A hint that could resolve to someone else's pane is worse than none.

## 15. File-by-file change list

| File | Change |
|---|---|
| `packages/relay/src/db/schema.sql` | `reply_route`, `reply_grant`; migration + backfill (§5.3) |
| `packages/relay/src/routes/messages.ts` | snapshot-then-transaction write order (§3.2); `x-hangar-return-selector` parse; refusals behind `HANGAR_RELAY_ADDRESS_RULES`; `thread_root` validation (§7); rewrite the "never positive routing" comment |
| `packages/relay/src/routes/replies.ts` (new) | `POST /v1/replies` (§5) |
| `packages/relay/src/routes/inbox.ts` (new) | `GET /v1/inbox` mailbox drain (§8.2) |
| `packages/relay/src/routes/grants.ts` (new) | `POST /v1/grants/finalize` (§8.1) |
| `packages/relay/src/db/schema.sql` (cont.) | `reply_limiter`, `reply_idem` (§3.1) |
| `packages/relay/src/routes/stream.ts` | reject `~cli` instances; grant on drain/replay (§4). Does **not** touch the existing supersession path §8.1 relies on |
| `packages/relay/src/messages/store.ts` | drain self-exclusion predicate (§4); route/grant helpers |
| `packages/relay/src/fanout.ts` | expose the matched snapshot before write |
| `packages/relay/src/reply-limiter.ts` (new) | §9, over `reply_limiter` |
| `docs/evidence/address-rules-gate.json` (new) | the evidence manifest §16 reads |
| `packages/shared/src/envelope.ts` | `all_sessions`, `thread_root` on outbound; reserved-address refines |
| `packages/shared/src/channel.ts` | `Reply: fleet reply <msg_id>` line in chat frames |
| `packages/peer-agent/src/tools.ts` | `reply_to_peer`; `send_to_peer` refuses `in_reply_to`, accepts `thread_root` / `all_sessions`; two-part audience report |
| `packages/peer-agent/src/instructions.ts` | replace "passing to = the sender's handle and optionally in_reply_to" with the reply verb |
| `packages/peer-agent/src/switchboard.ts` | persisted courier instance; `return_target_gone`; no fallback to all panes |
| `packages/peer-agent/src/cli/send.ts` | instance + return-selector headers |
| `dotfiles/bin/fleet` | `fleet reply`, `--all-sessions`, instance header (courier / `~cli`), `fleet inbox` on `/v1/inbox`; **lazy attach before send inside a pane** (§8.1) with the one-line notice; mailbox notice outside a pane (§8.2) |
| `dotfiles/zsh/crew.zsh` | Claude: `agent-call attach --tmux-pane` when no `agent-call-local` channel; detach on exit (§8.4) |
| `@cookys/agent-call` `src/registry.js`, `src/cli.js` | `attach --if-absent`, generation ULID, `SUPPORTED_HARNESSES`, pid-ancestry + pane-command preconditions (§8.1), `send --from` |
| hangar `bin/fleet-pulse.sh` (`--health`) | three new per-principal columns read over the existing ssh probe: `fleet_cli` (dotfiles `git rev-parse` of `bin/fleet`), `agent_call` (`agent-call --version`), `courier` (build artifact, already collected); pass predicate in §16 |
| `@cookys/agent-call` `src/cli.js`, `src/message.js` | §14 |
| `~/.claude/CLAUDE.md` § Fleet messaging | two rows: reply verb; `--instance` for same host, `--to <own handle>` needs `--all-sessions` |

## 16. Rollout (mixed-version fleet)

The refusals change the meaning of a documented form (today's instruction
text says "passing `to` = the sender's handle and optionally `in_reply_to`"),
and the CLI must stamp instances before `parent_unaddressable` would black-hole
every operator and courier reply. So:

1. **Relay** — route table with backfill, `/v1/replies`, `/v1/inbox`, limiter
   (additive). Refusals §6.1–6.3, `use_reply_verb` and
   `sender_instance_required` all sit behind `HANGAR_RELAY_ADDRESS_RULES=off|on`,
   default **off**; flag off, `/v1/messages` behaves exactly as today while
   `/v1/replies` already works, so an upgraded client can start using the
   verb before any old client is refused anything.
2. **Peer-agent, CLI, agent-call** — reply verb, instance stamping, new
   instruction and frame text, preflight checks, audience report. Deploy via
   the hangar deployment skill; restart sessions. **Gate for step 3** is
   version evidence for every sender class: `peer_procs_stale` at zero
   (peer-agents), dotfiles clone at or past the CLI commit on every enrolled
   host, courier artifacts at the candidate, `agent-call` at the shipped
   version on **every enrolled host that can send from a pane** (not only
   those with a registry today — lazy attach is for hosts that have none) —
   each read by `bin/fleet-pulse.sh --health` as a column over the existing
   ssh probe (enrolled hosts = the principal roster in hangar
   `fleet/_inventory/`, `can-dispatch: true`); the pass predicate is
   **every** roster row at or past the pinned values for all three columns
   and `peer_procs_stale = 0`, **and** a complete evidence manifest
   (`docs/evidence/address-rules-gate.json` in hangar-bridge: for each of
   the ADR's three reply shapes — `cli_directed`, `courier_pane`,
   `mailbox` — the parent and reply message ids, the audience report
   observed, the host, and the date; `courier_pane` is recorded twice, once
   from a `crew`-registered pane and once from a hand-launched pane that
   lazily attached on its first send, the latter being a subcase of that
   shape, not a fourth). The pulse prints one line `ADDRESS_RULES_GATE:
   PASS|FAIL <failing rows or missing manifest entries>`; pinned versions
   come from the same manifest's `pins:` block — `{ relay, peer_agent,
   courier_artifact, fleet_cli_commit, agent_call_version }`, written by the
   operator who approves the flip when the evidence entries are complete —
   and the pulse fails closed on any roster row below a pin or any missing
   entry, so the flip is a check against named evidence, not judgement.
   Comparators: `relay` = `/health.build_revision` equals the pin;
   `peer_agent` = artifact SHA-256 on every principal equals the pin;
   `courier_artifact` = same, for the courier hosts; `fleet_cli_commit` =
   the pinned commit is an ancestor of the host's dotfiles HEAD
   (`git merge-base --is-ancestor`); `agent_call_version` = semver ≥ pin.
   "At or past" means those five comparisons, nothing looser.
   Residual risk in this window, accepted: bare-handle `task_dispatch` still
   fans out until the flag flips.
3. **Relay** — `HANGAR_RELAY_ADDRESS_RULES=on`. Every refusal carries the
   `fleet reply <msg_id>` / `--instance` / `--all-sessions` hint.

Until step 3 the fleet remains exposed to the 2026-09-03 failure.

## 17. Out of scope + accepted residual risks

- Same-bearer siblings can misdirect each other's replies (§10). Existing
  trust model; not accepted silently.
- Reply to a restarted sender is a visible miss, not retried.
- Limiter is per handle: siblings on a busy host share one budget per thread.
- Ephemeral routes expire after 7 d.
- Legacy routes are weaker for 7 d after migration (§5.3).
- Courier delivery is unconfirmed (§8.1).
- All panes on a host share the courier's instance, so the grant
  `(msg_id, handle, courier)` lets any pane on that host answer a parent
  pasted into a different pane. Collapses to same-bearer trust (§10); the
  return selector's generation bounds *where* a reply lands, not *who* may
  send one. Tightening needs per-pane credentials — deferred with the
  per-instance-credentials ADR.
- Until step 3, `send_to_peer({in_reply_to})` still works (the ADR's R2
  refusal is permanent in intent but flag-gated in rollout, like the other
  refusals); the old shape is exactly what un-upgraded peers follow, and
  refusing it earlier would break them before they can learn the verb.
- Legacy rows without a stamped `sender_instance` (CLI-sent, pre-attribution)
  are `parent_unaddressable` forever, incident row included (§5.3).
- A restarted session does not inherit its predecessor's grants (§4).
- A lost reply after commit-before-fanout is reported on retry, not
  resent (§5.1).
- A one-way send from a pane leaves a registration behind.
- **Loop closed at the cap (round 5, 3× FIX-THEN-SHIP).** Every Critical was
  folded; the remaining Majors were folded as text where verified. Not
  adopted, with reason: refusing `to = <own handle>` even with
  `all_sessions` (MiniMax) — the explicit acknowledgement *is* the control
  and the ADR keeps the operator-notice use; per-instance limiter keys
  (MiniMax, twice) — instance is self-declared. Implementation-granularity
  findings will keep appearing; the intended next step is implementation
  under TDD per §15 with **per-PR** panel review, where smaller diffs
  converge. Accepted: while
  the process lives the sender *should* be reachable, and cleanup collects it
  on death. The alternative — a mailbox nobody reads — was rejected as a
  black hole with a name (§8.0).
- Protocol kinds still fan out per handle today (§6.4); routing them through
  the route table is a follow-up.
- `reply_all` deferred with a stated re-open criterion.
