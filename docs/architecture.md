# hangar-bridge — Architecture & Protocol

> In-repo source of truth for *what the system is*, *what is inherited from upstream
> `claude-mesh` vs. new in this fork*, and *how the "mesh" and its wire protocol
> actually work*. Companion to the design specs: [`SUBJECT_ROUTING_SPEC.md`](../SUBJECT_ROUTING_SPEC.md)
> (fail-closed subject ACL) and [`docs/PROJECT_ISOLATION.md`](./PROJECT_ISOLATION.md)
> (same-box cross-project isolation). Last verified against code: 2026-06-27.

---

## 1. What it is

A self-hosted **coordination control-plane for a single-operator Claude Code fleet**.
Claude Code instances on different hosts message each other, broadcast, thread, relay
tool-permission approvals, and — the fork's headline addition — **dispatch tasks and
collect structured results** across machines. Inbound peer messages are injected into a
Claude's context as `<channel source="hangar-bridge" …>` tags; outbound goes through MCP
tools (`send_to_peer`, `dispatch_task`, `list_peers`, `set_summary`, `respond_to_permission`).

### 1.1 Topology — a *logical mesh* over a *physical star*

Despite the upstream name "claude-mesh", the wiring is **hub-and-spoke, not peer-to-peer**:

- **Logical**: any peer can address any other peer by handle → mesh-like any-to-any semantics.
- **Physical**: every message transits **one central `relay`**. There are **no direct
  peer-to-peer links, no gossip, no DHT, no discovery protocol**. Peer-agents never talk
  to each other — only to the relay.

```
        logical view (what users see)          physical view (what actually happens)
            A ───── B                                A     B     C
            │ ╲   ╱ │                                 ╲    │    ╱
            │  ╲ ╱  │                                  ╲   │   ╱
            C ──╳── D            ⇒                      ╲  │  ╱
            │  ╱ ╲  │                                   ┌─────┐
            │ ╱   ╲ │                                   │relay│  ← single hub, single
            E ───── F                                   └─────┘     trust anchor (v1)
```

⇒ The relay is the **single point of trust and failure** (see §6). The "mesh" is a routing
abstraction the relay provides, not a network topology.

---

## 2. Provenance — inherited vs. new

Fork base: `pouriamrt/claude-mesh` @ `a75d37a` (MIT). Authorship to date: Pouria 59 commits,
cookys 30. **The relay / peer-agent / shared skeleton and most security primitives are
upstream's, preserved unchanged.** hangar-bridge's identity = *strip the multi-tenant
pair-code/admin SaaS flow → single-tenant shared-secret (`peers-file`) + project isolation;
then layer subject-routing ACL + task dispatch on top.*

| Class | Count (src) | Representative modules |
|-------|-------------|------------------------|
| `[=]` **inherited, unchanged** | ~16 | `gate`, `reply-limiter`, `approval-routing`, `permission`, `roots`, `hash`, `rate-limit`, `access-log`, `presence/registry`, `metrics`, `deps`, **`ulid`**, `env-loader` |
| `[~]` **inherited, modified** | ~13 | `envelope` (+task_*/superRefine), `channel` (+source rename/`gated_subject`), `stream` (+subscribe gate), `messages` (+publish gate), `db`, `middleware`, `fanout`, `inbound`, `tools`, `cli`, `init` |
| `[+]` **fork-new** | ~9 | **`subject`**, **`correlation`**, **`peers-file`**, `cli/init-project`, `cli/init`, `cli/args`, `paths`, `routes/health`, entire **`operations/`** |
| `[x]` **deleted from upstream** | 8 | relay `routes/admin` (−168), `routes/auth` (−88), `auth/pair-code` (−39); peer-agent `cli/admin` (−139), `cli/pair` (−52) + tests |

> The security primitives most often praised (channel-tag escaping base, `reply-limiter`,
> `gate`, `approval-routing`, monotonic `ulid`, `rate-limit`) are **upstream's, `[=]`
> unchanged**. The fork's security work lives in the `[~]`/`[+]` layer: the bidirectional
> subject-ACL, reserved-meta stripping (B1), and keeping the `from` server-stamp intact.

---

## 3. System / module architecture

