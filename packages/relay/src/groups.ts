import { DEFAULT_GROUP_ID, type MemberCap } from '@hangar-bridge/shared'
import type { Db } from './db/db.ts'

export type Membership = { group_id: string; caps: Set<MemberCap>; since_msg_id: string }

export function loadMemberships(db: Db, handle: string): Map<string, Membership> {
  const rows = db.prepare(`
    SELECT group_id, caps_json, since_msg_id
    FROM group_member
    WHERE handle=?
    ORDER BY group_id ASC
  `).all(handle) as Array<{ group_id: string; caps_json: string; since_msg_id: string }>
  const result = new Map<string, Membership>()
  for (const row of rows) {
    result.set(row.group_id, {
      group_id: row.group_id,
      caps: new Set(JSON.parse(row.caps_json) as MemberCap[]),
      since_msg_id: row.since_msg_id,
    })
  }
  return result
}

export class MembershipMemo {
  private readonly memo = new Map<string, Map<string, Membership>>()

  constructor(private readonly db: Db) {}

  get(handle: string): Map<string, Membership> {
    let memberships = this.memo.get(handle)
    if (!memberships) {
      memberships = loadMemberships(this.db, handle)
      this.memo.set(handle, memberships)
    }
    return memberships
  }

  clear(): void {
    this.memo.clear()
  }
}

export function loadDefaultGroup(db: Db, handle: string): string {
  const row = db.prepare(
    'SELECT subjects FROM human WHERE team_id=? AND handle=? AND disabled_at IS NULL'
  ).get('hangar', handle) as { subjects: string | null } | undefined
  if (!row?.subjects) return DEFAULT_GROUP_ID
  try {
    const parsed = JSON.parse(row.subjects) as { default_group?: unknown }
    return typeof parsed.default_group === 'string' ? parsed.default_group : DEFAULT_GROUP_ID
  } catch {
    return DEFAULT_GROUP_ID
  }
}

export function members(db: Db, groupId: string): Set<string> {
  const rows = db.prepare(`
    SELECT handle
    FROM group_member
    WHERE group_id=?
    ORDER BY handle ASC
  `).all(groupId) as Array<{ handle: string }>
  return new Set(rows.map(row => row.handle))
}

export function sharedAudience(db: Db, handle: string): Set<string> {
  const rows = db.prepare(`
    SELECT DISTINCT gm2.handle AS handle
    FROM group_member gm
    JOIN group_member gm2 ON gm2.group_id = gm.group_id
    WHERE gm.handle=? AND gm2.handle != ?
    ORDER BY gm2.handle ASC
  `).all(handle, handle) as Array<{ handle: string }>
  return new Set(rows.map(row => row.handle))
}

export function requireCap(
  m: Map<string, Membership>,
  groupId: string,
  cap: MemberCap,
): 'ok' | 'unknown_group' | 'cap_denied' {
  const membership = m.get(groupId)
  if (!membership) return 'unknown_group'
  return membership.caps.has(cap) ? 'ok' : 'cap_denied'
}

export type ReaderScope = { sql: string; params: string[] }

export function readerScope(m: Map<string, Membership>, column = 'group_id', idColumn = 'id'): ReaderScope {
  if (m.size === 0) return { sql: '(0)', params: [] }
  const clauses: string[] = []
  const params: string[] = []
  for (const membership of m.values()) {
    clauses.push(`(${column} = ? AND ${idColumn} > ?)`)
    params.push(membership.group_id, membership.since_msg_id)
  }
  return { sql: `(${clauses.join(' OR ')})`, params }
}
