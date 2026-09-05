import { z } from 'zod'
import {
  HANDLE_REGEX, META_KEY_REGEX, MAX_CONTENT_BYTES,
  MAX_META_KEY_LENGTH, MAX_META_VALUE_LENGTH,
  PROTOCOL_VERSION, TEAM_BROADCAST_HANDLE,
  SUBJECT_REGEX, MAX_SUBJECT_LENGTH
} from './constants.ts'
import { isValidInstanceId } from './ulid.ts'

export const SubjectSchema = z.string().regex(SUBJECT_REGEX).max(MAX_SUBJECT_LENGTH)

// A presence-backed audience narrowing (v1: single session by instance, or all
// sessions in a repo). It only ever SHRINKS the `to` audience (monotonic
// narrowing → never widens authority). v1 opens exactly `instance` + `repo`;
// `cwd`/`branch` are deliberately deferred (host-specific / mutable footguns).
// `.strict()` rejects unknown keys; the refine rejects an empty selector so a
// no-op `{}` cannot silently mean "everyone".
export const ToFilterSchema = z.object({
  instance: z.string().refine(isValidInstanceId, 'must be a valid instance id').optional(),
  repo: z.string().min(1).max(200).regex(/^[A-Za-z0-9._/-]+$/, 'invalid repo').optional(),
}).strict().refine(
  f => f.instance !== undefined || f.repo !== undefined,
  { message: 'to_filter must set at least one of instance, repo' }
)
export type ToFilter = z.infer<typeof ToFilterSchema>

// Shared invariants for `to_filter` on both the stored envelope and the outbound
// message, so the relay and clients reject the same shapes. Kept as a helper to
// avoid the two schemas drifting.
function refineToFilter(
  e: { to: string; kind: string; subject?: string | null | undefined; to_filter?: ToFilter | null | undefined },
  ctx: z.RefinementCtx
): void {
  if (e.to_filter == null) return
  // Mutually exclusive with subject: subject is durable/ACL/redelivered, to_filter
  // is ephemeral/presence/online-only — mixing collides their delivery contracts.
  if (e.subject != null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['to_filter'],
      message: 'to_filter and subject are mutually exclusive' })
  }
  // Kind whitelist: only chat and task_dispatch may carry to_filter.
  if (e.kind !== 'chat' && e.kind !== 'task_dispatch') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['to_filter'],
      message: `to_filter is not allowed on kind '${e.kind}' (only chat, task_dispatch)` })
  }
  // A command must reach exactly one owner: task_dispatch may only narrow by a
  // single instance (repo could match >1 session → one command, many results on
  // one correlation_id). Mirrors the "commands are direct DMs" rule (R1).
  if (e.kind === 'task_dispatch') {
    if (e.to === TEAM_BROADCAST_HANDLE) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['to_filter'],
        message: 'task_dispatch with to_filter must target a concrete handle, not @team' })
    }
    if (e.to_filter.repo !== undefined || e.to_filter.instance === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['to_filter'],
        message: 'task_dispatch with to_filter may only narrow by instance (not repo)' })
    }
  }
  // @team + to_filter is a fan-out narrowing → only chat (mirrors subjected-@team).
  if (e.to === TEAM_BROADCAST_HANDLE && e.kind !== 'chat') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['to_filter'],
      message: 'to_filter on @team is allowed only for chat' })
  }
}

export const AddressSchema = z.union([
  z.string().regex(HANDLE_REGEX, 'handle'),
  z.literal(TEAM_BROADCAST_HANDLE)
])

export const KindSchema = z.enum([
  'chat', 'presence_update', 'permission_request', 'permission_verdict',
  'task_dispatch', 'task_result'
])

export const MetaSchema = z.record(
  z.string().regex(META_KEY_REGEX).max(MAX_META_KEY_LENGTH),
  z.string().max(MAX_META_VALUE_LENGTH)
).default({})

const ContentSchema = z.string().refine(
  s => Buffer.byteLength(s, 'utf8') <= MAX_CONTENT_BYTES,
  { message: `content exceeds ${MAX_CONTENT_BYTES} bytes` }
)

const MessageIdSchema = z.string().regex(/^msg_[0-9A-HJKMNP-TV-Z]{26}$/)

export const EnvelopeSchema = z.object({
  id: MessageIdSchema,
  v: z.literal(PROTOCOL_VERSION),
  team: z.string().min(1).max(64),
  from: z.string().regex(HANDLE_REGEX),
  to: AddressSchema,
  // Required-but-nullable on the stored envelope (like in_reply_to). `.default(null)`
  // lets pre-subject rows / legacy constructors omit it (parses to null = legacy
  // fan-out); the relay always stamps it explicitly at publish (§4 / store.insert).
  subject: SubjectSchema.nullable().default(null),
  in_reply_to: MessageIdSchema.nullable(),
  thread_root: MessageIdSchema.nullable(),
  kind: KindSchema,
  content: ContentSchema,
  meta: MetaSchema,
  // Presence-backed audience narrowing (v1: instance | repo). Nullable + default(null)
  // so legacy rows / pre-to_filter constructors parse to null (= no narrowing).
  to_filter: ToFilterSchema.nullable().default(null),
  sent_at: z.string().datetime(),
  delivered_at: z.string().datetime().nullable()
}).superRefine((e, ctx) => {
  refineToFilter(e, ctx)
  if (e.kind === 'permission_verdict' && e.in_reply_to === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['in_reply_to'],
      message: 'permission_verdict requires in_reply_to referencing the permission_request'
    })
  }
  if (e.kind === 'task_result' && e.in_reply_to === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['in_reply_to'],
      message: 'task_result requires in_reply_to referencing the task_dispatch'
    })
  }
  // Subject + @team is allowed ONLY for `chat` (subject-scoped coordination BROADCAST,
  // fleet-coord stage 3 #3): the relay fans it out only to roster members who OWN the
  // namespace + match interest (per-subscriber `deliverable` gate). A subjected @team of
  // any OTHER kind — notably `task_dispatch` — stays a hard reject: commands must be
  // per-owner direct gated DMs (SUBJECT_ROUTING_SPEC §13.1 R1). Subjected @team chat
  // inherits @team's broadcast delivery model (id-cursor redelivery; delivered_at is an
  // ambient first-delivery flag), so it does NOT reintroduce a per-recipient delivery
  // table. Nullish guard (B2): fire only when subject is set.
  if (e.subject != null && e.to === TEAM_BROADCAST_HANDLE && e.kind !== 'chat') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['subject'],
      message: 'subjected @team is allowed only for chat (commands must be direct, not @team)'
    })
  }
  // Acks/replies (in_reply_to set) are the null-subject channel; forcing this
  // makes the publish-gate null short-circuit what protects the ack channel (M4).
  // UNCHANGED by #3 — a subjected @team chat still cannot be a reply.
  if (e.subject != null && e.in_reply_to != null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['subject'],
      message: 'replies (in_reply_to set) must be subject=null'
    })
  }
})
export type Envelope = z.infer<typeof EnvelopeSchema>

