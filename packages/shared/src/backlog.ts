import { z } from 'zod'
import { isValidMessageId } from './ulid.ts'

const MessageId = z.string().refine(isValidMessageId, 'invalid message id')

// Replay butler (docs/plans/2026-09-15-replay-butler.md §2.2).
//
// When a stream connects with `?replay_max=N` and the chat backlog it would
// have replayed exceeds N, the relay sends ONE `backlog` event instead of the
// chat rows, then every non-chat row as ordinary `message` events, then
// `backlog_end`. The chat rows stay in the durable buffer for `poll_inbox`.
// A client that does not send `replay_max` never sees either event.

export const SSE_EVENT_BACKLOG = 'backlog' as const
export const SSE_EVENT_BACKLOG_END = 'backlog_end' as const

/** `replay_max` is a positive integer no larger than one relay backlog page. */
export const REPLAY_MAX_MIN = 1
export const REPLAY_MAX_MAX = 1000

/** The relay scans at most this many rows when counting a backlog (§2.1). */
export const BACKLOG_SCAN_CAP = 10_000
/** `by_sender` carries at most this many named keys; the rest fold into `"…"`. */
export const BACKLOG_BY_SENDER_CAP = 20
export const BACKLOG_BY_SENDER_REST = '…' as const

export const BacklogEventSchema = z.object({
  /** Chat rows summarized away (|P ∩ chat|). */
  pending: z.number().int().min(0),
  /** True when the scan hit BACKLOG_SCAN_CAP — there may be more beyond `newest`. */
  pending_capped: z.boolean(),
  /** Oldest / newest ids in the scanned population (any kind). */
  oldest: MessageId,
  newest: MessageId,
  /** The `since` this connection carried; "" on a cold start. Poll from here to read the rest. */
  resume_since: z.string(),
  /** `@team` rows count under "@team" only; direct rows under their sender. */
  by_sender: z.record(z.string(), z.number().int().min(0)),
  /** Non-chat rows in the population — these were replayed one by one. */
  replayed_exempt: z.number().int().min(0),
})
export type BacklogEvent = z.infer<typeof BacklogEventSchema>

export const BacklogEndEventSchema = z.object({
  /** Same as the preceding `backlog.newest`: advance the cursor here. */
  newest: MessageId,
})
export type BacklogEndEvent = z.infer<typeof BacklogEndEventSchema>
