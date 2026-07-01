import { describe, it, expect, beforeEach } from 'vitest'
import { openDatabase, type Db } from '../../src/db/db.ts'
import { MessageStore } from '../../src/messages/store.ts'
import { Fanout } from '../../src/fanout.ts'
import { PresenceRegistry } from '../../src/presence/registry.ts'
import { buildApp } from '../../src/app.ts'
import { RELAY_VERSION } from '../../src/routes/health.ts'
import { ClaimStore } from '../../src/claims/store.ts'

describe('GET /health', () => {
  let db: Db
  let app: ReturnType<typeof buildApp>
  beforeEach(() => {
    db = openDatabase(':memory:')
    app = buildApp({
      db,
      store: new MessageStore(db),
      fanout: new Fanout(),
      presence: new PresenceRegistry(), claims: new ClaimStore(db),
      now: () => new Date(),
    })
  })

  it('returns 200 with ok:true + version + uptime_ms — NO bearer required', async () => {
    const res = await app.request('/health')
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; version: string; uptime_ms: number }
    expect(body.ok).toBe(true)
    expect(body.version).toBe(RELAY_VERSION)
    expect(typeof body.uptime_ms).toBe('number')
    expect(body.uptime_ms).toBeGreaterThanOrEqual(0)
  })

  it('rejects no path that requires auth (sanity — confirms /health bypass is local)', async () => {
    const res = await app.request('/v1/peers')
    expect(res.status).toBe(401)
  })

  it('still works when an Authorization header is present but invalid (health is unconditionally public)', async () => {
    const res = await app.request('/health', { headers: { authorization: 'Bearer not-a-real-token' } })
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean }
    expect(body.ok).toBe(true)
  })
})
