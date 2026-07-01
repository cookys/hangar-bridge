# Fleet Coordination Redesign — Stage 3 (hangar-bridge source changes)

Status: APPROVED-WITH-CONDITIONS (decorrelated spec_review passed — see Review Ledger)
Branch: `feat/fleet-coord-stage3` (from `origin/main` @ bc8fcf3)
Owner: L5 foreman (autopilot), depth 1
Related: `SUBJECT_ROUTING_SPEC.md` (this is an addendum to §3.3 / §6 / §12.1),
`docs/plans/2026-06-25-cross-project-isolation.md` (stage-2 P2, already merged).

## Goal

Redesign the fleet coordination mechanism to fix four inventoried pain points:

- **P1 broadcast 無差別** — `@team` reaches every connected session regardless of relevance.
- **P2 同機跨專案都接** — handled by stage-2 (per-project handle + `.mcp.json`, MERGED). Out of scope here.
- **P3 peer 常 offline/不可見** — presence is a pure in-memory Map with no TTL/heartbeat and is
  only ever written by the `set_summary` tool, so `list_peers.online` is almost always empty and
  never expires. Decoupled from the SSE connection that is the real liveness signal.
- **P4 資產撞車** — no claim/lock primitive of any kind (grep-empty).

Stage 1 (llm-playground git-claim convention) and stage 2 (per-project handle ops) are owned by
the CEO. This plan is **only** the three source changes, ordered by ascending risk:

1. Presence auto-report + TTL/heartbeat/eviction (lowest risk).
2. Native claim/lock primitive (schema migration; medium risk).
3. Subject-scoped broadcast / pub-sub (touches the SUBJECT_ROUTING_SPEC direct-only sealed
   decision; highest risk — gated on decorrelated spec_review).

## Success criteria (quantifiable)

- `pnpm -r test:ci` stays green (baseline: shared 72 / peer-agent 91 / relay 86 / e2e 13+2skip).
- Per-package coverage thresholds NOT lowered (shared 95/95/90/95, relay 85/85/80/85,
  peer-agent 80/80/70/80). New code carries its own tests.
- #1: a peer with a live SSE stream shows `online:true` in `list_peers` WITHOUT calling
  `set_summary`; a peer whose stream dropped >TTL ago shows `online:false` (verified by a
  fake-clock registry test + a route test).
- #2: `POST /v1/claim` acquires/renews/rejects-on-conflict correctly; `GET /v1/claims` lists
  only live (non-expired) claims; schema version advances to 6 and re-open is idempotent
  (verified by store + route + migration tests).
- #3: EITHER shipped behind a decorrelated-review-approved delivery-semantics contract, OR
  escalated to CEO with the N-DM alternative — never a silent invariant break.

---

## Item 1 — Presence auto-report + TTL + eviction

### Current state (file:line)
- `packages/relay/src/presence/registry.ts` — in-memory `Map`, `set/remove/get/listTeam`, NO
  TTL. `SessionState.last_seen` is recorded but never used for expiry.
- `packages/relay/src/routes/presence.ts` — `POST /v1/presence` is the only writer; also emits a
  `presence_update` @team broadcast.
- `packages/relay/src/routes/peers.ts:33` — `online: Boolean(snap)`; snapshot never expires.
- `packages/relay/src/routes/stream.ts` — SSE connect/disconnect (`cleanup`, L106) does NOT touch
  presence. `deps.presence` is available via `Deps`.
- `packages/peer-agent/src/index.ts` — wires `StreamClient`; never posts presence on connect.
- `packages/peer-agent/src/stream.ts` — `StreamClient.start()` reconnect loop; no `onConnect` hook.
- `packages/peer-agent/src/config.ts:24-28` — `presence.auto_publish_{cwd,branch,repo}` flags
  ALREADY exist (privacy control). `roots.ts:detectWorkingContext()` supplies cwd/branch/repo.

