export const PROTOCOL_VERSION = 2 as const
export const MAX_CONTENT_BYTES = 65536
export const MAX_META_KEY_LENGTH = 64
export const MAX_META_VALUE_LENGTH = 2048
export const PERMISSION_REQUEST_TTL_MS = 5 * 60 * 1000
export const DISPATCH_REQUEST_TIMEOUT_MS = 30 * 60 * 1000
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
