<!--
STATUS: v2 — PROPOSED, not implemented. v2 adds the address model (§8.0):
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

# Reply Routing — Implementation Spec (v2)

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
  expires_at       TEXT                -- NULL = follows the message row; set for ephemeral + legacy
)
reply_grant(
  msg_id TEXT NOT NULL REFERENCES reply_route(msg_id),
  handle TEXT NOT NULL,
  instance TEXT NOT NULL,              -- '~cli' for the operator mailbox
  PRIMARY KEY (msg_id, handle, instance)
)
```

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
4. Only then write events to streams.

A route insert failure aborts the send (500, nothing delivered). A fast
recipient can therefore never reply before its route and grant exist.

A grant is **delivery eligibility**, not proof of receipt. SSE cannot prove
consumption and nothing here pretends it can.

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
`AND (meta.sender_instance IS NULL OR meta.sender_instance != <poller instance>)`.

## 5. The reply verb

### 5.1 Surface

| Surface | Shape |
|---|---|
| MCP | `reply_to_peer({ in_reply_to: msg_id, content, meta? })` |
| CLI | `fleet reply <msg_id> "<text>"` |
| relay | `POST /v1/replies` `{ in_reply_to, content, meta? }` |

It accepts **no** `to`, `to_filter`, `fleet_wide`, `all_sessions`, `subject`.
The relay resolves:

```
route    = reply_route[in_reply_to]  (or by correlation_id alias)  else unknown_parent
to       = route.from_handle
to_filter.instance = route.sender_instance
in_reply_to = route.msg_id
thread_root = route.thread_root
kind = chat, subject = null
meta.local_target = route.return_selector   (after deleting any client value)
```

`send_to_peer` / `POST /v1/messages` refuse `in_reply_to` on user-authored
kinds with `use_reply_verb` (protocol kinds keep it, §6.4). Same control shape
as the fleet-wide gate: a different tool, not a different argument.

### 5.2 Audience check

Accepted only if `(replier handle, replier declared instance)` is in
`reply_grant` for the route; otherwise `not_a_recipient`. A `@team` or repo
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
| anything with a `to_filter` | `unreplyable` | nobody (`legacy_unreplyable`) |

A reply to a legacy route is reported with `legacy_parent: true`.

### 5.4 Unaddressable and gone

| Condition | Result |
|---|---|
| `route.sender_instance` NULL, or `from_handle` disabled/removed | `parent_unaddressable` (terminal; route dropped). Never widens to the handle. |
| sender session offline | `matched: 0` + the existing "NO live session matched" report. **Not retried automatically**; the caller re-runs `list_peers` and sends a fresh message if it still matters. |
| sender restarted | new instance id ⇒ `matched: 0` for its own earlier outbound. A visible miss, never re-aimed. |

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

A `~cli` instance and the `@mailbox:<handle>` recipient (§8.2) are
relay-internal. An ordinary send, `to_filter.instance`, or CLI `--instance`
naming either is refused (`reserved_address`); a stream subscription declaring
a `~cli` instance is refused (`reserved_instance`).

## 7. Thread continuation (not a reply)

`send_to_peer` accepts `thread_root`. The relay validates it as the id of a
route the caller **sent or holds a grant on** (else `not_in_thread`) and
canonicalises to that route's effective root. The message then goes through
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
(`$TMUX_PANE` set) first ensure the pane is registered:

1. If `AGENT_CALL_NAME` names a live registration whose pid is this pane's
   pid (or an ancestor of the caller), use it.
2. Otherwise **attach now**: name `<basename of cwd>--<pane current command>`
   (`revival.3d--opencode`), `--tmux-pane $TMUX_PANE`, the same call `crew`
   makes at launch; on a live-name collision take `-2`, `-3` … exactly as
   `crew` does. Print one line to the sender: `fleet: registered this pane
   as <name>; replies will land here`. Export nothing — the name is in the
   registry, which is the source of truth.
3. If attach fails (no `agent-call`, not a tmux pane) fall through to §8.2
   with a warning that names the reason.

With a registration in hand, the identity is the host's switchboard courier
instance, which the courier **persists** across restarts (config file) so
routes do not orphan. The send also carries
`x-hangar-return-selector: <name>`.

Relay chokepoint: parse and syntax-check the header exactly like the instance
header; store it in `route.return_selector`; on the reply verb delete any
client-supplied `meta.local_target` and stamp it from the route. On
`send_to_peer` a sender-supplied `meta.local_target` remains what it is today
— a pane address (`--local`), no more privileged than `to_filter.instance` —
and it never enters a route.

Courier delivery of a reply: resolve `meta.local_target` against the live
`agent-call` registry; unknown or dead target ⇒ `return_target_gone`,
surfaced as a final-mile failure (`FINAL-MILE-FAILED(n)` in the presence
summary, as today). **Never** fall back to "all panes in the project". A
courier whose registry was wiped answers `return_target_gone`; the sender then
issues a new message, not a reply. Courier delivery is **unconfirmed** by
construction: the reply result lists it as `courier#instance (unconfirmed)`.

