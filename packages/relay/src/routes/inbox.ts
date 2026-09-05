import { Hono } from 'hono'
import { isValidMessageId } from '@hangar-bridge/shared'
import { bearerAuth, type AuthContext } from '../auth/middleware.ts'
import { rateLimit } from '../middleware/rate-limit.ts'
import type { Deps } from '../deps.ts'

const DEFAULT_LIMIT = 100
const MIN_LIMIT = 1
const MAX_LIMIT = 500

/**
 * REPLY_ROUTING_SPEC.md §8.2 — the operator mailbox pull path. Bearer's own
 * handle only (no cross-handle read); rows are `@mailbox:<handle>`, never
 * fanned out and never stamped `delivered_at` — the client cursor
 * (`since`/`last_id`) is the only progress marker. Reads `limit + 1` rows so
 * `has_more` is a real look-ahead, not a guess from `messages.length === limit`.
 */
export function inboxRoute(deps: Deps) {
  const app = new Hono<{ Variables: AuthContext }>()
  app.use('*', bearerAuth(deps.db))
  app.use('*', rateLimit({ windowMs: 60_000, max: 120, key: c => `inbox:${c.get('token').id}` }))

  app.get('/', c => {
    const since = c.req.query('since') ?? ''
    if (since !== '' && !isValidMessageId(since)) {
      return c.json({ error: 'invalid_since' }, 400)
    }
    const rawLimit = c.req.query('limit')
    let limit = DEFAULT_LIMIT
    if (rawLimit !== undefined) {
      if (!/^[0-9]+$/.test(rawLimit)) return c.json({ error: 'invalid_limit' }, 400)
      limit = Number(rawLimit)
      if (limit < MIN_LIMIT || limit > MAX_LIMIT) return c.json({ error: 'invalid_limit' }, 400)
    }

    const handle = c.get('peer').handle
    const rows = deps.store.fetchMailboxSince(handle, since, limit + 1)
    const has_more = rows.length > limit
    const messages = has_more ? rows.slice(0, limit) : rows
    const last_id = messages.length > 0 ? messages[messages.length - 1]!.id : null

    return c.json({ messages, last_id, has_more })
  })

  return app
}
