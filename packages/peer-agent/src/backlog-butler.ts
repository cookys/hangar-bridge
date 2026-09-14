import {
  CHANNEL_SOURCE_PEERS, PROTOCOL_VERSION, HANGAR_TEAM_ID, EnvelopeSchema, escapeChannelBody, newMessageId,
  type BacklogEvent, type Envelope,
} from '@hangar-bridge/shared'
import type { PendingBacklog } from './cursor-store.ts'

/**
 * Replay butler — the peer-agent half (plan §2.4).
 *
 * The relay sends ONE `backlog` event instead of the chat rows a reconnecting
 * session missed. This module turns that event into the one thing the
 * harness sees: a synthetic summary that is explicitly NOT a message — no
 * relay msg_id, nothing to reply to — and tells it how to pull the rest.
 */

const RESUME_LIMIT = 50

/** Human-readable body for the summary. Sender handles are escaped like any peer text. */
export function renderBacklogSummary(b: BacklogEvent): string {
  const count = b.pending_capped ? `${b.pending}+` : String(b.pending)
  const senders = Object.entries(b.by_sender)
    .map(([k, n]) => `${escapeChannelBody(k)} ${n}`)
    .join(', ')
  const since = b.resume_since === '' ? '' : ` since=${b.resume_since}`
  const lines = [
    `[hangar-bridge] backlog summary — this is NOT a message and cannot be replied to.`,
    `While this session was offline, ${count} chat message(s) arrived and were held back`
      + ` (oldest ${b.oldest}, newest ${b.newest}).`,
    senders ? `By sender: ${senders}.` : '',
    b.replayed_exempt > 0
      ? `${b.replayed_exempt} non-chat message(s) (dispatch/permission/result) were delivered normally above.`
      : '',
    b.pending_capped
      ? `The count stopped at the relay's scan cap; there may be more beyond ${b.newest}.`
      : '',
    `To read them, on your own terms: poll_inbox${since} limit=${RESUME_LIMIT}`
      + (b.resume_since === '' ? ' (from the beginning of the buffer)' : '')
      + `, then follow next_cursor. Nothing here was marked delivered on your behalf.`,
  ]
  return lines.filter(l => l.length > 0).join('\n')
}

/** Claude-channel shape: one notification, no msg_id, `synthetic: backlog`. */
export function backlogToChannelNotification(b: BacklogEvent): { method: string; params: Record<string, unknown> } {
  return {
    method: 'notifications/claude/channel',
    params: {
      content: renderBacklogSummary(b),
      meta: {
        from: 'relay',
        source: CHANNEL_SOURCE_PEERS,
        synthetic: 'backlog',
        pending: String(b.pending),
        pending_capped: b.pending_capped ? '1' : '0',
        oldest: b.oldest,
        newest: b.newest,
        resume_since: b.resume_since,
        replayed_exempt: String(b.replayed_exempt),
      },
    },
  }
}

/**
 * Courier shape: the agent-call / switchboard final mile only accepts an
 * Envelope, so mint one locally — self-addressed chat, never sent to the
 * relay. `meta.reply = none` and the body say it is not a message; a
 * `reply_to_peer` against its id is refused by the relay (unknown id).
 */
export function backlogToSyntheticEnvelope(b: BacklogEvent, selfHandle: string): Envelope {
  return EnvelopeSchema.parse({
    id: newMessageId(),
    v: PROTOCOL_VERSION,
    team: HANGAR_TEAM_ID,
    from: selfHandle,
    to: selfHandle,
    subject: null,
    in_reply_to: null,
    thread_root: null,
    kind: 'chat',
    content: renderBacklogSummary(b),
    meta: { synthetic: 'backlog', reply: 'none', pending: String(b.pending), newest: b.newest },
    to_filter: null,
    sent_at: new Date().toISOString(),
    delivered_at: null,
  })
}

/** The `backlog` event as the durable reminder the cursor store keeps. */
export function backlogToPending(b: BacklogEvent, now: () => Date = () => new Date()): PendingBacklog {
  return { count: b.pending, since: b.resume_since, newest: b.newest, at: now().toISOString() }
}

/**
 * A poll clears the reminder only when it started at or before the batch's
 * `since` AND reached at least `newest` — i.e. the harness has had every
 * summarized row in front of it. A partial page, or a poll that started past
 * `since`, leaves the reminder in place (plan §2.4 step 3).
 */
export function shouldClearBacklog(
  b: PendingBacklog,
  poll: { since: string | undefined; nextCursor: string | null },
): boolean {
  if (poll.nextCursor === null) return false
  const startedEarlyEnough = poll.since === undefined || poll.since <= b.since
  return startedEarlyEnough && poll.nextCursor >= b.newest
}