### 8.2 Outside any pane → operator mailbox (pull-only, humans and scripts)

Applies only when §8.1 could not produce a registration: a shell outside
tmux, a cron job, a script. Identity is the reserved instance `<handle>~cli`,
provisioned lazily on first use. This is deliberately **not** offered to a
harness: nothing would ever read it. The sender is told at send time:
`fleet: no pane to deliver replies into; they will queue in this host's
mailbox (fleet inbox)`. A reply to it is stored durably with recipient `@mailbox:<handle>`,
outside the `to_handle` predicate, and drained only by the authenticated
`GET /v1/inbox?since=<cursor>` of that handle (`fleet inbox`). It is **never
pushed** to any session and lives as long as any durable row. Its single grant
is `(msg_id, handle, '~cli')`, so any shell under that bearer may reply. A
mailbox is not a widening: it interrupts nobody.

### 8.3 Frames

Relay channel frames and courier pane deliveries print
`Reply: fleet reply <msg_id> "…"`. The line names a message id, never a handle
or a harness name.

### 8.4 Registration lifecycle (crew + cleanup)

- `crew` attaches every harness it launches, **Claude included**: today
  Claude gets only `AGENT_CALL_NAME` and relies on an `agent-call-local`
  channel that exists only in projects with a `.mcp.json`, so most `crew`
  Claude sessions have a name and no registration (cuda 2026-09-03: three
  of four). When that channel is absent, `crew` runs the same
  `agent-call attach --tmux-pane` it runs for codex. Tmux ingress into a
  Claude pane is already how `revival.3d--claude` is reached.
- `crew` detaches on normal exit (trap on the harness process ending) so a
  clean shutdown does not wait for cleanup.
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
per-route limit would never trip on a ping-pong. Default 10 replies per 10
minutes (§12), refused with `reply_storm`. The peer-agent's per-process
limiter stays as preflight. Retries of one reply reuse the existing
idempotency-key header.

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
  durable: "none" | "<handle>" | "repo:<name>" | "<handle>~cli",
  matched: N, legacy_parent?: true }
