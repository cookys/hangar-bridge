# hangar-bridge — Architecture & Protocol

> In-repo source of truth for *what the system is*, *what is inherited from upstream
> `claude-mesh` vs. new in this fork*, and *how the "mesh" and its wire protocol
> actually work*. Companion to the design specs: [`SUBJECT_ROUTING_SPEC.md`](../SUBJECT_ROUTING_SPEC.md)
> (fail-closed subject ACL) and [`docs/PROJECT_ISOLATION.md`](./PROJECT_ISOLATION.md)
> (same-box cross-project isolation), plus [`docs/CLAIMS.md`](./CLAIMS.md) (claim contract).
> Last verified against the combined SSE/NATS code: 2026-07-21.

---

## 1. What it is

A self-hosted **coordination control-plane for a single-operator Claude Code fleet**.
Claude Code instances on different hosts message each other, broadcast, thread, relay
tool-permission approvals, and — the fork's headline addition — **dispatch tasks and
collect structured results** across machines. Inbound peer messages are injected into a
Claude's context as `<channel source="hangar-bridge" …>` tags; outbound goes through MCP
tools (`send_to_peer`, `dispatch_task`, `list_peers`, `set_summary`, `respond_to_permission`).
Relay-backed claim tools (`claim_asset`, `list_claims`, `release_claim`) are also exposed when a
claim coordination client is available.

### 1.1 Topology — a *logical mesh* over one selected physical hub

Despite the upstream name "claude-mesh", the wiring is **hub-and-spoke, not peer-to-peer**:

- **Logical**: any peer can address any other peer by handle → mesh-like any-to-any semantics.
- **Physical**: each peer-agent selects either the default central HTTP/SSE relay or the opt-in
  central NATS server. There are **no direct peer-to-peer links, no gossip, no DHT, and no
  discovery protocol**.

```
       logical view                physical SSE default        physical NATS opt-in
          A ─── B                      A   B   C                     A   B   C
          │ ╲ ╱ │                       ╲  │  ╱                       ╲  │  ╱
          C ─── D                        relay                      NATS/JS/KV
```

The selected hub is a central trust/failure point (see §6). SSE and NATS message cohorts are not
bridged, so P5 must cut over a whole communicating fleet or accept temporary cohort isolation.

---

## 2. Provenance — inherited vs. new

Fork base: `pouriamrt/claude-mesh` @ `a75d37a` (MIT). **The relay / peer-agent / shared skeleton and most security primitives are
upstream's, preserved unchanged.** hangar-bridge's identity = *strip the multi-tenant
pair-code/admin SaaS flow → single-tenant shared-secret (`peers-file`) + project isolation;
then layer subject-routing ACL, task dispatch, cooperative claims, and an opt-in NATS transport on top.*

| Class | Representative modules |
|-------|------------------------|
| `[=]` **inherited, unchanged** | `gate`, `reply-limiter`, `approval-routing`, `permission`, `roots`, `hash`, `rate-limit`, `access-log`, `ulid`, `env-loader` |
| `[~]` **inherited, modified** | `envelope`, `channel`, `stream`, `messages`, `db`, `middleware`, `fanout`, `inbound`, `tools`, `cli`, `init` |
| `[+]` **fork-new** | `subject`, `correlation`, `peers-file`, claims, `nats-transport`, `subject-acl`, `task-dedup`, `presence-tracker`, `cli/init-project`, `operations/` |
| `[x]` **deleted from upstream** | relay `routes/admin`, `routes/auth`, `auth/pair-code`; peer-agent `cli/admin`, `cli/pair`, and their tests |

> The security primitives most often praised (channel-tag escaping base, `reply-limiter`,
> `gate`, `approval-routing`, monotonic `ulid`, `rate-limit`) are **upstream's, `[=]`
> unchanged**. The fork's security work lives in the `[~]`/`[+]` layer: the bidirectional
> subject-ACL, reserved-meta stripping (B1), and keeping the `from` server-stamp intact.

---

## 3. System / module architecture

| Package | Current responsibility |
|---|---|
| `@hangar-bridge/shared` | One envelope schema, channel serialization/escaping, monotonic message IDs, subject matchers, claim bounds, and shared constants. Both transports depend on it. |
| `@hangar-bridge/relay` | Default Hono HTTP/SSE messaging hub, bearer identity, bidirectional subject ACL, SQLite/WAL schema v6, TTL presence, claim API, durable buffer, fanout, and audit. |
| `@hangar-bridge/peer-agent` | MCP stdio server, SSE and NATS transport implementations, tool registration, inbound sender gate, app-side NATS ACL, correlation, permissions, task dedup, and lifecycle cleanup. |
| `@hangar-bridge/e2e` | Cross-package loopback tests, configuration checks, and live local-NATS integration oracles. |
| `@hangar-bridge/operations` | Relay/NATS systemd units, NATS config and provisioning, fleet roster, NKeys workflow, and Claude Code registration artifacts. |