```
                 ┌──────────────────────────────────────────────────────┐
                 │  @hangar-bridge/shared      (wire-format single SoT)   │
   both depend ▶ │  envelope [~]  channel [~]  subject [+]  constants [~] │
                 │  ulid [=]      env-loader [=]                          │
                 └──────────────────────────────────────────────────────┘
   ┌──────────────────────────────────────────┐   ┌──────────────────────────────────────────┐
   │  @hangar-bridge/relay   Hono+SQLite+SSE   │   │  @hangar-bridge/peer-agent   MCP stdio    │
   │                                            │   │                                            │
   │  routes/                                   │   │  mcp-server [=]  tools [~](+dispatch_task) │
   │   messages [~] ← publish chokepoint (ACL)  │   │  instructions [~]  inbound [~]             │
   │   stream   [~] ← subscribe chokepoint(ACL) │   │  outbound [=]  stream [=] (SSE client)     │
   │   presence [=]  peers [~]  permission [=]  │   │                                            │
   │   metrics  [=]  health [+]                 │   │  gate [=]  reply-limiter [=]              │
   │  auth/                                      │   │  approval-routing [=]  permission [=]      │
   │   middleware [~]  hash [=]  peers-file [+] │   │  correlation [+] ← task_dispatch↔result    │
   │   〔admin / auth / pair-code  [x] removed〕 │  │  paths [+]                                 │
   │  db [~]  fanout [~]  registry [=]          │   │  cli/ init-project [+]  init [+]  args [+] │
   │  rate-limit [=]  access-log [=]            │   │       token-file [=]                       │
   │  cli/ init [~]                             │   │       〔admin / pair  [x] removed〕       │
   └──────────────────────────────────────────┘   └──────────────────────────────────────────┘
   ┌──────────────────────────────┐   ┌───────────────────────────────────────────┐
   │ @hangar-bridge/operations [+]│   │ @hangar-bridge/e2e [~]  loopback harness   │
   │  systemd units + claude-config│  │  dm / broadcast / thread / permission      │
   └──────────────────────────────┘   └───────────────────────────────────────────┘

   legend: [=] inherited as-is   [~] inherited+modified   [+] fork-new   [x] removed from upstream
```

---

## 4. Connection / deployment topology

```
   Host A  (e.g. cookys-gentoo)         Host B  (e.g. openclaw)          Host N …
 ┌──────────────────────────┐        ┌──────────────────────────┐
 │ Claude Code              │        │ Claude Code              │
 │     ▲  stdio (MCP)       │        │     ▲  stdio             │     one peer-agent per host,
 │     ▼                    │        │     ▼                    │     spawned locally by Claude
 │ peer-agent (MCP server)  │        │ peer-agent               │     Code — NOT containerizable
 │  • inbound → <channel>   │        │                          │     (it's a stdio server)
 │  • tools: send_to_peer / │        │                          │
 │    dispatch_task / …     │        │  secret …                │     secret @ ~/.config/
 │  • secret + correlation  │        │                          │       hangar-bridge/secret
 └───────────┬──────────────┘        └───────────┬──────────────┘
             │   HTTP/SSE  (examples ship plain http; use mTLS / Tailscale — §6)
             │   Authorization: Bearer <43-char secret>
             │   POST /v1/messages  (Idempotency-Key, 120/min/token)
             │   GET  /v1/stream    (SSE; ?since=<ulid> resume; x-hangar-subjects narrow)
             │   POST /v1/presence  ·  GET /v1/peers  ·  POST /v1/permission
             └────────────────────────┬───────────────────────────┘
                                      ▼
                  ┌──────────────────────────────────────────┐
                  │            relay   (single central box)    │
                  │  Hono HTTP + SSE                           │
                  │   1. bearerAuth: SHA256(secret) → handle   │  ← `from` stamped here
                  │   2. peers.json roster (membership SoT)    │     (anti-spoof anchor)
                  │   3. subject-ACL: publish & subscribe      │     fail-closed namespace
                  │      bidirectional chokepoint + B1 strip   │     ownership
                  │   4. in-memory Fanout (team→handle→subs)   │     delivers to online only
                  │   5. SQLite/WAL: durable buffer, idempo-   │  ← fleet-coordination SoT
                  │      tency, delivered-tracking, audit_log  │     (retention 7d; no backup yet)
                  └──────────────────────────────────────────┘
```

---

## 5. The protocol (verified against code)

### 5.1 Membership — static, file-based (no discovery)

