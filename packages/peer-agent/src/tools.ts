import { z } from 'zod'
import { ulid } from 'ulid'
import { HANDLE_REGEX, TEAM_BROADCAST_HANDLE, type OutboundMessage, type MessageId } from '@hangar-bridge/shared'
import type { RelayClient } from './outbound.ts'
import type { PermissionTracker } from './permission.ts'
import type { DispatchTracker } from './correlation.ts'
import type { ReplyLimiter } from './reply-limiter.ts'
import { detectWorkingContext } from './roots.ts'

const AddressSchema = z.union([
  z.string().regex(HANDLE_REGEX),
  z.literal(TEAM_BROADCAST_HANDLE),
])

const SendInput = z.object({
  to: AddressSchema,
  content: z.string(),
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
const ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/i
const DispatchInput = z.object({
  to: AddressSchema,
  payload: z.string(),
  correlation_id: z.string().regex(ULID_REGEX).optional(),
  task_kind: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/).optional(),
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
  description: 'Hand a task off to a teammate (or @team for fanout). The result returns as a task_result channel notification keyed by correlation_id. Unlike send_to_peer, this is user-initiated and is NOT throttled by the reply-storm limiter.',
  inputSchema: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'handle like "alice" or the literal "@team"' },
      payload: { type: 'string', description: 'task body — what the peer should do' },
      correlation_id: { type: 'string', description: 'ULID; auto-generated if omitted. Returned task_result will carry this so you can match the response.' },
      task_kind: { type: 'string', description: 'optional label for the task (e.g. "code-review", "build-check")' },
    },
    required: ['to', 'payload'],
  },
} as const

export interface PresenceOpts {
  auto_publish_cwd: boolean
  auto_publish_branch: boolean
  auto_publish_repo: boolean
}

export function registerTools(
  client: RelayClient,
  presence: PresenceOpts,
  permissionTracker?: PermissionTracker,
  replyLimiter?: ReplyLimiter,
  dispatchTracker?: DispatchTracker,
) {
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
      const ctx = detectWorkingContext()
      const body: { summary: string; cwd?: string; branch?: string; repo?: string } = { summary: input.summary }
      if (presence.auto_publish_cwd && ctx.cwd) body.cwd = ctx.cwd
      if (presence.auto_publish_branch && ctx.branch) body.branch = ctx.branch
      if (presence.auto_publish_repo && ctx.repo) body.repo = ctx.repo
      await client.setPresence(body)
      return { content: [{ type: 'text', text: 'presence updated' }] }
    }
    if (name === 'dispatch_task') {
      if (!dispatchTracker) throw new Error('dispatch_task disabled (no DispatchTracker wired)')
      const input = DispatchInput.parse(args)
      const correlation_id = (input.correlation_id ?? ulid()).toUpperCase()
      // K5: intentionally skip replyLimiter.canReplyTo + recordOutbound for the
      // dispatch path. dispatch_task is user-initiated work, not a bot reply,
      // so the reply-storm limiter must NOT throttle it.
      const meta: Record<string, string> = { correlation_id }
      if (input.task_kind !== undefined) meta.task_kind = input.task_kind
      const payload: OutboundMessage = {
        to: input.to,
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
