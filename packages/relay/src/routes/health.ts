import { Hono } from 'hono'

export const RELAY_VERSION = '0.4.0' as const

export function healthRoute() {
  const app = new Hono()
  const startedAt = Date.now()
  app.get('/', c => c.json({
    ok: true,
    version: RELAY_VERSION,
    uptime_ms: Date.now() - startedAt,
  }))
  return app
}
