import { readFileSync } from 'node:fs'
import { TEAM_BROADCAST_HANDLE, type Envelope, ownsNamespace, matchesInterest } from '@hangar-bridge/shared'

const SUBJECTED_KINDS = new Set(['chat', 'task_dispatch'])

export interface SubjectAclEntry {
  owned: string[]
  interest: string[]
}

export type RosterMap = Record<string, SubjectAclEntry>

export function loadRoster(path: string): RosterMap {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('roster file must be a record keyed by handle')
  }
  const out: RosterMap = {}
  for (const [handle, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
    const ownedRaw = (value as Record<string, unknown>).owned
    const interestRaw = (value as Record<string, unknown>).interest
    const owned = Array.isArray(ownedRaw) ? ownedRaw.filter((x): x is string => typeof x === 'string') : []
    const interest = Array.isArray(interestRaw) ? interestRaw.filter((x): x is string => typeof x === 'string') : []
    out[handle] = { owned, interest }
  }
  return out
}

export type CheckPublishOk = { ok: true }
export type CheckPublishReject = { ok: false; reason: string }
export type CheckPublishResult = CheckPublishOk | CheckPublishReject

export function checkPublish(env: Envelope, roster: RosterMap): CheckPublishResult {
  if (env.subject === null) return { ok: true }
  if (!SUBJECTED_KINDS.has(env.kind)) return { ok: false, reason: 'forbidden_subject' }
  if (!ownsNamespace(env.subject, new Set((roster[env.from]?.owned ?? [])))) {
    return { ok: false, reason: 'forbidden_subject' }
  }
  if (!ownsNamespace(env.subject, new Set((roster[env.to]?.owned ?? [])))) {
    return { ok: false, reason: 'recipient_not_owner' }
  }
  if (env.to === TEAM_BROADCAST_HANDLE) return { ok: false, reason: 'recipient_not_owner' }
  if (env.in_reply_to !== null) return { ok: false, reason: 'in_reply_to_must_be_null' }
  return { ok: true }
}

export function checkDeliver(env: Envelope, localHandle: string, roster: RosterMap): boolean {
  if (env.subject === null) return true
  if (!ownsNamespace(env.subject, new Set((roster[localHandle]?.owned ?? [])))) return false
  const interest = roster[localHandle]?.interest ?? []
  if (!interest.length) return true
  return matchesInterest(env.subject, interest)
}
