import { z } from 'zod'
import {
  HANDLE_REGEX, META_KEY_REGEX, MAX_CONTENT_BYTES,
  MAX_META_KEY_LENGTH, MAX_META_VALUE_LENGTH,
  PROTOCOL_VERSION, TEAM_BROADCAST_HANDLE,
  SUBJECT_REGEX, MAX_SUBJECT_LENGTH
} from './constants.ts'

export const SubjectSchema = z.string().regex(SUBJECT_REGEX).max(MAX_SUBJECT_LENGTH)

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
  sent_at: z.string().datetime(),
  delivered_at: z.string().datetime().nullable()
}).superRefine((e, ctx) => {
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
  // Subjects are DIRECT-ONLY: a subjected message must target a concrete handle,
  // never @team (keeps the single delivered_at flag correct; @team stays legacy
  // null-subject fan-out). Nullish guard (B2): fire only when subject is set.
  if (e.subject != null && e.to === TEAM_BROADCAST_HANDLE) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['subject'],
      message: 'subjected messages must target a concrete handle, not @team'
    })
  }
  // Acks/replies (in_reply_to set) are the null-subject channel; forcing this
  // makes the publish-gate null short-circuit what protects the ack channel (M4).
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
  in_reply_to: MessageIdSchema.nullable().optional()
}).strict().superRefine((e, ctx) => {
  // Same direct-only + ack-channel invariants as EnvelopeSchema, with nullish
  // guards (B2): outbound subject is optional, so `!== null` would misfire on
  // every omitted-subject send (acks, null-subject @team broadcasts) → 400.
  if (e.subject != null && e.to === TEAM_BROADCAST_HANDLE) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['subject'],
      message: 'subjected messages must target a concrete handle, not @team'
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
    sent_at: row.sent_at, delivered_at: row.delivered_at
  })
}