The upstream pair/admin routes and CLIs are not part of this fork. Membership is operator-managed
through `peers.json` (SSE) or `fleet-roster.json` plus NKey users (NATS).

---

## 4. Connection / deployment topology

Every Claude Code session spawns its peer-agent locally over stdio; the peer-agent is not a daemon.
Its `transport` config defaults to `sse`. SSE can retain the legacy multi-session behavior. The
current NATS durable address is handle-scoped, so NATS mode enforces one live local process per
handle with a host-global file lock; a second same-handle session fails closed. Session-addressed
NATS routing is deferred.

### 4.1 SSE/default path

The peer-agent uses a 43-character secret as a bearer token for `POST /v1/messages`,
`GET /v1/stream`, presence/peer/permission routes, and the claim API. The relay maps the hash to a
roster handle, stamps identity, persists messages in SQLite, and sends live/backlog events over SSE.

### 4.2 NATS/opt-in path (P0–P4 implemented)

The peer-agent authenticates with a per-handle NKey. NATS publish permissions constrain each peer to
its `fleet.<handle>.>` lane. `NatsTransport` validates that lane, derives the authoritative sender,
applies `fleet-roster.json` ownership/interest ACLs, routes ephemeral chat over core NATS, durable
tasks through `HANGAR_TASKS`, permanent dedup through `HANGAR_DEDUP`, and presence by heartbeat.

P5 is reversible: keep the relay runnable, flip config per host, and soak. A NATS-configured peer may
still create a relay `ClaimClient` from `relay_url` + `token_path`; it is exposed only after a bounded
authenticated claims-list probe. Failure disables only claim tools, not NATS messaging startup. P6
cannot delete the relay until claims are ported or deliberately retired.

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

On NATS, `packages/operations/nats/fleet-roster.json` is the membership + namespace authority and
must exactly match the fleet NKey users in `nats-server.conf`; privileged `$SYS` and provisioning
users are excluded. Changes take effect when the peer-agent restarts/reloads its startup roster.

### 5.2 Identity & auth (transport-specific, same anti-spoof invariant)

- **L1 — Bearer gate** (`auth/middleware.ts`): the bearer is each peer's own 43-char URL-safe
  secret. The relay stores only `SHA256(secret)`; lookup is by indexed hash + **timing-safe
  compare** + `revoked_at`/`disabled_at` checks. No secret ever lives in the DB in plaintext.
- **L2 — sender-stamp anti-spoof**: `from` is set **server-side** from the authenticated handle
  (`c.set('peer', …)`). A client-supplied `from` is ignored entirely. This is the primary
  impersonation defense — and the reason a compromised *relay* (which does the stamping) is the
  residual trust anchor (§6).
- **NATS equivalent**: per-user NKey permissions limit publishing to `fleet.<handle>.>`.
  `NatsTransport` parses the authenticated wire subject, ignores/overwrites the payload's claimed
  `from`, and materializes the envelope with the derived sender. Payload identity is never trusted.

### 5.3 The envelope — the one protocol unit (`shared/envelope.ts`)

Every HTTP body and SSE payload is an `Envelope`. Six `kind`s:
`chat · presence_update · permission_request · permission_verdict · task_dispatch · task_result`.
Fields: `id` (`msg_<ULID>`), `v` (PROTOCOL_VERSION), `team` (always `'hangar'`), `from` (stamped),
`to` (handle | `@team`), `subject` (dotted | null), `in_reply_to`, `thread_root`, `kind`,
`content` (≤ MAX_CONTENT_BYTES), `meta` (string→string record), `sent_at`, `delivered_at`.

Cross-field invariants enforced by `superRefine` (compile-shared by relay + peer-agent):
1. `permission_verdict` **and** `task_result` REQUIRE `in_reply_to` (→ the request/dispatch).
2. **Subjected broadcast exception**: `subject != null && to == '@team'` is valid only for `chat`.
   Subjected `task_dispatch` and every other subjected kind remain direct-only.
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

**Publish chokepoint** (`routes/messages.ts` on SSE; `subject-acl.ts` on NATS), when
`subject != null`:
1. `kind` must be `chat` or `task_dispatch` (a subjected reactive/system kind ⇒ 400 — else a
   non-owner could smuggle a gated subject via e.g. a subjected `presence_update`).
