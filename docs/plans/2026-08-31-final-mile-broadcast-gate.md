# Plan — stop fleet broadcasts from interrupting bridged non-Claude harnesses

Status: implemented — see the commit that carries this file
Repo: `cookys/hangar-bridge` (peer-agent)
Author: openclaw `01M1B6H8`
Date: 2026-08-31

## Problem

`twgs-revival/twgs-dev` bridges a codex session onto the fleet with
`final_mile: {kind: 'agent-call', target: ...}`. Inbound envelopes are handed to
`agent-call receive`, which **pastes into that session's tmux pane and presses
enter**. For a Claude peer an inbound message is one more item in context; for a
bridged TUI it is an interrupted turn and spent tokens.

The delivery path applies no recipient or kind filter
(`packages/peer-agent/src/index.ts:186-193`):

```js
emit: async (notification, envelope) => {
  if (cfg.final_mile.kind === 'claude-channel') { await server.notification(...); return }
  const receipt = await deliverViaAgentCall(envelope, { target, bin })   // unconditional
}
```

Measured on the relay DB, last 12 h:

```
@team broadcasts                     91
  gentoo 30 · openclaw 26 · aimax395 21 · cookys-7840hs 8 · cuda 6
directed to twgs-revival-twgs-dev    25   (cuda 23 — genuine bridge traffic; openclaw 2)
```

Relay `@team` fanout skips only the sending handle
(`packages/relay/src/fanout.ts:104-108`), so all 91 reached twgs-dev: roughly
**116 interruptions** into one codex session in half a day, of which the 91 were
addressed to nobody in particular.

## Non-goals

- Changing relay fanout semantics. Excluding the sender's handle is right for
  conversation; this is about what a *bridge endpoint* should accept.
- Suppressing directed messages. cuda's 23 are the bridge working as intended.
- Replacing the source-side gate. That ships separately in `cookys/dotfiles`
  (`f7f2592`: a PreToolUse hook plus a `--broadcast` requirement in `fleet`) and
  is complementary — it reduces broadcasts fleet-wide, but only on hosts that
  install it, and it cannot protect a bridge from a peer that has not.

## Rejected alternative

`subjects.interest` (`packages/peer-agent/src/config.ts:33-36`) cannot express
this: the relay passes any envelope whose `subject` is null
(`packages/relay/src/routes/messages.ts:49`, and the same rule in the stream
gate), and broadcast chat carries no subject. Verified before writing this.

## Design

Add one gate to `InboundDispatcher` (`packages/peer-agent/src/inbound.ts`),
alongside the existing swallow-and-advance cases (presence_update at :83,
interest narrowing at :90, permission_verdict at :99). Same shape: **advance the
cursor, do not emit** — the message is delivered-and-declined, not pending.

```ts
// A bridged harness is interrupted by delivery, so an envelope addressed to
// nobody in particular costs it a turn. Decline the unqualified fan-out —
// but only the kinds that are pure interruption.
if (
  this.opts.finalMileKind === 'agent-call' &&
  e.to === TEAM_BROADCAST_HANDLE &&
  e.kind === 'chat' &&
  e.subject === null &&
  !e.to_filter &&
  !this.opts.acceptBroadcast
) {
  logJson('info', 'peer.inbound.broadcast_declined', { msg_id: e.id, from: e.from, kind: e.kind })
  await this.opts.setCursor(e.id)
  return 'delivered'   // policy-terminal, same as the presence swallow — NOT 'rejected'
}
```

Placed after the presence swallow (`inbound.ts:87`). Four conditions carry
weight, each for its own reason:

- **`kind` restricted to `chat`.** `permission_request` is legitimate and
  actionable — `approval-routing.ts:23` returns `['@team']` for `ask_team`, a
  bridged codex can answer through the respond CLI, and it is rare and
  time-critical. `task_dispatch` was exempted late, on the code owner's
  objection, and the reasoning is worth keeping: a dispatch carries a
  `correlation_id`, and the fleet reads *no disposition at all* as a lost
  session. Swallowing a broadcast dispatch silently would manufacture a false
  lost-session signal indistinguishable from a real one — poisoning a detector
  whose entire input is silence. Since all 91 measured broadcasts were chat,
  excluding dispatch costs nothing and avoids that.
- **No subject** (`!e.subject`, not `=== null` — the field can be absent as well
  as null, and a strict comparison silently disabled the gate until a test caught
  it). A subjected `@team` reached this peer only because
  ownership and interest both matched — as deliberate as a `to_filter`, and
  exempt for the same reason.
- **`to_filter` absent.** As before.
- **Returns `'delivered'`**, not a bare `return`: `handle()` is typed
  `InboundDeliveryResult` (`inbound.ts:47`), and the message *was* delivered and
  declined by policy, exactly like the presence case at `:86`.

