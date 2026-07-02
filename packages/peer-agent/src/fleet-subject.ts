import { TEAM_BROADCAST_HANDLE, type Envelope } from '@hangar-bridge/shared'

// Wire recipient token for a broadcast. The ENVELOPE `to` uses TEAM_BROADCAST_HANDLE
// ('@team'); the WIRE subject uses the bare token 'team' (no '@', per §2.6). parse
// returns the RAW wire token so callers (nats-transport) route on the wire form and
// map to '@team' only when materialising the envelope `to`.
const TEAM_RECIPIENT = 'team' as const

const KINDS = [
  'chat',
  'presence_update',
  'permission_request',
  'permission_verdict',
  'task_dispatch',
  'task_result',
] as const

const KIND_SET = new Set(KINDS)

export type EnvelopeKind = typeof KINDS[number]

export function buildFleetSubject(sender: string, recipient: string, kind: Envelope['kind']): string {
  const wireRecipient = recipient === TEAM_BROADCAST_HANDLE ? TEAM_RECIPIENT : recipient
  return `fleet.${sender}.to.${wireRecipient}.${kind}`
}

export interface ParsedFleetSubject {
  sender: string
  recipient: string
  kind: EnvelopeKind
}

export function parseFleetSubject(subject: string): ParsedFleetSubject | null {
  const parts = subject.split('.')
  if (parts.length !== 5) return null
  const [ns, sender, to, recipient, kind] = parts as [string, string, string, string, string]
  if (ns.length === 0 || sender.length === 0 || recipient.length === 0) return null
  if (ns !== 'fleet') return null
  if (to !== 'to') return null
  if (!KIND_SET.has(kind as EnvelopeKind)) return null
  // recipient is the RAW wire token ('team' for a broadcast, else a handle); callers
  // map 'team' → TEAM_BROADCAST_HANDLE when building the envelope `to`.
  return { sender, recipient, kind: kind as EnvelopeKind }
}

export function deriveFrom(subject: string): string | null {
  const parsed = parseFleetSubject(subject)
  return parsed ? parsed.sender : null
}