2. **Sender** must own the namespace (`403 forbidden_subject`).
3. A concrete **recipient** must also own it (`409 recipient_not_owner` on SSE). For a subjected
   `@team` chat, each receiver is checked independently; there is no synthetic `@team` owner.
4. **B1 confused-deputy fix**: reserved meta keys (`subject`, `kind`) are **stripped** from sender
   `meta` at publish, so a sender can never forge a relay signal into a channel notification. The
   authentic subject reaches the receiver only as the relay-stamped **`gated_subject`** field.

**SSE subscribe chokepoint** (`routes/stream.ts`): a per-subscriber `deliverable(e)` gate runs on
**both backlog and live** — null-subject passes (back-compat); else the handle must own the
namespace; interest narrows further. Owned-set is read **once per connection** (a relay restart,
which re-seeds ACLs, drops all streams — so no mid-stream ownership change is possible).

**NATS receive chokepoint** (`subject-acl.ts`): the sender and concrete recipient ownership checks
run before processing; the local receiver must also own the namespace and match interest. Invalid
durable task messages are terminally acknowledged only after a JSONL denial record is appended to
the configured audit directory; an audit-write failure `nak`s the message for retry. Core denials
are dropped and audited. The roster parser is strict and rejects malformed handles, namespaces,
interests, unknown fields, and the reserved `team` handle.

SSE denials are written to SQLite `audit_log` (`subject.publish_denied`,
`subject.recipient_denied`); NATS denials use the peer-agent audit log. Both paths fail closed and
leave a non-silent denial trail.

### 5.5 Delivery & fanout (`fanout.ts`, `routes/stream.ts`)

- **In-memory `Fanout`**: `team → handle → Set<Subscriber>`. `deliver(e)` routes to the
  `to`-handle's subscribers, or (for `@team`) fans out to every online handle except `from`,
  consulting each subscriber's `accept` gate. **Only online peers receive** — offline peers get
  it from backlog on next connect.
- **`delivered_at` authority (SSE)**: for a subjected direct message, it is stamped only after a
  successful SSE write. For a subjected `@team` chat it is an ambient first-delivery flag; the
  per-recipient authority remains cursor replay. Null-subject messages retain the legacy online
  optimization.
- **Backlog / resume — dual cursor semantics**:
  - `?since=<ulid>` (reconnect): `id > cursor` **only**, delivery-agnostic — preserves `@team`
    multi-recipient redelivery and widened-interest replay. The client cursor is the dedup authority.
  - cold-start (no `since`): `id > cursor` **AND** `delivered_at IS NULL` (pending-only).
  - Both drain pages advancing the cursor on **every** page (deliverable or not) so a full page of
    non-deliverable rows can't starve deliverable rows behind it. The per-connection dedupe map is
    bounded (`SEEN_CAP = 4096`, FIFO evict) and binds each `msg_id` to a stable envelope fingerprint;
    an ID collision with different authenticated/routing/content fields is rejected. Keepalive
    `ping` every 25 s.
- **NATS delivery tiers**: core NATS carries ephemeral chat/presence/permission traffic; JetStream
  WorkQueue carries direct `task_dispatch`/`task_result` with ack/replay semantics. KV CAS records
  permanent task dedup keys across restarts. Core sends wait for a NATS `flush`; task sends wait for
  the JetStream puback and pass their idempotency key as `Nats-Msg-Id`. Receive processing awaits the
  asynchronous MCP notification; only after it succeeds does the peer write the permanent KV
  completion marker and ACK. A callback failure is NAKed with no completion marker. A deterministic
  dispatcher rejection (such as a `task_result` from the wrong correlated peer) is terminal for
  that envelope but does not write the correlation marker, so the legitimate result remains
  eligible; an ACK loss is suppressed on redelivery by the completed marker. The KV client binds to the provisioned
  bucket with direct reads under the shipped least-privilege ACL. Until KV is ready, the durable
  consumer remains closed and retries with backoff. There is no volatile peer-agent outbox.
- **NATS presence reduction**: startup publishes a heartbeat immediately and then every 30 seconds.
  `list_peers` derives only `online` / `last_seen` from the heartbeat TTL. Unlike the SSE/SQLite
  path, NATS currently does not retain summary or session/working-context metadata, so those fields
  are returned empty. Heartbeats are control-plane events and are never injected into Claude context.

### 5.6 Task dispatch correlation (`peer-agent/correlation.ts`)

