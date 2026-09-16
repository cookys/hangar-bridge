import { Hono } from 'hono'
import { HANGAR_TEAM_ID } from '@hangar-bridge/shared'
import { bearerAuth, type AuthContext } from '../auth/middleware.ts'
import type { Deps } from '../deps.ts'
import { loadMemberships, sharedAudience } from '../groups.ts'

const TTL_MS = 2_000

interface HumanRow {
  id: string
  handle: string
  display_name: string
}

export function peersRoute(deps: Deps) {
  const app = new Hono<{ Variables: AuthContext }>()
  app.use('*', bearerAuth(deps.db))

  const cached = new Map<string, { at: number; body: string }>()

  app.get('/', c => {
    const reader = c.get('peer').handle
    const readerMemberships = loadMemberships(deps.db, reader)
    const cacheKey = [...readerMemberships.keys()].sort().join('\0')
    const hit = cached.get(cacheKey)
    if (hit && Date.now() - hit.at < TTL_MS) {
      return c.body(hit.body, 200, { 'content-type': 'application/json' })
    }
    const visible = (deps.groupsMode ?? 'legacy') === 'strict'
      ? new Set([...sharedAudience(deps.db, reader), reader])
      : null
    const humans = deps.db.prepare(
      "SELECT id, handle, display_name FROM human WHERE team_id=? AND disabled_at IS NULL"
    ).all(HANGAR_TEAM_ID) as HumanRow[]

    const list = humans.filter(h => visible === null || visible.has(h.handle)).map(h => {
      const peerMemberships = loadMemberships(deps.db, h.handle)
      const groups = [...peerMemberships.values()]
        .filter(m => h.handle === reader || readerMemberships.has(m.group_id))
        .map(m => ({ id: m.group_id, caps: [...m.caps] }))
      const snap = deps.presence.get(HANGAR_TEAM_ID, h.handle)
      // Presence (a heartbeat POST) and a live SSE subscription are two
      // different facts, and a session can hold the first without the second —
      // it then reads as online while nothing can reach it. Report the
      // subscriber count per instance so the difference is visible from any
      // host: 1 is healthy, 0 is a session nothing can reach, >1 is a leak.
      const subs = deps.fanout.instanceCounts(HANGAR_TEAM_ID, h.handle)
      let subscribed = 0
      for (const n of subs.values()) subscribed += n
      const sessions = (snap?.sessions ?? []).map(s => (
        s.instance === undefined ? s : { ...s, subscriptions: subs.get(s.instance) ?? 0 }
      ))
      return {
        handle: h.handle,
        display_name: h.display_name,
        online: Boolean(snap),
        summary: snap?.summary ?? '',
        last_seen: snap?.last_seen ?? null,
        subscribed,
	        sessions,
	        groups,
	      }
	    })
	    const body = JSON.stringify(list)
	    cached.set(cacheKey, { at: Date.now(), body })
    return c.body(body, 200, { 'content-type': 'application/json' })
  })
  return app
}
