# Plan — relay follow-ups (F-P3-1 + open BACKLOG)

Base: `565cb42` (develop tip, 2026-09-17). Branch: `feat/relay-followups`.
Repo: hangar-bridge (pnpm/TS/vitest). Relay is LIVE on this host — never
restarted/redeployed by this line; wire stays backward compatible.

## Item 2 — presence heartbeats in the durable buffer: ALREADY FIXED, close only

Evidence: `packages/relay/src/routes/presence.ts:69-76` calls
`deps.store.buildEnvelope(...)` directly and hands the envelope to
`deps.fanout.deliver(envelope)` only. `packages/relay/src/messages/store.ts:146`
shows `insert()` is the only path that persists a row (it calls `buildEnvelope`
then does the DB write); presence never calls `insert`. No campaign. Action:
flip the BACKLOG row to Done with this evidence line, no code change.

## Item 5 — sibling processing rights / replay-butler rows: decision note, skip

"Sibling processing rights are unassigned" (size L) needs a product decision
(pre-emptive claim vs. assigned holder) with no default that is obviously
correct — out of scope for a mechanical fix. The two replay-butler rows
(`stream.ts` raw-scan ceiling, `stream.ts`+`messages.ts` double-drain) are each
S-sized but touch the same hot backlog-scan code path twice in one line without
a shared regression harness; bundling them here risks an ordering bug neither
row's author anticipated. Leave a one-paragraph note in the ledger for each of
the three rows and skip. No code.

## Phase 1 — F-P3-1: per-session `summary`/`caps`/`delivery_state` on `/v1/peers` sessions[]

**Problem** (confirmed by reading, not assumed): `PresenceSession`
(`packages/relay/src/presence/registry.ts:13-27`) has no `summary` field, and
`toSession()` (line 76-86) never copies `SessionState.summary` into the wire
shape — so every session row on `/v1/peers` carries only the HANDLE-level
`summary`, which is `first.summary` (`get()`, line 178): the first entry in
Map iteration (insertion) order, not the most-recently-written one. Two
peer-agents sharing a handle each POST their own summary; only the
first-inserted session's text is visible anywhere, and it never rotates to
whichever session most recently reported.

**Fix**:
1. `registry.ts`: add `summary: string` to `PresenceSession`; copy it in
   `toSession()`. `caps` and `delivery_state` already flow per-session — only
   `summary` is missing.
2. `registry.ts` `get()`: keep the handle-level `summary` for back-compat, but
   select the **most recent non-empty** session summary (by `last_seen`) —
   not `sessions[0]`. Fall back to `''` only if every session's summary is
   empty.
3. `packages/relay/src/routes/peers.ts`: no wire-shape change needed — `sessions`
   already spreads `snap.sessions` (now carrying `summary`) plus `subscriptions`;
   confirm with a test that a session row's own `summary` survives the merge.
4. `packages/peer-agent/src/tools.ts` `renderPeerLine`/`renderGroupedPeers`:
   when a peer has >1 session, append one indented line per session showing
   its own summary (label/instance + summary), so the fleet-facing `list_peers`
   tool text — not just the raw JSON a caller could already see — surfaces the
   per-session view. Ungrouped (ordinary) mode already dumps raw JSON
   including `sessions[]`; only the grouped/strict text renderer needs this.
5. Out of repo scope (per `hangar-bridge-followups.md`): `bin/fleet` lives in
   the dotfiles repo, not here — note it in the ledger, do not touch it.

Adversarial harness first (depth-0 owned test file — new or extended
`registry.test.ts` / `peers.test.ts`): two sessions on one handle each set a
distinct non-empty summary at different times; assert (a) each session's own
`summary` appears on its own row, (b) the handle-level `summary` equals the
later-written one, (c) a session with an EMPTY summary does not clobber the
handle-level summary chosen from a sibling. Run this against base `565cb42`
first and confirm RED (captured as `red-on-base-phase1.txt`).

## Phase 2 — `@team` fanout skips the sending handle entirely; siblings should hear it

