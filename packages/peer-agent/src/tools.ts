import { z } from 'zod'
import { ulid } from 'ulid'
import {
  HANDLE_REGEX, TEAM_BROADCAST_HANDLE, SUBJECT_REGEX, MAX_SUBJECT_LENGTH,
  CLAIM_KEY_REGEX, MAX_CLAIM_KEY_LENGTH, MAX_CLAIM_NOTE_LENGTH,
  CLAIM_TTL_MIN_SECONDS, CLAIM_TTL_MAX_SECONDS, CLAIM_DEFAULT_TTL_SECONDS,
  type OutboundMessage, type MessageId,
} from '@hangar-bridge/shared'
import type { ClaimClient, PeerTransport } from './outbound.ts'
import type { PermissionTracker } from './permission.ts'
import type { DispatchTracker } from './correlation.ts'
import type { ReplyLimiter } from './reply-limiter.ts'
import { detectWorkingContext } from './roots.ts'

const AddressSchema = z.union([
  z.string().regex(HANDLE_REGEX),
  z.literal(TEAM_BROADCAST_HANDLE),
])

const SubjectInput = z.string().regex(SUBJECT_REGEX).max(MAX_SUBJECT_LENGTH)
const SendInput = z.object({
  to: AddressSchema,
  content: z.string(),
  subject: SubjectInput.optional(),
  in_reply_to: z.string().optional(),
  meta: z.record(z.string()).optional(),
})
const ListInput = z.object({}).strict()
const SummaryInput = z.object({ summary: z.string().max(200) })
const RespondInput = z.object({
  request_id: z.string().regex(/^[a-km-z]{5}$/i),
  verdict: z.enum(['allow', 'deny']),
  reason: z.string().optional(),
})
const ClaimInput = z.object({
  key: z.string().max(MAX_CLAIM_KEY_LENGTH).regex(CLAIM_KEY_REGEX),
  ttl_seconds: z.number().int().min(CLAIM_TTL_MIN_SECONDS).max(CLAIM_TTL_MAX_SECONDS).optional(),
  note: z.string().max(MAX_CLAIM_NOTE_LENGTH).optional(),
}).strict()
const ListClaimsInput = z.object({}).strict()
const ReleaseClaimInput = z.object({
  key: z.string().max(MAX_CLAIM_KEY_LENGTH).regex(CLAIM_KEY_REGEX),
}).strict()
const ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/i
const DispatchInput = z.object({
  to: AddressSchema,
  payload: z.string(),
  subject: SubjectInput.optional(),
  correlation_id: z.string().regex(ULID_REGEX).optional(),
  // Allow dots so a dotted task_kind (e.g. "mple2.assign") can both label the task
  // and auto-derive the gated subject. Hyphen/uppercase still permitted but won't
  // derive a (lowercase, dot-only) subject — that path falls back to null (R6).
  task_kind: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/).optional(),
})

export const TOOL_DESCRIPTORS = [
  {
    name: 'send_to_peer',
    description: 'Send a message to a teammate (by handle) or the whole team (@team).',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'handle like "alice" or the literal "@team"' },
        content: { type: 'string' },
        subject: { type: 'string', description: 'optional dotted routing subject (e.g. "mple2.command"); publisher must own the namespace. Allowed on @team only for chat, where receivers are filtered by ownership + interest' },
        in_reply_to: { type: 'string', description: 'msg_id being replied to (optional)' },
        meta: { type: 'object', additionalProperties: { type: 'string' } },
      },
      required: ['to', 'content'],
    },
  },
  {
    name: 'list_peers',
    description: 'List team members and their current summaries.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'set_summary',
    description: 'Publish a short summary of what this Claude is working on.',
    inputSchema: {
      type: 'object',
      properties: { summary: { type: 'string' } },
      required: ['summary'],
    },
  },
] as const