The "mesh roster" is **declared out-of-band**, not discovered. The operator distributes each
peer's secret manually and writes `peers.json` on the relay:

```jsonc
// ~/.config/hangar-bridge/peers.json  (mode 0600)  — auth/peers-file.ts
{
  "gentoo":  { "secret_sha256_hex": "<64 hex>", "display_name": "…",
               "subjects": { "owned": ["mple2"], "interest": ["mple2.status>"] } },
  "openclaw":{ "secret_sha256_hex": "<64 hex>", "subjects": { "owned": [], "interest": [] } }
}
```

At **relay startup**, `seedPeers()` upserts `human` + `token` rows (idempotent; rotating a
secret revokes the old token and inserts the new hash). There is **no dynamic registration**:
adding/removing a peer or changing its `owned` namespaces means editing `peers.json` + a relay
restart (the documented re-seed path, which also drops all live SSE streams so ACL changes take
effect cleanly). Every peer is seeded at `tier='admin'` — single-tenant has no tier hierarchy.

### 5.2 Identity & auth (layered; L1/L2 are the load-bearing pair)

- **L1 — Bearer gate** (`auth/middleware.ts`): the bearer is each peer's own 43-char URL-safe
  secret. The relay stores only `SHA256(secret)`; lookup is by indexed hash + **timing-safe
  compare** + `revoked_at`/`disabled_at` checks. No secret ever lives in the DB in plaintext.
- **L2 — sender-stamp anti-spoof**: `from` is set **server-side** from the authenticated handle
  (`c.set('peer', …)`). A client-supplied `from` is ignored entirely. This is the primary
  impersonation defense — and the reason a compromised *relay* (which does the stamping) is the
  residual trust anchor (§6).

### 5.3 The envelope — the one protocol unit (`shared/envelope.ts`)

Every HTTP body and SSE payload is an `Envelope`. Six `kind`s:
`chat · presence_update · permission_request · permission_verdict · task_dispatch · task_result`.
Fields: `id` (`msg_<ULID>`), `v` (PROTOCOL_VERSION), `team` (always `'hangar'`), `from` (stamped),
`to` (handle | `@team`), `subject` (dotted | null), `in_reply_to`, `thread_root`, `kind`,
`content` (≤ MAX_CONTENT_BYTES), `meta` (string→string record), `sent_at`, `delivered_at`.

Cross-field invariants enforced by `superRefine` (compile-shared by relay + peer-agent):
1. `permission_verdict` **and** `task_result` REQUIRE `in_reply_to` (→ the request/dispatch).
2. **Direct-only**: `subject != null` ⇒ `to` must be a concrete handle, never `@team`
   (keeps the single `delivered_at` flag correct — a subjected message has exactly one recipient).
3. **Ack channel is null-subject**: `subject != null` ⇒ `in_reply_to` must be null
   (replies/acks ride the null-subject channel; this makes the publish-gate null short-circuit
   the thing that protects acks).

### 5.4 Subject routing — the fork's centerpiece (fail-closed ACL)

A `subject` is a dotted key (`namespace.verb.detail`); the **namespace** is the first token
(`subject.ts`). Two operations, single-sourced so relay and peer-agent never diverge:

- **Ownership gate (fail-closed, authority)**: exact namespace equality against the peer's
  `owned` set. **No wildcards.** An unowned namespace is owned by nobody ⇒ rejected for everyone.
- **Interest filter (narrowing only)**: exact match OR a **trailing `>`** prefix
  (`mple2.status>` matches `mple2.status` and `mple2.status.*`). `>` is the only wildcard, trailing only.
  Interest never *grants* — it only narrows within owned namespaces.

**Publish chokepoint** (`routes/messages.ts`), when `subject != null`:
1. `kind` must be `chat` or `task_dispatch` (a subjected reactive/system kind ⇒ 400 — else a
   non-owner could smuggle a gated subject via e.g. a subjected `presence_update`).
2. **Sender** must own the namespace (`403 forbidden_subject`).
3. **Recipient** must also own it (`409 recipient_not_owner`). Ownership is checked on **both ends**.
4. **B1 confused-deputy fix**: reserved meta keys (`subject`, `kind`) are **stripped** from sender
   `meta` at publish, so a sender can never forge a relay signal into a channel notification. The
   authentic subject reaches the receiver only as the relay-stamped **`gated_subject`** field.