### Design
Relay side (authoritative liveness = TTL, not a boolean):
- Add `PRESENCE_TTL_MS` (shared constant, proposed 90_000 = 3× the client heartbeat below).
- `PresenceRegistry` takes an optional `ttlMs` (default `PRESENCE_TTL_MS`) alongside the existing
  injectable `now`. `get()` and `listTeam()` **lazily evict** sessions whose `last_seen` is older
  than `now - ttlMs`; a handle with all sessions evicted returns `undefined` (⇒ `online:false`).
  Lazy eviction (on read) keeps the change small and testable with the injected clock; no timer.
- `stream.ts` SSE `cleanup` calls `deps.presence.remove(team, handle, label)` on disconnect, where
  `label = c.get('token').label` (same key `presence.set` uses) — immediate offline reflection
  rather than waiting out the TTL. TTL remains the correctness backstop (crash / no clean abort).

Peer-agent side (auto-report, privacy-respecting):
- `StreamClient` gains an optional `onConnect?: () => void | Promise<void>` fired after a 200
  stream open (every (re)connect). `index.ts` wires it to POST presence via the existing
  `RelayClient.setPresence`, honoring `cfg.presence.auto_publish_*` (reuse the exact `set_summary`
  gating in `tools.ts:151-155`). Summary defaults to a neutral string (e.g. `"(connected)"`) since
  the agent may not have set one yet — content is still gated by the privacy flags.
- Add a heartbeat: re-POST presence every `PRESENCE_HEARTBEAT_MS` (proposed 30_000, < TTL/2) while
  the stream is up, cleared on stop/disconnect. Keeps `last_seen` fresh so a long-lived idle
  session does not TTL-evict itself.

### Privacy
cwd/branch/repo are only ever attached when the operator's `auto_publish_*` flags are true (default
true) and are only visible within the team roster (unchanged trust boundary). No new fields; the
auto-report path reuses the same gating as the manual `set_summary` path. Documented as a residual:
presence content visibility == existing `set_summary` visibility.

### Tests
- registry: fake-clock — session set, `get` within TTL returns it; advance past TTL ⇒ `undefined`;
  eviction removes the empty handle bucket; multi-session handle where one expires keeps the other.
- stream route: open SSE ⇒ (no presence yet, unchanged) ; on abort ⇒ `presence.remove` called.
- peer-agent stream: `onConnect` fired on 200; NOT fired on 401; heartbeat scheduled/cleared.
- peer-agent index wiring covered by the existing e2e integration lane where practical; unit-test
  the `onConnect` callback builder (privacy-flag gating) directly.

---

## Item 2 — Native claim/lock primitive

### Current state
No claim/lock anywhere. `db.ts` runs sequential `migrateVNtoVN+1` guarded by `pragma table_info`
/ `sqlite_master` probes; schema is at v5 (`schema.sql:1`, `INSERT OR IGNORE schema_version 5`).

### Data model — schema v6
New table (append to `schema.sql`, plus a `migrateV5ToV6` that `CREATE TABLE IF NOT EXISTS` +
`INSERT OR IGNORE schema_version(6)`; a new table needs no ALTER, so the CREATE in schema.sql
covers fresh DBs and the migration covers already-open DBs):

```sql
CREATE TABLE IF NOT EXISTS claim (
  team_id      TEXT NOT NULL REFERENCES team(id),
  claim_key    TEXT NOT NULL,            -- asset key, e.g. "repo:llm-playground:configs/foo.toml"
  owner_handle TEXT NOT NULL,            -- authenticated claimer
  owner_label  TEXT,                     -- token label (session) that claimed, informational
  note         TEXT,                     -- optional free-text reason
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,            -- created_at + ttl; TTL-based auto-release
  PRIMARY KEY (team_id, claim_key)
);
CREATE INDEX IF NOT EXISTS idx_claim_expires ON claim(team_id, expires_at);
```

Single-owner-per-key (mutex) semantics. `expires_at` gives auto-release so a crashed claimer does
not wedge an asset forever (same philosophy as presence TTL).

