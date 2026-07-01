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
