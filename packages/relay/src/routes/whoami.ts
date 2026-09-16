import { Hono } from 'hono'
import { HANGAR_TEAM_ID } from '@hangar-bridge/shared'
import { bearerAuth, type AuthContext } from '../auth/middleware.ts'
import type { Deps } from '../deps.ts'
import { loadDefaultGroup } from '../groups.ts'

export function whoamiRoute(deps: Deps) {
  const app = new Hono<{ Variables: AuthContext }>()
  app.use('*', bearerAuth(deps.db))

  app.get('/', c => {
    const handle = c.get('peer').handle
    const rows = deps.db.prepare(`
      SELECT gm.group_id AS id, gm.caps_json, pg.history
      FROM group_member gm
      JOIN peer_group pg ON pg.id = gm.group_id
      WHERE gm.handle=?
      ORDER BY gm.group_id ASC
    `).all(handle) as Array<{ id: string; caps_json: string; history: string }>
    return c.json({
      handle,
      default_group: loadDefaultGroup(deps.db, handle),
      groups: rows.map(row => ({
        id: row.id,
        caps: JSON.parse(row.caps_json) as string[],
        history: row.history,
      })),
    })
  })

  return app
}
