import { readFileSync } from 'node:fs'
import { z } from 'zod'
import {
  HANDLE_REGEX,
  INTEREST_REGEX,
  NAMESPACE_REGEX,
  TEAM_BROADCAST_HANDLE,
  type Envelope,
  ownsNamespace,
  matchesInterest,
} from '@hangar-bridge/shared'

const SUBJECTED_KINDS = new Set(['chat', 'task_dispatch'])

export interface SubjectAclEntry {
  display_name?: string
  owned: string[]
  interest: string[]
}

export type RosterMap = Record<string, SubjectAclEntry>

const FleetHandleSchema = z.string()
  .regex(HANDLE_REGEX)
  .refine(handle => handle !== 'team', 'team is reserved for the broadcast lane')

const RosterEntrySchema = z.object({
  display_name: z.string().min(1).max(128).optional(),
  owned: z.array(z.string().regex(NAMESPACE_REGEX)),
  interest: z.array(z.string().regex(INTEREST_REGEX)),
}).strict()

const RosterFileSchema = z.record(FleetHandleSchema, RosterEntrySchema)

export function loadRoster(path: string): RosterMap {
  const parsed = RosterFileSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
  const out: RosterMap = {}
  for (const [handle, value] of Object.entries(parsed)) {
    out[handle] = {
      ...(value.display_name ? { display_name: value.display_name } : {}),
      owned: value.owned,
      interest: value.interest,
    }
  }
  return out
}

export type CheckPublishOk = { ok: true }
export type CheckPublishReject = { ok: false; reason: string }
export type CheckPublishResult = CheckPublishOk | CheckPublishReject

export function checkPublish(env: Envelope, roster: RosterMap): CheckPublishResult {
  if (!Object.prototype.hasOwnProperty.call(roster, env.from)) {
    return { ok: false, reason: 'unknown_sender' }
  }
  if (
    env.to !== TEAM_BROADCAST_HANDLE
    && !Object.prototype.hasOwnProperty.call(roster, env.to)
  ) {
    return { ok: false, reason: 'unknown_recipient' }
  }
  if (env.subject === null) return { ok: true }
  if (!SUBJECTED_KINDS.has(env.kind)) return { ok: false, reason: 'forbidden_subject' }
  if (!ownsNamespace(env.subject, new Set((roster[env.from]?.owned ?? [])))) {
    return { ok: false, reason: 'forbidden_subject' }
  }
  if (env.in_reply_to !== null) return { ok: false, reason: 'in_reply_to_must_be_null' }
  // Fleet-coordination stage3 permits subject-scoped @team CHAT. There is no
  // synthetic `@team` roster owner: each receiver is filtered independently by
  // checkDeliver (owned namespace + interest). Task broadcasts remain forbidden.
  if (env.to === TEAM_BROADCAST_HANDLE) {
    return env.kind === 'chat'
      ? { ok: true }
      : { ok: false, reason: 'forbidden_subject' }
  }
  if (!ownsNamespace(env.subject, new Set((roster[env.to]?.owned ?? [])))) {
    return { ok: false, reason: 'recipient_not_owner' }
  }
  return { ok: true }
}

export function checkDeliver(env: Envelope, localHandle: string, roster: RosterMap): boolean {
  if (env.subject === null) return true
  if (!ownsNamespace(env.subject, new Set((roster[localHandle]?.owned ?? [])))) return false
  const interest = roster[localHandle]?.interest ?? []
  if (!interest.length) return true
  return matchesInterest(env.subject, interest)
}