### Store — `ClaimStore` (new `packages/relay/src/claims/store.ts`)
- `acquire(team, key, owner_handle, owner_label, ttlSec, note?) → { ok, claim } | { ok:false, conflict }`
  - Read current row. If none, or `expires_at <= now` (expired), or `owner_handle == caller`
    (renew/extend): upsert with new `expires_at = now + ttlSec`, return the claim. `owner_label`
    updates to the current session on renew.
  - Else (live claim by another handle): return conflict with the current owner + `expires_at`.
  - Bounded `ttlSec` (min 1, max e.g. 86400) validated at the route.
- `list(team) → Claim[]` — live (`expires_at > now`) only; ORDER BY claim_key.
- `release(team, key, owner_handle) → boolean` — delete only if caller owns it (or it is expired);
  returns whether a row was removed. Non-owner release of a live claim is refused.
- Injected `now` for deterministic tests (mirrors `MessageStore`/registry style).

### Routes — `packages/relay/src/routes/claims.ts`
- `POST /v1/claim` — bearer auth + rate limit (reuse the messages pattern). Body:
  `{ key: string(≤256, regex), ttl_seconds: int(1..86400), note?: string(≤512) }`.
  owner = `c.get('peer').handle`, label = `c.get('token').label`. → 201 `{ claim }` on
  acquire/renew, 409 `{ error:'claim_conflict', owner, expires_at }` on live-conflict.
- `GET /v1/claims` — bearer auth. → 200 `Claim[]` (live only).
- `DELETE /v1/claim` (or `POST /v1/claim/release`) — body `{ key }`; owner-only release.
  → 200 `{ released: boolean }`, 409 if held by another live owner.
- Mount in `app.ts`; add `claims: ClaimStore` to `Deps`.

### ACL posture (stated explicitly for review)
v1 claim is a **cooperative advisory lock across the trusted roster** — any authenticated roster
member may claim any key (like `@team` chatter, it is roster-scoped, not namespace-gated). This
matches P4's intent (avoid two agents editing the same asset) without coupling to the subject-ACL.
Namespace-gating claims is a possible future tightening; called out as out-of-scope residual.

### peer-agent tools — `tools.ts`
- `claim_asset` (key, ttl_seconds?, note?) → calls `POST /v1/claim`; surfaces owner/expiry on
  conflict so the agent can back off. Default ttl e.g. 3600.
- `list_claims` () → `GET /v1/claims`, JSON to the model.
- (optional) `release_claim` (key) → release. Include for symmetry/completeness.
- `RelayClient` (outbound.ts) gains `claim/listClaims/releaseClaim` methods.
- Add descriptors to `TOOL_DESCRIPTORS` / wire into `index.ts` ListTools.

### Tests
- store: acquire on empty; renew by same owner extends expiry; conflict by other owner; expired
  claim is re-acquirable by anyone; release by owner; release refused for non-owner; list hides
  expired. All with injected clock.
- migration: fresh DB has `claim` table + schema_version 6; re-open idempotent; a v5 DB gains the
  table on open (probe-guarded).
- routes: acquire 201, conflict 409, list live-only, release owner-only, validation 400s.
- peer-agent: tool arg validation + RelayClient method (injected fetch) happy/conflict paths.

---

## Item 3 — Subject-scoped broadcast / pub-sub (SEALED-DECISION, review-gated)

### The sealed invariant being touched
`SUBJECT_ROUTING_SPEC.md` §3.3 (Direct-only constraint) + §12.1: *"a subjected message has exactly
one intended recipient, so the single `delivered_at` column remains correct — this is the lever
that lets us skip a per-recipient delivery table"*, and *"`@team` stays `subject=null` … a subjected
`@team` send is a hard 400"*. Enforced in three places: `EnvelopeSchema.superRefine`
(`envelope.ts:68-74`), `OutboundMessageSchema.superRefine` (`envelope.ts:102-108`), and the publish
route (implicitly, via the recipient-ownership check `messages.ts:61-65`, which 409s @team because
`loadOwnedSet('@team')` is empty).

