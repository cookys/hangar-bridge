export const PROTOCOL_VERSION = 2 as const
export const MAX_CONTENT_BYTES = 65536
export const MAX_META_KEY_LENGTH = 64
export const MAX_META_VALUE_LENGTH = 2048
export const PERMISSION_REQUEST_TTL_MS = 5 * 60 * 1000
export const DISPATCH_REQUEST_TIMEOUT_MS = 30 * 60 * 1000
// Presence liveness (fleet-coordination stage 3). A presence session is considered
// live only if its last_seen is within PRESENCE_TTL_MS of now (lazy eviction on read
// in PresenceRegistry). The peer-agent re-posts presence every PRESENCE_HEARTBEAT_MS
// while its SSE stream is up; TTL is 3× the heartbeat so a single dropped heartbeat
// (or brief reconnect) does not flap a peer offline. TTL is the correctness backstop
// for an unclean disconnect (crash / killed process that never runs SSE cleanup).
export const PRESENCE_HEARTBEAT_MS = 30 * 1000
export const PRESENCE_TTL_MS = 90 * 1000
// Claim/lock primitive (fleet-coordination stage 3, P4). Bounds on a claim's TTL and
// the free-text note; the asset key reuses a bounded dotted/colon/slash charset.
export const CLAIM_TTL_MIN_SECONDS = 1
export const CLAIM_TTL_MAX_SECONDS = 24 * 60 * 60
export const CLAIM_DEFAULT_TTL_SECONDS = 60 * 60
export const MAX_CLAIM_KEY_LENGTH = 256
export const MAX_CLAIM_NOTE_LENGTH = 512
// Claim key: a bounded, printable asset identifier. Allows dotted/namespaced keys and
// path-like keys (colon + slash) so callers can name e.g. "repo:foo:configs/bar.toml".
export const CLAIM_KEY_REGEX = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/
export const TEAM_BROADCAST_HANDLE = '@team' as const
export const HANDLE_REGEX = /^[a-z][a-z0-9_-]{0,31}$/
export const META_KEY_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/
export const CHANNEL_SOURCE_PEERS = 'hangar-bridge' as const
// Subject = optional dotted lowercase routing key (e.g. "mple2.command.assign").
// The first dot-token is the ACL "namespace". subject=null ⇒ legacy fan-out.
export const SUBJECT_REGEX = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/
export const MAX_SUBJECT_LENGTH = 128
// A namespace = a bare first-token (what peers.json `subjects.owned` lists).
export const NAMESPACE_REGEX = /^[a-z][a-z0-9_]*$/
// An interest pattern = a subject, optionally with a trailing '>' (the only wildcard).
// Single-sourced here so the relay (stream + peers-file) and peer-agent config all
// validate identically — a divergent copy on a fail-closed gate is a vulnerability.
export const INTEREST_REGEX = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*(\.?>)?$/
// Meta keys reserved for relay-stamped signals. The relay strips these from inbound
// envelope meta at the publish chokepoint, and sanitizeMeta drops them again, so a
// sender cannot forge them into a channel notification (B1): `subject` is the gated
// routing key (authentic value surfaces only as the relay-stamped `gated_subject`
// field), and `kind` is relay-set. `task_kind` is NOT reserved — it is a benign,
// non-authoritative display label (receivers key off gated_subject, never task_kind),
// so a sender-supplied task_kind must survive to the channel notification.
export const RESERVED_META_KEYS = ['subject', 'kind'] as const
// D10 stub posture: single-tenant. Every authenticated request binds to this
// team_id; schema retains the column + FK to keep migration risk at zero.
export const HANGAR_TEAM_ID = 'hangar' as const