export const OutboundMessageSchema = z.object({
  to: AddressSchema,
  // .default(null) normalizes an omitted subject to null so the nullish guards
  // below (and the publish-gate null short-circuit) behave; without it an omitted
  // subject would be `undefined` and `!= null` would still be correct, but the
  // default keeps the stored/parsed shape consistent with EnvelopeSchema (B2).
  subject: SubjectSchema.nullable().optional().default(null),
  kind: KindSchema,
  content: ContentSchema,
  meta: MetaSchema.optional(),
  in_reply_to: MessageIdSchema.nullable().optional(),
  to_filter: ToFilterSchema.nullable().optional(),
  // Declares that an unqualified @team really is meant for every session on
  // every host. Accepted (and ignored) from the start so the relay can learn
  // the field before any sender uses it — the schema is .strict(), so a peer
  // that sends it to a relay which does not know it gets a 400 and goes quiet.
  // Upgrade order is therefore relay first, senders second.
  fleet_wide: z.boolean().optional(),
  // Acknowledgement (not a selector, §6.1) that a bare-handle chat really is
  // meant for every session on that host, now and later — a durable row
  // fetchSince hands to every sibling that connects after. Chat-only, one
  // concrete handle only (never @team, never with fleet_wide); the relay
  // validates shape/authorization here, liveness is out of scope.
  all_sessions: z.boolean().optional(),
  // Thread continuation (§7, not a reply): names the route the caller sent or
  // holds a grant on. Format-only here — reuses the message-id validator so
  // there is one definition of "a message id" in this file; the relay
  // resolves it to a route and canonicalises to the effective root.
  thread_root: MessageIdSchema.optional()
}).strict().superRefine((e, ctx) => {
  refineToFilter(e, ctx)
  if (e.all_sessions === true) {
    const concreteHandle = e.to !== TEAM_BROADCAST_HANDLE && !e.to.startsWith('@')
    if (e.kind !== 'chat' || !concreteHandle || e.fleet_wide === true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom, path: ['all_sessions'],
        message: 'all_sessions is only allowed for chat to a concrete handle, without fleet_wide'
      })
    }
  }
  // Same @team-subject + ack-channel invariants as EnvelopeSchema, with nullish
  // guards (B2): outbound subject is optional, so `!= null` would misfire on
  // every omitted-subject send (acks, null-subject @team broadcasts) → 400.
  // Subjected @team is allowed only for chat (#3); other kinds (task_dispatch) → 400 R1.
  if (e.subject != null && e.to === TEAM_BROADCAST_HANDLE && e.kind !== 'chat') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['subject'],
      message: 'subjected @team is allowed only for chat (commands must be direct, not @team)'
    })
  }
  if (e.subject != null && e.in_reply_to != null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['subject'],
      message: 'replies (in_reply_to set) must be subject=null'
    })
  }
})
export type OutboundMessage = z.infer<typeof OutboundMessageSchema>

export interface EnvelopeRow {
  id: string
  v: number
  team_id: string
  from_handle: string
  to_handle: string
  subject: string | null
  in_reply_to: string | null
  thread_root: string | null
  kind: Envelope['kind']
  content: string
  meta_json: string
  to_filter_json: string | null
  sent_at: string
  delivered_at: string | null
}

export function envelopeToRow(e: Envelope): EnvelopeRow {
  return {
    id: e.id, v: e.v, team_id: e.team,
    from_handle: e.from, to_handle: e.to, subject: e.subject,
    in_reply_to: e.in_reply_to, thread_root: e.thread_root,
    kind: e.kind, content: e.content,
    meta_json: JSON.stringify(e.meta),
    to_filter_json: e.to_filter == null ? null : JSON.stringify(e.to_filter),
    sent_at: e.sent_at, delivered_at: e.delivered_at
  }
}

export function envelopeFromRow(row: EnvelopeRow): Envelope {
  return EnvelopeSchema.parse({
    id: row.id, v: row.v, team: row.team_id,
    from: row.from_handle, to: row.to_handle, subject: row.subject,
    in_reply_to: row.in_reply_to, thread_root: row.thread_root,
    kind: row.kind, content: row.content,
    meta: JSON.parse(row.meta_json) as Record<string, string>,
    to_filter: row.to_filter_json == null ? null : JSON.parse(row.to_filter_json) as ToFilter,
    sent_at: row.sent_at, delivered_at: row.delivered_at
  })
}