### Key finding — the invariant was written BEFORE the B3 id-cursor machinery, and `@team`
### already has broadcast (not exactly-once) delivery semantics
Tracing the current code (post-B3):
1. `@team` **null-subject** broadcast ALREADY has "first/any-recipient" `delivered_at` semantics:
   `messages.ts:83-90` stamps `delivered_at` on enqueue if *any* peer is online. A late cold-start
   joiner (`fetchPendingSince`, `delivered_at IS NULL`) can miss it. Multi-recipient **redelivery**
   is preserved for `?since=<cursor>` resume, which uses the **id-cursor only, delivery-agnostic**
   (`store.ts:fetchSince`, spec §5.1 B3). So `@team` is ALREADY a broadcast channel whose
   correctness rests on the id-cursor, not on `delivered_at`.
2. The per-subscriber gate `deliverable()` (`stream.ts:47-52`) + fanout `accept()` (`fanout.ts:54`)
   ALREADY apply `ownsNamespace` + `matchesInterest` to ANY subject on BOTH live and backlog — for
   `@team` fanout too (fanout iterates all handles and consults each `accept`). The interest
   filtering infrastructure for subject-scoped `@team` is therefore **already present and tested**;
   only the two `superRefine` guards + the recipient-ownership check forbid using it.
3. For a subjected message `messages.ts:83` (`subject===null`) is false, so it does NOT stamp on
   enqueue (R4) — the stream write loop is the sole `delivered_at` writer. This is STRICTLY more
   careful than the null-subject @team enqueue-stamp.

**Conclusion:** allowing a subjected `@team` broadcast introduces NO new delivery-semantics hole
beyond what null-subject `@team` already has. It does NOT require a per-recipient delivery table:
subjected `@team` inherits `@team`'s existing broadcast model (id-cursor redelivery; first-recipient
`delivered_at` is a cosmetic/ambient flag for broadcasts). The §12.1 "exactly one recipient" lever
still holds for **direct** subjected messages, which are unchanged.

### Proposed design (Option A — minimal, R1-preserving relaxation)
Relax direct-only **only for `chat` kind on `@team`**; keep `task_dispatch` (commands) direct-only:
- `envelope.ts` superRefine: change the guard from "subject!=null && to==@team ⇒ error" to
  "subject!=null && to==@team && kind!='chat' ⇒ error". (i.e. subjected `@team` is allowed ONLY for
  `chat`.) The `in_reply_to ⇒ subject=null` (M4 ack channel) guard is UNCHANGED.
- `messages.ts`: for `subject!=null`:
  - keep kind gate, but now `chat` may target `@team`; `task_dispatch` to `@team` still rejected
    (preserves spec §13.1 R1 "commands never `@team`").
  - keep PUBLISHER ownership (you may only broadcast on a namespace you own).
  - SKIP the recipient-ownership check when `to==@team` (no single recipient; each subscriber is
    independently gated by `ownsNamespace`+interest in `stream.ts`/`fanout`). Keep it for direct.
  - keep `delivered_at` handling: subjected ⇒ no enqueue-stamp (already correct via `subject===null`
    branch).
- No schema change. No fanout change (accept() already handles it). No new delivered-tracking.

Net effect on P1: `@team` coordination **chat** can now carry an optional subject; the relay fans it
out ONLY to roster members who OWN that namespace AND match their interest filter — so `@team` is no
longer 無差別. Commands (`task_dispatch`) remain per-owner direct gated DMs (R1 intact).

### Why NOT the alternative (Option B — N-DM per-owner fan-out) for broadcast
§13.1 R1 already prescribes N-DM for *commands* (the hub knows the owner set). For a *coordination
broadcast* ("anyone who cares about namespace X"), N-DM requires the publisher to enumerate current
namespace owners — not exposed to peers, and racy as the roster changes. Subject-scoped broadcast is
the natural mechanism for P1; N-DM is the natural mechanism for P2/commands. They are complementary,
not substitutes. Option B remains the escalation fallback if review judges Option A's invariant
relaxation unacceptable.

### DECORRELATED SPEC_REVIEW QUESTION (must pass before implementing #3)
> Given that (a) `@team` already has broadcast/id-cursor delivery semantics (NOT exactly-once) and
> (b) the per-subscriber ownership+interest gate already runs on `@team` fanout and backlog, is it
> acceptable to relax `direct-only` for `chat`-kind `@team` (Option A), documenting subjected `@team`
> as "gated ambient broadcast" with the SAME delivery contract as null-subject `@team`? Or does the
> §3.3/§12.1 sealed decision require the N-DM alternative (Option B) / a per-recipient delivery
> table? If Option A is unacceptable, #3 escalates to CEO for Option B; #1 and #2 ship regardless.