// Reserved addresses (reply-routing spec §6.5). `@mailbox:<handle>` is the
// operator mailbox row a reply-verb write may target (§8.2); it is never a
// valid `to` on an outbound client message (`reserved_address`, envelope.ts).
export const MAILBOX_PREFIX = '@mailbox:' as const
export function isMailboxHandle(value: string): boolean {
  if (!value.startsWith(MAILBOX_PREFIX)) return false
  // The suffix must itself be a valid handle (reuse HANDLE_REGEX, don't
  // duplicate it) — not any non-empty string. Rejects '@mailbox:', a
  // suffix containing '@'/':'/whitespace (so '@team' and a nested
  // '@mailbox:x' can't sneak in), and anything else HANDLE_REGEX rejects.
  return HANDLE_REGEX.test(value.slice(MAILBOX_PREFIX.length))
}
// The CLI's mailbox identity (§8.2): the only accepted `x-hangar-instance`
// value that is not a ULID. Instance ids are ULIDs, so this literal cannot
// collide with a real one; it is never a valid `to_filter.instance`,
// `--instance`, or registration name (`reserved_instance`, envelope.ts).
export const RESERVED_CLI_INSTANCE = '~cli' as const

// Reply-routing error vocabulary (§13), shared by relay, CLI, and MCP so all
// three surface the same code/message. Each code maps to itself so a caller
// can use the object as both a value set and a type-narrowing lookup.
export const REPLY_ERROR_CODES = {
  use_reply_verb: 'use_reply_verb',
  unknown_parent: 'unknown_parent',
  not_a_recipient: 'not_a_recipient',
  legacy_unreplyable: 'legacy_unreplyable',
  parent_unaddressable: 'parent_unaddressable',
  reply_storm: 'reply_storm',
  sender_instance_required: 'sender_instance_required',
  handle_needs_all_sessions: 'handle_needs_all_sessions',
  dispatch_needs_instance: 'dispatch_needs_instance',
  not_in_thread: 'not_in_thread',
  reserved_address: 'reserved_address',
  reserved_instance: 'reserved_instance',
  use_relay_lane: 'use_relay_lane',
  return_target_gone: 'return_target_gone',
  reply_in_progress: 'reply_in_progress',
  idempotency_key_required: 'idempotency_key_required',
  idempotency_mismatch: 'idempotency_mismatch',
  grant_not_found: 'grant_not_found',
  idempotency_key_invalid: 'idempotency_key_invalid',
  instance_required: 'instance_required'
} as const
export type ReplyErrorCode = keyof typeof REPLY_ERROR_CODES

// §13 HTTP status column. `use_relay_lane` (a `fleet local send` preflight)
// and `return_target_gone` (a courier final-mile failure) are the two
// non-HTTP codes.
export const REPLY_ERROR_HTTP_STATUS: Record<ReplyErrorCode, number | null> = {
  use_reply_verb: 400,
  unknown_parent: 404,
  not_a_recipient: 403,
  legacy_unreplyable: 403,
  parent_unaddressable: 410,
  reply_storm: 429,
  sender_instance_required: 400,
  handle_needs_all_sessions: 400,
  dispatch_needs_instance: 400,
  not_in_thread: 403,
  reserved_address: 400,
  reserved_instance: 400,
  use_relay_lane: null,
  return_target_gone: null,
  reply_in_progress: 409,
  idempotency_key_required: 400,
  idempotency_mismatch: 422,
  grant_not_found: 404,
  idempotency_key_invalid: 400,
  instance_required: 400
}

// §13 Retryable column. `reply_storm` (retry after `retry_after_s`) and
// `reply_in_progress` (another request holds the idempotency lease, or this
// worker lost it) are the only retryable codes.
export const REPLY_ERROR_RETRYABLE: Record<ReplyErrorCode, boolean> = {
  use_reply_verb: false,
  unknown_parent: false,
  not_a_recipient: false,
  legacy_unreplyable: false,
  parent_unaddressable: false,
  reply_storm: true,
  sender_instance_required: false,
  handle_needs_all_sessions: false,
  dispatch_needs_instance: false,
  not_in_thread: false,
  reserved_address: false,
  reserved_instance: false,
  use_relay_lane: false,
  return_target_gone: false,
  reply_in_progress: true,
  idempotency_key_required: false,
  idempotency_mismatch: false,
  grant_not_found: false,
  idempotency_key_invalid: false,
  instance_required: false
}

// Tunables (§12, relay config defaults — not normative).
export const REPLY_LIMITER_DEFAULTS = { maxPerWindow: 10, windowMs: 10 * 60_000 } as const
export const EPHEMERAL_ROUTE_TTL_MS = 7 * 24 * 60 * 60_000
export const LEGACY_ROUTE_TTL_MS = 7 * 24 * 60 * 60_000