export const TOOL_DESCRIPTORS_CLAIMS = [
  {
    name: 'claim_asset',
    description: 'Acquire a cooperative advisory lock on a shared asset (e.g. a file, a repo path, a config) so teammates know you are working on it and avoid a collision (P4). Renews if you already hold it. Returns a conflict (with the current owner + expiry) if another teammate holds a live claim — back off or coordinate. Claims auto-expire after ttl_seconds so a crashed holder never wedges an asset.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'asset identifier, e.g. "repo:llm-playground:configs/foo.toml"' },
        ttl_seconds: { type: 'number', description: `lock lifetime in seconds (default ${CLAIM_DEFAULT_TTL_SECONDS}); auto-releases after this` },
        note: { type: 'string', description: 'optional reason shown to teammates' },
      },
      required: ['key'],
    },
  },
  {
    name: 'list_claims',
    description: 'List all live (non-expired) asset claims across the team, with owner + expiry. Check this before starting work on a shared asset.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'release_claim',
    description: 'Release an asset claim you hold (owner-only). Refused if the claim is held by another live owner.',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string', description: 'the asset key to release' } },
      required: ['key'],
    },
  },
] as const

export const TOOL_DESCRIPTOR_RESPOND = {
  name: 'respond_to_permission',
  description: 'Allow or deny a pending permission_request from a peer. Only valid if a request with this request_id is live.',
  inputSchema: {
    type: 'object',
    properties: {
      request_id: { type: 'string', description: '5-letter ID from the incoming request' },
      verdict: { type: 'string', enum: ['allow', 'deny'] },
      reason: { type: 'string', description: 'optional' },
    },
    required: ['request_id', 'verdict'],
  },
} as const

export const TOOL_DESCRIPTOR_DISPATCH = {
  name: 'dispatch_task',
  description: 'Hand a task off to a teammate (or @team for fanout). The receiver gets a structured task_dispatch keyed by correlation_id. The current MCP surface does not yet expose a structured task_result response tool, so receiver completion comes back as chat. Unlike send_to_peer, dispatch is user-initiated and is NOT throttled by the reply-storm limiter.',
  inputSchema: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'handle like "alice" or the literal "@team"' },
      payload: { type: 'string', description: 'task body — what the peer should do' },
      subject: { type: 'string', description: 'optional dotted routing subject; if omitted it is derived from task_kind (when subject-valid). Gated by the namespace ACL; not used for @team.' },
      correlation_id: { type: 'string', description: 'ULID; auto-generated if omitted. Returned task_result will carry this so you can match the response.' },
      task_kind: { type: 'string', description: 'optional label for the task (e.g. "mple2.assign"); a subject-valid task_kind auto-derives the routing subject' },
    },
    required: ['to', 'payload'],
  },
} as const

export function dispatchToolDescriptor(client: PeerTransport) {
  if (client.capabilities?.teamTaskFanout !== false) return TOOL_DESCRIPTOR_DISPATCH
  return {
    ...TOOL_DESCRIPTOR_DISPATCH,
    description: 'Hand a task off to one concrete teammate. This NATS transport does not advertise @team task fanout because durable WorkQueue consumers are recipient-scoped.',
    inputSchema: {
      ...TOOL_DESCRIPTOR_DISPATCH.inputSchema,
      properties: {
        ...TOOL_DESCRIPTOR_DISPATCH.inputSchema.properties,
        to: { type: 'string', description: 'one concrete peer handle like "alice"; @team is unavailable on this transport' },
      },
    },
  }
}

/**
 * Capability bits this peer-agent binary declares on every presence write.
 *
 * Telemetry gates its DENOMINATOR on these (plan §2.5 / rubric R8): "no
 * disposition was ever reported" is only evidence of a stalled correlation for
 * a peer that declared it understands dispositions. An older binary declares
 * nothing and is simply excluded, instead of manufacturing false alarms during
 * a mixed-version rollout.
 */
export const PEER_CAPS = 'disposition,poll_inbox'

export interface PresenceOpts {
  auto_publish_cwd: boolean
  auto_publish_branch: boolean
  auto_publish_repo: boolean
}

export interface PresenceBody {
  summary: string
  cwd?: string
  branch?: string
  repo?: string
  worktree?: string
  /** Per-process instance id — makes the relay's presence row unique per process. */
  instance?: string
  /** Three-valued inbound-delivery liveness (P2 §2.6). */
  delivery_state?: 'unverified' | 'verified' | 'deaf'
  /** Comma-separated capability bits, e.g. "disposition". Absent ⇒ old binary. */
  caps?: string
}