**Problem** (confirmed): `packages/relay/src/fanout.ts` `resolveMatches()`,
lines ~212-218 (current file, BACKLOG's cited `:106` is stale after the groups
merge): for an **unnarrowed** broadcast (`e.to_filter == null`) the whole
sending HANDLE is skipped via `continue` — every sibling session on the
sender's own host is excluded, not just the sending instance. The narrowed
(`to_filter != null`) branch already does the right thing: it filters out only
`senderInstance` via `filterOutInstance` and delivers to the rest.

**Design decision (per the line brief, this is the resolution — not a fresh
debate)**: unify both branches. For any `@team` (non-group) broadcast where
`handle === e.from`, deliver to every sibling session on that handle and
exclude ONLY the sending instance — exactly like the narrowed branch and like
the direct-message self-exclusion already does. A legacy sender (no
`senderInstance`) cannot be told apart from its own siblings, so it keeps the
old whole-handle skip (fail-safe, unchanged wire contract for old clients).

**Fix**: drop the `if (e.to_filter == null) continue` early-exit; keep only
the `senderInstance === undefined` legacy guard, then always
`collect(handle, filterOutInstance(set, senderInstance)); selfExcluded = true`.
Update the block comment (lines ~202-211) — it currently states the opposite
rationale and must not survive describing removed behavior. GROUP_BROADCAST
handling (`e.to === GROUP_BROADCAST_HANDLE`, sibling groups path) is untouched.

Adversarial harness first (extend `fanout.test.ts`): two subscribers on one
handle, host A sends an UNNARROWED `@team` broadcast; assert the sending
instance does NOT receive it and the sibling instance DOES. Confirm RED on
base `565cb42`.

## Phase 3 — ephemeral messages have no working reply path

**Problem** (confirmed): `packages/relay/src/routes/messages.ts:168-169` (the
ephemeral send branch) tells the receiver to reply via `meta.correlation_id`,
but the correlation_id is never generated: a sender-supplied `correlation_id`
is stripped at line ~108 as anti-forgery, and the ephemeral branch only sets
`ephemeral='1'`. `in_reply_to` 400s because the ephemeral parent was never
persisted (no durable row to reference). Both documented reply routes are
therefore closed.

**Fix** (smallest correct fix per the brief): when the relay builds an
ephemeral envelope, it — not the sender — mints a `correlation_id` (reuse the
same ID generator as `newMessageId`/message ids, or the envelope's own `id` if
that is already unique per send) and stamps it into `meta.correlation_id` on
the OUTBOUND envelope the receiver gets. The relay also remembers, in-memory,
`correlation_id -> { from, to, ttl }` for the ephemeral parent's audience
(bounded TTL matching `EPHEMERAL_ROUTE_TTL_MS`, already imported in
messages.ts) so that a reply carrying that `correlation_id` resolves to the
audience the ephemeral parent reached, even though nothing durable was ever
written. If a reply arrives after the TTL or with an unknown correlation_id,
it is rejected the same way an unknown `in_reply_to` parent is today (existing
`unknown_parent`-shaped 400), not a new silent failure.

If, on reading the reply-resolution code path (`routes/messages.ts` POST
handler, `in_reply_to` handling), the smallest correct fix needs a design
decision beyond this (e.g. persistence semantics conflicting with the
no-durable-write contract for ephemeral), STOP this item, write the two
options considered in the ledger, and do not guess — per the line brief.

Adversarial harness first: sender A sends an ephemeral message to B; B reads
`meta.correlation_id` from the delivered envelope and replies using it;
assert the reply reaches A (not a 400, not silently dropped). Confirm RED on
base `565cb42` (today: no correlation_id present at all, or a reply attempt
against it 400s).

## Verify (every phase, fresh worktree)

`pnpm -r test:ci` (vitest + coverage) and `pnpm -r typecheck` (or the relay
package's own `typecheck` script — confirm in `package.json` per-package
scripts before writing the campaign's `verify_cmd`). `scripts/verify-groups.sh`
only if a phase touches group-scoped code paths (Phase 2's `GROUP_BROADCAST`
branch is adjacent but untouched — run it anyway as a safety net).

## Out of scope for this line (explicit)

NATS cutover, subject-ACL rollout, replay-butler code changes (item 5, decision
note only), `bin/fleet` / `crew.zsh` / `agent-call` (different repo).
