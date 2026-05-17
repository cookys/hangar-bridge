import { describe, it, expect, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { openDatabase, type Db } from '../db/db.ts'
import { hashToken, generateRawToken } from './hash.ts'
import { bearerAuth, type AuthContext } from './middleware.ts'
import { seedPeers } from './peers-file.ts'

function seedPeer(db: Db, handle: string = 'alice') {
  const raw = generateRawToken()
  const hashHex = hashToken(raw).toString('hex')
  seedPeers(db, [{ handle, secret_sha256_hex: hashHex, display_name: handle }])
  return raw
}

/**
 * Layer 1 of the 5-layer auth defense — Bearer-token gate.
 * Each peer has its own raw secret in ~/.config/hangar-bridge/secret; the
 * relay's peers.json maps SHA256(secret) → handle. The middleware looks up
 * by hash with a timing-safe compare and stamps `c.get('peer')` so
 * downstream routes can drive Layer 2 (sender-stamp anti-spoof).
 */
describe('bearerAuth middleware — Layer 1 (Bearer + SHA256 + timing-safe)', () => {
  let db: Db
  let app: Hono<{ Variables: AuthContext }>
  beforeEach(() => {
    db = openDatabase(':memory:')
    app = new Hono<{ Variables: AuthContext }>()
    app.use('*', bearerAuth(db))
    app.get('/ok', c => c.json({ from: c.get('peer').handle, label: c.get('token').label }))
  })

  it('accepts a valid peer secret', async () => {
    const raw = seedPeer(db)
    const res = await app.request('/ok', { headers: { authorization: `Bearer ${raw}` } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ from: 'alice', label: 'shared-secret' })
  })

  it('rejects missing Authorization header with 401', async () => {
    const res = await app.request('/ok')
    expect(res.status).toBe(401)
  })

  it('rejects malformed Authorization header with 401', async () => {
    const res = await app.request('/ok', { headers: { authorization: 'Basic xxx' } })
    expect(res.status).toBe(401)
  })

  it('rejects unknown bearer with 401', async () => {
    seedPeer(db)
    const res = await app.request('/ok', { headers: { authorization: `Bearer ${generateRawToken()}` } })
    expect(res.status).toBe(401)
  })

  it('rejects revoked token with 401 (rotation: seedPeers replaces token_hash)', async () => {
    const raw = seedPeer(db)
    db.prepare("UPDATE token SET revoked_at=? WHERE token_hash=?")
      .run(new Date().toISOString(), hashToken(raw))
    const res = await app.request('/ok', { headers: { authorization: `Bearer ${raw}` } })
    expect(res.status).toBe(401)
  })

  it('rejects disabled peer with 401', async () => {
    const raw = seedPeer(db)
    db.prepare("UPDATE human SET disabled_at=? WHERE handle=?")
      .run(new Date().toISOString(), 'alice')
    const res = await app.request('/ok', { headers: { authorization: `Bearer ${raw}` } })
    expect(res.status).toBe(401)
  })

  it('401 response never echoes the token or indicates team existence', async () => {
    const res = await app.request('/ok', { headers: { authorization: 'Bearer leaked-token-value' } })
    const text = await res.text()
    expect(text).not.toContain('leaked-token-value')
    expect(text).not.toContain('team')
  })
})