`dispatch_task` and transport-level `task_result` are wired by a peer-agent-local, TTL'd
`DispatchTracker`:
on outgoing dispatch it records `correlation_id → {dispatch_msg_id, peer_handle}`; an inbound
`task_result` (carrying `in_reply_to`) is matched back to its originating dispatch. Entries GC on
TTL expiry and are atomically persisted in `dispatch-state.json`, so a clean restart reloads live
entries. A result from a handle other than the recorded peer is dropped; legacy `@team`
correlations remain the only multi-sender exception. NATS' single-instance guard prevents two local
same-handle processes from racing this file or consuming one another's result. This is
**client-side state** — the relay itself is task-agnostic. The production MCP surface currently has
no structured `task_result` emitter; Claude receivers return completion via chat until that deferred
tool is implemented.

The SSE resume cursor is durable alongside it, in `cursor-state.json` under the same config dir
(`CursorStore`, P3). It advances strictly monotonically and is written after every advance with an
atomic temp+rename; a corrupt or unreadable file fails open to a cold start rather than crashing
the session. This matters because the relay stamps `delivered_at` at socket-WRITE time
(`stream.ts`): a relay killed mid-drain has already marked rows delivered that the client never
processed, and a cold-starting client — which drains `delivered_at IS NULL` only — would never see
them. With a persisted cursor the client resumes via `?since=`, which filters on the id cursor
alone, and cold start becomes the rare path instead of the default one.

### 5.7 Durable model (`db/schema.sql`, SQLite WAL, schema v6)

`team` (single fixed `'hangar'` row) · `human` (peer roster + `subjects` JSON ACL) · `token`
(hashed secrets, revocable) · `message` (the durable buffer; indexed by `(team,id)`,
`(team,to,id)`, `thread_root`) · `idempotency_key` (`hash(tokenId:key) → cached response`) ·
`audit_log` (ACL denials + events) · `claim` (one advisory owner per `(team_id, claim_key)`, TTL
expiry). Retention `retention_days = 7` (purge job). The `team_id`
column + FK are retained as **single-tenant stub scaffolding** (`HANGAR_TEAM_ID='hangar'`) to
keep migration risk vs. upstream at zero.

### 5.8 Cooperative claims

The relay exposes `POST /v1/claim`, `GET /v1/claims`, canonical
`POST /v1/claim/release`, and compatibility `DELETE /v1/claim`. Claim keys are generic bounded asset
identifiers; there is no server-enforced kind taxonomy. The MCP tools return text, while
`list_claims` embeds a JSON array in its text block. Exact schemas, TTL bounds, outputs, and NATS
compatibility are specified in [`CLAIMS.md`](./CLAIMS.md).

---

## 6. Trust model & known residuals (honest register)

- **The selected transport hub is a trust anchor and single point of failure.** In SSE, because the
  relay *stamps* `from`
  and *gates* `subject`, a **compromised relay can forge `from`, forge `subject`, or re-inject
  stripped meta** and bypass the entire ACL. There is no end-to-end signing between peer-agents.
  Closing this would require per-peer signing keys so the relay routes envelopes it cannot forge —
  the one structural change that would alter the threat model. NATS replaces bearer stamping with
  NKey lane authentication but still trusts the NATS control plane/configuration.
- **Transport**: examples ship plain `http://` (even over Tailscale). Use mTLS / a private overlay.
- **`@team` content** may be null-subject ambient chat (not namespace-gated) or a subject-scoped
  chat (publisher and each receiver gated). `@team` is not an authoritative command channel.
- **Ack channel** (`subject=null` replies) bypasses the namespace gate by design; mitigated by a
  recipient-identity check, not eliminated.
- **Intra-namespace blast radius**: namespace ownership is all-or-nothing; an owner sees every
  subject under it.
- **Operational gap**: the SQLite is fleet-coordination SoT but has **no backup/restore story** yet.
- **Mixed-mode gap**: SSE and NATS message cohorts do not bridge. P5 needs a whole-fleet cutover or
  explicit isolation; seamless mixed mode requires a separate bridge.
- **NATS session-addressing gap**: durable consumers are handle-scoped, so NATS mode currently
  permits one live local MCP session per fleet handle. Multi-session NATS needs a session-aware
  routing/correlation design.
- **Structured result gap**: `task_result` is a supported wire kind and transport receive path, but
  no production MCP tool emits it yet; current task completion replies are chat.
- **Claim migration gap**: claims are relay/SQLite-backed even when messaging uses NATS. P6 relay
  deletion is blocked until claims are ported or deliberately retired.

See `SUBJECT_ROUTING_SPEC.md` §12 for the full accepted-residual-risk register (these are
*documented and accepted*, not unknown bugs).
