import { Hono } from 'hono'
import { HANGAR_TEAM_ID } from '@hangar-bridge/shared'
import { bearerAuth, type AuthContext } from '../auth/middleware.ts'
import type { Deps } from '../deps.ts'

const TTL_MS = 2_000

interface HumanRow {
  id: string
  handle: string
  display_name: string
}

export function peersRoute(deps: Deps) {
  const app = new Hono<{ Variables: AuthContext }>()
  app.use('*', bearerAuth(deps.db))

  let cached: { at: number; body: string } | null = null

  app.get('/', c => {
    if (cached && Date.now() - cached.at < TTL_MS) {
      return c.body(cached.body, 200, { 'content-type': 'application/json' })
    }
    const humans = deps.db.prepare(
      "SELECT id, handle, display_name FROM human WHERE team_id=? AND disabled_at IS NULL"
    ).all(HANGAR_TEAM_ID) as HumanRow[]

    const list = humans.map(h => {
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
      }
    })
    const body = JSON.stringify(list)
    cached = { at: Date.now(), body }
    return c.body(body, 200, { 'content-type': 'application/json' })
  })
  return app
}
