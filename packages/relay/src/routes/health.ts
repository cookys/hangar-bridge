import { Hono } from 'hono'

export const RELAY_VERSION = '0.4.0' as const
const FULL_GIT_SHA = /^[0-9a-f]{40}$/i

function buildRevision(value = process.env.HANGAR_BUILD_REVISION): string {
  return value !== undefined && FULL_GIT_SHA.test(value)
    ? value.toLowerCase()
    : 'unknown'
}

export function healthRoute() {
  const app = new Hono()
  const startedAt = Date.now()
  const revision = buildRevision()
  app.get('/', c => c.json({
    ok: true,
    version: RELAY_VERSION,
    build_revision: revision,
    uptime_ms: Date.now() - startedAt,
  }))
  return app
}