/**
 * Process-level identity attached to every presence write. Constant for the
 * life of the process (the instance id in particular MUST NOT change across
 * SSE reconnects, or the relay's refcount can never aggregate).
 */
export interface PresenceIdentity {
  instance?: string
  delivery_state?: 'unverified' | 'verified' | 'deaf'
  caps?: string
}

/**
 * Build a presence report body, attaching cwd/branch/repo ONLY when the operator's
 * privacy flags allow AND the detected working context provides them. Shared by the
 * manual `set_summary` tool and the auto-report-on-connect path (index.ts) so both
 * honor the SAME privacy gating — cwd/branch/repo never leak past an opt-out flag.
 */
export function buildPresenceBody(
  presence: PresenceOpts,
  summary: string,
  ctx: { cwd?: string; branch?: string; repo?: string; worktree?: string },
  identity?: PresenceIdentity,
): PresenceBody {
  const body: PresenceBody = { summary }
  if (presence.auto_publish_cwd && ctx.cwd) body.cwd = ctx.cwd
  if (presence.auto_publish_branch && ctx.branch) body.branch = ctx.branch
  if (presence.auto_publish_repo && ctx.repo) body.repo = ctx.repo
  // The worktree name is a path fragment, so it rides the same privacy flag
  // that governs publishing cwd rather than getting a flag of its own.
  if (presence.auto_publish_cwd && ctx.worktree) body.worktree = ctx.worktree
  if (identity?.instance) body.instance = identity.instance
  if (identity?.delivery_state) body.delivery_state = identity.delivery_state
  if (identity?.caps) body.caps = identity.caps
  return body
}