**Subscribe chokepoint** (`routes/stream.ts`): a per-subscriber `deliverable(e)` gate runs on
**both backlog and live** — null-subject passes (back-compat); else the handle must own the
namespace; interest narrows further. Owned-set is read **once per connection** (a relay restart,
which re-seeds ACLs, drops all streams — so no mid-stream ownership change is possible).

All denials are written to `audit_log` (`subject.publish_denied`, `subject.recipient_denied`) —
the authoritative, non-silent denial trail.

### 5.5 Delivery & fanout (`fanout.ts`, `routes/stream.ts`)

- **In-memory `Fanout`**: `team → handle → Set<Subscriber>`. `deliver(e)` routes to the
  `to`-handle's subscribers, or (for `@team`) fans out to every online handle except `from`,
  consulting each subscriber's `accept` gate. **Only online peers receive** — offline peers get
  it from backlog on next connect.
- **`delivered_at` authority**: for **subjected** (single-copy) messages, `delivered_at` is
  stamped **only after a successful SSE write** (the stream loop is the sole authority) — so a
  stream abort between enqueue and write never loses the one copy. For **null-subject** messages
  the publish route optimistically stamps it if the recipient is online.
- **Backlog / resume — dual cursor semantics**:
  - `?since=<ulid>` (reconnect): `id > cursor` **only**, delivery-agnostic — preserves `@team`
    multi-recipient redelivery and widened-interest replay. The client cursor is the dedup authority.
  - cold-start (no `since`): `id > cursor` **AND** `delivered_at IS NULL` (pending-only).
  - Both drain pages advancing the cursor on **every** page (deliverable or not) so a full page of
    non-deliverable rows can't starve deliverable rows behind it. Per-connection dedupe set is
    bounded (`SEEN_CAP = 8192`, FIFO evict). Keepalive `ping` every 25 s.

### 5.6 Task dispatch correlation (`peer-agent/correlation.ts`)

`dispatch_task` and `task_result` are wired by a peer-agent-local, TTL'd `DispatchTracker`:
on outgoing dispatch it records `correlation_id → {dispatch_msg_id, peer_handle}`; an inbound
`task_result` (carrying `in_reply_to`) is matched back to its originating dispatch. Entries GC on
TTL expiry. This is **client-side state** — the relay itself is task-agnostic; it just routes the
two envelopes like any other directed message.

### 5.7 Durable model (`db/schema.sql`, SQLite WAL, schema v5)

`team` (single fixed `'hangar'` row) · `human` (peer roster + `subjects` JSON ACL) · `token`
(hashed secrets, revocable) · `message` (the durable buffer; indexed by `(team,id)`,
`(team,to,id)`, `thread_root`) · `idempotency_key` (`hash(tokenId:key) → cached response`) ·
`audit_log` (ACL denials + events). Retention `retention_days = 7` (purge job). The `team_id`
column + FK are retained as **single-tenant stub scaffolding** (`HANGAR_TEAM_ID='hangar'`) to
keep migration risk vs. upstream at zero.

---

## 6. Trust model & known residuals (honest register)

- **The relay is the v1 trust anchor and single point of failure.** Because it *stamps* `from`
  and *gates* `subject`, a **compromised relay can forge `from`, forge `subject`, or re-inject
  stripped meta** and bypass the entire ACL. There is no end-to-end signing between peer-agents.
  Closing this would require per-peer signing keys so the relay routes envelopes it cannot forge —
  the one structural change that would alter the threat model.
- **Transport**: examples ship plain `http://` (even over Tailscale). Use mTLS / a private overlay.
- **`@team` ambient content** is always null-subject ⇒ never namespace-gated; any roster member can
  broadcast content to all online peers (audited, accepted — see `SUBJECT_ROUTING_SPEC.md` §12).
- **Ack channel** (`subject=null` replies) bypasses the namespace gate by design; mitigated by a
  recipient-identity check, not eliminated.
- **Intra-namespace blast radius**: namespace ownership is all-or-nothing; an owner sees every
  subject under it.
- **Operational gap**: the SQLite is fleet-coordination SoT but has **no backup/restore story** yet.

See `SUBJECT_ROUTING_SPEC.md` §12 for the full accepted-residual-risk register (these are
*documented and accepted*, not unknown bugs).