### Tests (if Option A approved)
- envelope: subjected `@team` chat parses OK; subjected `@team` task_dispatch still rejected;
  subjected `@team` chat with `in_reply_to` still rejected (M4); direct subjected unchanged.
- messages route: publisher-owns-namespace required for subjected `@team` chat (403 if not);
  recipient-ownership NOT required for `@team`; subjected `@team` task_dispatch → 400.
- fanout/stream: subjected `@team` chat delivered only to owner+interested subscribers; a
  non-owner subscriber does NOT receive it; backlog id-cursor resume redelivers to a second owner.
- delivered_at: subjected `@team` chat is NOT enqueue-stamped; stamped after first write.

### SUBJECT_ROUTING_SPEC.md addendum
On approval, append an addendum recording the relaxation, the delivery-contract equivalence to
null-subject `@team`, the R1-preserving `chat`-only scope, and the retained residual (cold-start
late-joiner miss == existing null-subject @team behavior).

---

## Out of scope / residuals
- Per-recipient delivery table (kept avoided; #3 rides @team broadcast semantics).
- Namespace-gating of claims (v1 claims are roster-cooperative advisory locks).
- Presence content confidentiality (== existing set_summary visibility).
- Stage 1 / Stage 2 (CEO-owned).

## Review Ledger

### Decorrelated spec_review — Item 3 direction (gpt-5.5 xhigh via codex, read-only)
**VERDICT: NEEDS-CHANGES** (direction APPROVED = Option A; NOT escalated to Option B).
Reviewer confirmed:
- Core claim TRUE: `chat`-kind subjected `@team` introduces NO new delivery-semantics hole vs
  null-subject `@team` (Option A stamps `delivered_at` LATER — after first successful SSE write —
  so it is not weaker for cursor replay). No derivable counterexample.
- No receive leak: subjected `@team` fanout + backlog both pass `deliverable` (fail-closed on
  ownership+interest). No publish spoof: publisher-ownership retained; skipping recipient-ownership
  for `@team` is correct (no single recipient; each subscriber independently gated).
- R1 preserved iff both superRefine guards AND the publish route reject
  `subject!=null && to=='@team' && kind!='chat'` and keep `task_dispatch→@team = 400`.

**Conditions to satisfy before/while implementing #3 (all MUST be met):**
1. Update `SUBJECT_ROUTING_SPEC.md` §3.3/§12.1 explicitly — the "exactly one recipient" statement
   becomes false for subjected `@team` chat. Bifurcate `delivered_at`: DIRECT subjected = recipient
   delivery; `@team` subjected = cursor-replay delivery + `delivered_at` is ambient/first-delivery
   metadata only.
2. Audit that EVERY subjected `@team` delivery path uses `deliverable` — live fanout, backlog, AND
   any admin/export/read API. (No read API may bypass the gate.)
3. Document interest-widening replay as accepted policy (cursor replay uses CURRENT ownership +
   interest, so widening interest can re-surface old subjected `@team` rows by cursor).
4. Call out that the `in_reply_to ⇒ subject=null` ack-channel guard (M4) stays UNCHANGED.
5. Retention/purge (7-day) is the replay upper bound; subjected `@team` must NOT imply a stronger
   delivery guarantee than 7-day cursor-based replay.

Decision: **#3 SHIPS (Option A)**, not escalated. The 5 conditions are folded into the
SUBJECT_ROUTING_SPEC addendum + the audit step below.

## Doc updates required
- `CLAUDE.md` — currently marks relay + peer-agent as "not started"; all three packages are fully
  implemented. Correct the status and add presence-TTL / claim / subject-broadcast to the surface.
- `SUBJECT_ROUTING_SPEC.md` — #3 addendum (only if Option A approved).
- `README.md` — new `/v1/claim` endpoints + new MCP tools, presence liveness note.
