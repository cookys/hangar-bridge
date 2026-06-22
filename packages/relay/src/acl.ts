import { ownsNamespace, matchesInterest } from '@hangar-bridge/shared'
import type { Db } from './db/db.ts'

/**
 * Load a handle's OWNED namespace set from the relay DB (human.subjects JSON).
 * Authoritative ACL source — keyed on the AUTHENTICATED handle, never client input.
 * A handle with no subjects row / empty owned ⇒ empty set ⇒ fail-closed for any
 * non-null subject.
 */
export function loadOwnedSet(db: Db, team_id: string, handle: string): Set<string> {
  const row = db.prepare(
    'SELECT subjects FROM human WHERE team_id=? AND handle=?'
  ).get(team_id, handle) as { subjects: string | null } | undefined
  if (!row || !row.subjects) return new Set()
  try {
    const parsed = JSON.parse(row.subjects) as { owned?: unknown }
    return new Set(Array.isArray(parsed.owned) ? parsed.owned.filter(x => typeof x === 'string') as string[] : [])
  } catch {
    return new Set()
  }
}

export { ownsNamespace, matchesInterest }