Threading `finalMileKind` as optional means `undefined` disables the gate, so
every other construction site (tests included) is unaffected.

### Transport safety (verified, not assumed)

Both lanes are safe with a cursor-advancing swallow. Under SSE the cursor is
persistent and the message is not replayed. Under NATS `cursorSink` is a no-op
(`cursor-store.ts:139`), and more decisively **broadcasts never travel over
JetStream**: the core-NATS consume loop skips `TASK_MESSAGE_KINDS`
(`nats-transport.ts:393`), the team lane admits only `chat|presence_update`
(`:396`, `:221-222`), and `dispatch_task` to `@team` is refused outright
(`tools.ts:467-468`). So there is no JetStream ack to mishandle.

The gate does **not** belong at the `emit` boundary in `index.ts`: emit is
called mid-`handle()`, so returning early there still runs
`replyLimiter.recordInbound` (`inbound.ts:175`), writes the dedupe `seen` entry,
and logs a misleading `peer.inbound.emitted` (`:160`).

## Tests

1. `inbound.test.ts` — agent-call + `@team` chat + no `to_filter` ⇒ not emitted,
   cursor advanced, returns `'delivered'`.
2. Same, with `to_filter` present ⇒ emitted.
3. Same, `accept_broadcast: true` ⇒ emitted.
4. `claude-channel` + `@team` ⇒ emitted (unchanged; Claude peers keep today's
   behaviour).
5. Directed `to: <handle>` under agent-call ⇒ emitted (cuda's traffic).
6. `config.test.ts` — `accept_broadcast` defaults to false and round-trips.
7. agent-call + `@team` `task_dispatch` ⇒ **emitted** (declining it would fake a
   lost session).
8. agent-call + `@team` `permission_request` ⇒ **emitted** (the carve-out that
   keeps `ask_team` working).
9. agent-call + `@team` chat with a non-null `subject` ⇒ emitted.

Assert on the concrete emitted/not-emitted call and the cursor value, not on
"before == after".

## Acceptance

- The only `agent-call` principal today is `twgs-revival/twgs-dev`; it is the
  sole behavioural change. `list_peers` must still show it after upgrade.
- End-to-end, in this order, because component tests passed while the last
  end-to-end link was broken: send an unqualified `@team` from another host and
  confirm **nothing** appears in the codex pane and the peer logs
  `broadcast_declined`; then send the same content with `to_filter{repo}` (or
  directed) and confirm it **does** arrive. Component tests alone are not
  acceptance.
- Existing sessions do not reload a changed artifact: the twgs-dev peer must be
  restarted, and its owner runs that, not us.

## Deployment

**Order matters and rollback is the dangerous direction.** `config.ts:24` parses
with `.strict()`, so a config carrying `accept_broadcast` against an artifact
that does not know the key fails to parse — and the peer does not start at all,
leaving the bridge fully deaf. Therefore: **upgrade the artifact first, write
the config key only afterwards**, and on rollback remove the key *before*
reverting the artifact. An old config against the new artifact is fine (zod
fills the default and the gate engages, which is the intended change).

Note for whoever deploys: this peer's presence reports `repo: "twgs-dev"` — the
basename of the daemon's cwd (`/home/twgs-dev`), not the repo the bridged codex
works in. So a `to_filter{repo: ...}` broadcast will not reach it in practice
unless the unit's `WorkingDirectory` is set to that repo. The carve-out is still
correct in principle, and `to_filter{instance}` does reach it.

Per `runbooks/hangar-bridge-fleet-deployment.md`: admit a full-SHA candidate,
relay first, then the peer. Only `twgs-dev` needs the new behaviour, but the
artifact is shared. Its account has its own systemd unit and its own operator —
hand them the change, do not reach in.

## Resolved in review (fable, 2026-08-31)

1. **Keep the `to_filter` carve-out**, and add `subject === null` so a subjected
   `@team` is exempt on the same reasoning. Note the repo-presence caveat above.
2. **Both `task_dispatch` and `permission_request` are exempt.** Gate on
   `kind === 'chat'` only. (fable proposed including dispatch; the hangar-bridge
   code owner objected on the lost-session grounds above and was right.)
3. **Keep `accept_broadcast`** — a config-level back-out that needs no artifact
   rebuild, and zod's default makes it zero-drift.
4. **Peer-side silence is acceptable.** Surfacing the decline to the sender needs
   a peer→relay NACK protocol, which is out of proportion; the
   `broadcast_declined` log plus a runbook note is enough.

Unverified from this host and carried as-is: the 12 h message counts and the
`dotfiles` commit reference. Neither affects the design.

## Open (for the implementer)

- `GET /v1/messages` (`poll_inbox`) has no equivalent gate, and `twgs-dev`
  advertises the `poll_inbox` capability. This asymmetry is deliberate — a pull
  is voluntary and interrupts nobody — but say so in the code comment so the
  next reader does not "fix" it.
