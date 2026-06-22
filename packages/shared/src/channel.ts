import { META_KEY_REGEX, CHANNEL_SOURCE_PEERS, RESERVED_META_KEYS } from './constants.ts'
import type { Envelope } from './envelope.ts'

export interface ChannelNotification {
  method: string
  params: {
    content: string
    meta: Record<string, string>
    // The authentic, relay-stamped gated subject. Set from `e.subject` (envelope
    // field), NEVER from sender meta — so a receiver can trust it as the command
    // routing key (B1). The relay strips reserved meta keys at publish, and
    // sanitizeMeta drops them too (defense in depth).
    gated_subject?: string
    request_id?: string
    tool_name?: string
    description?: string
    input_preview?: string
    behavior?: 'allow' | 'deny'
    correlation_id?: string
  }
}

export function envelopeToChannelNotification(e: Envelope): ChannelNotification {
  const safeMeta = sanitizeMeta(e.meta)

  if (e.kind === 'permission_request') {
    return {
      method: 'notifications/claude/channel/permission_request',
      params: {
        content: e.content,
        meta: safeMeta,
        request_id: safeMeta.request_id ?? '',
        tool_name: safeMeta.tool_name ?? '',
        description: e.content,
        input_preview: safeMeta.input_preview ?? ''
      }
    }
  }

  if (e.kind === 'permission_verdict') {
    return {
      method: 'notifications/claude/channel/permission',
      params: {
        content: '',
        meta: safeMeta,
        request_id: safeMeta.request_id ?? '',
        behavior: safeMeta.behavior === 'deny' ? 'deny' : 'allow'
      }
    }
  }

  if (e.kind === 'task_result') {
    return {
      method: 'notifications/claude/channel',
      params: {
        content: escapeChannelBody(e.content),
        meta: {
          from: e.from,
          msg_id: e.id,
          ...(e.in_reply_to ? { in_reply_to: e.in_reply_to } : {}),
          ...(e.thread_root ? { thread_root: e.thread_root } : {}),
          source: CHANNEL_SOURCE_PEERS,
          kind: 'task_result',
          ...safeMeta
        },
        ...(e.subject ? { gated_subject: e.subject } : {}),
        correlation_id: safeMeta.correlation_id ?? (e.in_reply_to ?? '')
      }
    }
  }

  return {
    method: 'notifications/claude/channel',
    params: {
      content: escapeChannelBody(e.content),
      meta: {
        from: e.from,
        msg_id: e.id,
        ...(e.in_reply_to ? { in_reply_to: e.in_reply_to } : {}),
        ...(e.thread_root ? { thread_root: e.thread_root } : {}),
        source: CHANNEL_SOURCE_PEERS,
        ...(e.kind === 'task_dispatch' ? { kind: 'task_dispatch' } : {}),
        ...safeMeta
      },
      ...(e.subject ? { gated_subject: e.subject } : {})
    }
  }
}

const RESERVED = new Set<string>(RESERVED_META_KEYS)
function sanitizeMeta(meta: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(meta)) {
    // Drop reserved keys (subject/kind/task_kind) so a forged sender-meta key can
    // never masquerade as a relay-stamped routing/command signal (B1).
    if (RESERVED.has(k)) continue
    if (META_KEY_REGEX.test(k)) out[k] = escapeChannelAttr(v)
  }
  return out
}

export function escapeChannelAttr(s: string): string {
  return s.replace(/[<>&"]/g, c =>
    c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '&' ? '&amp;' : '&quot;')
}

export function escapeChannelBody(s: string): string {
  return s.replace(/[<>&]/g, c =>
    c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&amp;')
}