export function registerTools(
  client: PeerTransport,
  presence: PresenceOpts,
  permissionTracker?: PermissionTracker,
  replyLimiter?: ReplyLimiter,
  dispatchTracker?: DispatchTracker,
  claimClient?: ClaimClient,
) {
  const candidate = client as PeerTransport & Partial<ClaimClient>
  const claims = claimClient ?? (
    typeof candidate.claim === 'function'
    && typeof candidate.listClaims === 'function'
    && typeof candidate.releaseClaim === 'function'
      ? candidate as ClaimClient
      : undefined
  )

  async function callTool(name: string, args: unknown): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
    if (name === 'send_to_peer') {
      const input = SendInput.parse(args)
      if (
        replyLimiter
        && typeof input.to === 'string'
        && input.to !== TEAM_BROADCAST_HANDLE
        && !replyLimiter.canReplyTo(input.to)
      ) {
        throw new Error(
          `reply-storm limiter: too many replies to ${input.to} in the current window; ask the user before continuing`,
        )
      }
      const payload: OutboundMessage = {
        to: input.to,
        subject: input.subject ?? null,
        kind: 'chat',
        content: input.content,
        meta: input.meta ?? {},
      }
      if (input.in_reply_to !== undefined) payload.in_reply_to = input.in_reply_to as MessageId
      const env = await client.send(payload)
      if (replyLimiter && typeof input.to === 'string' && input.to !== TEAM_BROADCAST_HANDLE) {
        replyLimiter.recordOutbound(input.to)
      }
      return { content: [{ type: 'text', text: `sent ${env.id}` }] }
    }
    if (name === 'list_peers') {
      ListInput.parse(args)
      const list = await client.listPeers()
      return { content: [{ type: 'text', text: JSON.stringify(list, null, 2) }] }
    }
    if (name === 'set_summary') {
      const input = SummaryInput.parse(args)
      const body = buildPresenceBody(presence, input.summary, detectWorkingContext())
      await client.setPresence(body)
      return { content: [{ type: 'text', text: 'presence updated' }] }
    }
    if (name === 'claim_asset') {
      if (!claims) throw new Error('claim tools unavailable: relay coordination client is not configured')
      const input = ClaimInput.parse(args)
      const body: { key: string; ttl_seconds?: number; note?: string } = { key: input.key }
      if (input.ttl_seconds !== undefined) body.ttl_seconds = input.ttl_seconds
      if (input.note !== undefined) body.note = input.note
      const r = await claims.claim(body)
      if (!r.ok) {
        return { content: [{ type: 'text', text: `claim_conflict: "${input.key}" is held by ${r.conflict.owner} until ${r.conflict.expires_at}` }] }
      }
      const verb = r.renewed ? 'renewed' : 'claimed'
      return { content: [{ type: 'text', text: `${verb} "${r.claim.claim_key}" until ${r.claim.expires_at}` }] }
    }
    if (name === 'list_claims') {
      if (!claims) throw new Error('claim tools unavailable: relay coordination client is not configured')
      ListClaimsInput.parse(args)
      const liveClaims = await claims.listClaims()
      return { content: [{ type: 'text', text: JSON.stringify(liveClaims, null, 2) }] }
    }
    if (name === 'release_claim') {
      if (!claims) throw new Error('claim tools unavailable: relay coordination client is not configured')
      const input = ReleaseClaimInput.parse(args)
      const r = await claims.releaseClaim(input.key)
      if (!r.ok) {
        return { content: [{ type: 'text', text: `cannot release "${input.key}": held by ${r.owner}` }] }
      }
      return { content: [{ type: 'text', text: r.released ? `released "${input.key}"` : `no live claim on "${input.key}"` }] }
    }
    if (name === 'dispatch_task') {
      if (!dispatchTracker) throw new Error('dispatch_task disabled (no DispatchTracker wired)')
      const input = DispatchInput.parse(args)
      if (input.to === TEAM_BROADCAST_HANDLE && client.capabilities?.teamTaskFanout === false) {
        throw new Error('dispatch_task to @team is unavailable on NATS; choose a concrete peer handle')
      }
      const correlation_id = (input.correlation_id ?? ulid()).toUpperCase()
      // K5: intentionally skip replyLimiter.canReplyTo + recordOutbound for the
      // dispatch path. dispatch_task is user-initiated work, not a bot reply,
      // so the reply-storm limiter must NOT throttle it.
      //
      // Note: the *receiving* side (inbound.ts) still calls
      // replyLimiter.recordInbound(e.from) for every envelope including
      // task_result. That's by design — inbound recording just resets the
      // sender's window counter; the K5 worry is throttling OUTBOUND, and we
      // skip that here.
      const meta: Record<string, string> = { correlation_id }
      if (input.task_kind !== undefined) meta.task_kind = input.task_kind
      // Command coupling (C1): the ACL gates `subject`, so derive it from task_kind
      // when not given. Non-fatal (R6): if task_kind is absent or not subject-valid
      // (uppercase/hyphen/…), fall back to subject=null (legacy ungated dispatch)
      // rather than erroring. Never derive for @team (direct-only invariant, R1).
      let subject: string | null = input.subject ?? null
      if (subject === null && input.to !== TEAM_BROADCAST_HANDLE && input.task_kind !== undefined) {
        const candidate = input.task_kind.toLowerCase()
        if (SUBJECT_REGEX.test(candidate)) {
          subject = candidate
          meta.task_kind = candidate  // keep the display label consistent with the derived route key
        }
      }
      const payload: OutboundMessage = {
        to: input.to,
        subject,
        kind: 'task_dispatch',
        content: input.payload,
        meta,
      }
      const env = await client.send(payload, { idempotency_key: correlation_id })
      dispatchTracker.recordOutgoing(correlation_id, env.id, input.to)
      return { content: [{ type: 'text', text: `dispatched ${env.id} correlation_id=${correlation_id}` }] }
    }
    if (name === 'respond_to_permission') {
      if (!permissionTracker) throw new Error('permission relay disabled')
      const input = RespondInput.parse(args)
      const msg_id = permissionTracker.msgIdFor(input.request_id)
      if (!msg_id) throw new Error(`unknown or expired request_id: ${input.request_id}`)
      const sender = permissionTracker.senderFor(input.request_id)
      if (!sender) throw new Error(`no sender for ${input.request_id}`)
      const meta: Record<string, string> = {
        request_id: input.request_id.toLowerCase(),
        behavior: input.verdict,
      }
      if (input.reason !== undefined) meta.reason = input.reason
      await client.send({
        to: sender,
        subject: null,
        kind: 'permission_verdict',
        in_reply_to: msg_id as MessageId,
        content: '',
        meta,
      })
      return { content: [{ type: 'text', text: `verdict sent: ${input.verdict}` }] }
    }
    throw new Error(`unknown tool: ${name}`)
  }
  return { callTool }
}