```

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

| Code | Where | Meaning / hint |
|---|---|---|
| `use_reply_verb` | `/v1/messages`, `send_to_peer` | `in_reply_to` on a user-authored kind; "use `fleet reply <msg_id>`; to continue the thread for a different audience send a new message with `thread_root`" |
| `unknown_parent` | `/v1/replies` | no route (never existed, expired, zero-match dispatch) |
| `not_a_recipient` | `/v1/replies` | replier not in the route's grants |
| `legacy_unreplyable` | `/v1/replies` | backfilled row that carried a `to_filter` |
| `parent_unaddressable` | `/v1/replies` | route has no `sender_instance`, or `from_handle` disabled/removed |
| `reply_storm` | `/v1/replies` | §9 |
| `sender_instance_required` | `/v1/messages` (flag on) | no `x-hangar-instance` on a user-authored kind |
| `handle_needs_all_sessions` | `/v1/messages` (flag on) | bare handle without `all_sessions`; lists live instances |
| `dispatch_needs_instance` | `/v1/messages` (flag on) | bare-handle `task_dispatch` |
| `not_in_thread` | `/v1/messages` | `thread_root` names a route the caller neither sent nor was granted |
| `reserved_address` / `reserved_instance` | `/v1/messages`, `/v1/stream` | §6.5 |
| `return_target_gone` | courier final mile | §8.1 |

## 14. `agent-call` and `fleet` local-lane changes

- One-way sends from an unregistered sender stay (`fleet local send` from a
  shell outside tmux is `from=local-cli`); inside a pane the sender is
  registered first (§8.1), so `from=` is a real address.
- A frame prints a copyable reply line **only when the sender owns the
  registration it names**: `agent-call send` checks, sender-side, that
  `AGENT_CALL_NAME` is a live registration and that its own pid ancestry
  contains that registration's pid. Otherwise the frame prints "reply route
  unavailable" (`reply=none` form, already supported) — for every receiver
  kind. A hint that could resolve to someone else's pane is worse than none.

## 15. File-by-file change list

| File | Change |
|---|---|
| `packages/relay/src/db/schema.sql` | `reply_route`, `reply_grant`; migration + backfill (§5.3) |
| `packages/relay/src/routes/messages.ts` | snapshot-then-transaction write order (§3.2); `x-hangar-return-selector` parse; refusals behind `HANGAR_RELAY_ADDRESS_RULES`; `thread_root` validation (§7); rewrite the "never positive routing" comment |
| `packages/relay/src/routes/replies.ts` (new) | `POST /v1/replies` (§5) |
| `packages/relay/src/routes/inbox.ts` (new) | `GET /v1/inbox` mailbox drain (§8.2) |
| `packages/relay/src/routes/stream.ts` | reject `~cli` instances; grant on drain/replay (§4) |
| `packages/relay/src/messages/store.ts` | drain self-exclusion predicate (§4); route/grant helpers |
| `packages/relay/src/fanout.ts` | expose the matched snapshot before write |
| `packages/relay/src/reply-limiter.ts` (new) | §9 |
| `packages/shared/src/envelope.ts` | `all_sessions`, `thread_root` on outbound; reserved-address refines |
| `packages/shared/src/channel.ts` | `Reply: fleet reply <msg_id>` line in chat frames |
| `packages/peer-agent/src/tools.ts` | `reply_to_peer`; `send_to_peer` refuses `in_reply_to`, accepts `thread_root` / `all_sessions`; two-part audience report |
| `packages/peer-agent/src/instructions.ts` | replace "passing to = the sender's handle and optionally in_reply_to" with the reply verb |
| `packages/peer-agent/src/switchboard.ts` | persisted courier instance; `return_target_gone`; no fallback to all panes |
| `packages/peer-agent/src/cli/send.ts` | instance + return-selector headers |
| `dotfiles/bin/fleet` | `fleet reply`, `--all-sessions`, instance header (courier / `~cli`), `fleet inbox` on `/v1/inbox`; **lazy attach before send inside a pane** (§8.1) with the one-line notice; mailbox notice outside a pane (§8.2) |
| `dotfiles/zsh/crew.zsh` | Claude: `agent-call attach --tmux-pane` when no `agent-call-local` channel; detach on exit (§8.4) |
| `@cookys/agent-call` `src/cli.js`, `src/message.js` | §14 |
| `~/.claude/CLAUDE.md` § Fleet messaging | two rows: reply verb; `--instance` for same host, `--to <own handle>` needs `--all-sessions` |

## 16. Rollout (mixed-version fleet)

The refusals change the meaning of a documented form (today's instruction
text says "passing `to` = the sender's handle and optionally `in_reply_to`"),
and the CLI must stamp instances before `parent_unaddressable` would black-hole
every operator and courier reply. So:

1. **Relay** — route table with backfill, `/v1/replies`, `/v1/inbox`, limiter
   (additive). Refusals §6.1–6.3 and `sender_instance_required` behind
   `HANGAR_RELAY_ADDRESS_RULES=off|on`, default **off**.
2. **Peer-agent, CLI, agent-call** — reply verb, instance stamping, new
   instruction and frame text, preflight checks, audience report. Deploy via
   the hangar deployment skill; restart sessions. **Gate for step 3** is
   version evidence for every sender class: `peer_procs_stale` at zero
   (peer-agents), dotfiles clone at or past the CLI commit on every enrolled
   host, courier artifacts at the candidate, `agent-call` at the shipped
   version on every host with a registry — plus a recorded end-to-end run of
   the three reply shapes (CLI reply to directed chat; courier-pane reply to a
   relayed parent; mailbox reply) with their observed audience reports.
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
- A one-way send from a pane leaves a registration behind. Accepted: while
  the process lives the sender *should* be reachable, and cleanup collects it
  on death. The alternative — a mailbox nobody reads — was rejected as a
  black hole with a name (§8.0).
- Protocol kinds still fan out per handle today (§6.4); routing them through
  the route table is a follow-up.
- `reply_all` deferred with a stated re-open criterion.
