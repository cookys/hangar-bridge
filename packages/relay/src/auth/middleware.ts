import type { MiddlewareHandler } from 'hono'
import type { Db } from '../db/db.ts'
import { hashToken, timingSafeEqual } from './hash.ts'

export interface TokenRecord {
  id: string
  human_id: string
  label: string
}

/**
 * Authenticated peer identity attached to the Hono context.
 *
 * Renamed from upstream's `HumanRecord` per C1: hangar-bridge talks to *peer
 * hosts in the fleet*, not human chat users. The SQL table name stays `human`
 * (D10/C1) so this is purely a TS identifier change with zero migration risk.
 */
export interface PeerRecord {
  id: string
  handle: string
  display_name: string
}

export interface AuthContext {
  token: TokenRecord
  peer: PeerRecord
}

interface AuthRow {
  token_id: string
  human_id: string
  label: string
  token_hash: Buffer
  revoked_at: string | null
  handle: string
  display_name: string
  disabled_at: string | null
}

/**
 * Layer 1 of the 5-layer auth defense — Bearer-token gate.
 *
 * - Single-tenant: every authenticated request implicitly binds to
 *   `HANGAR_TEAM_ID = 'hangar'` (D10 stub posture). No tier hierarchy —
 *   upstream's `requireTier: 'human' | 'admin'` selector is gone with the
 *   admin route.
 * - The bearer is the contents of each peer's
 *   `~/.config/hangar-bridge/secret` file (43-char URL-safe base64). Each
 *   peer holds its OWN secret; the relay's peers.json maps SHA256(secret) →
 *   handle. On startup the relay seeds `human` + `token` rows from
 *   peers.json, so this lookup pattern (timing-safe compare against an
 *   indexed hash) stays identical to upstream's DB-bearer flow.
 * - Layer 2 (sender-stamp anti-spoof) lives downstream: `c.set('peer', ...)`
 *   is the only way routes learn the requester's identity; client-supplied
 *   `from` is ignored.
 */
export function bearerAuth(
  db: Db
): MiddlewareHandler<{ Variables: AuthContext }> {
  const stmt = db.prepare(`
    SELECT t.id AS token_id, t.human_id, t.label, t.token_hash, t.revoked_at,
           h.handle, h.display_name, h.disabled_at
    FROM token t JOIN human h ON h.id = t.human_id
    WHERE t.token_hash = ?
  `)

  return async (c, next) => {
    const header = c.req.header('authorization') ?? ''
    const m = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header)
    if (!m) return c.json({ error: 'unauthorized' }, 401)

    const raw = m[1]!
    const hash = hashToken(raw)

    const row = stmt.get(hash) as AuthRow | undefined
    if (!row) return c.json({ error: 'unauthorized' }, 401)
    // Defense-in-depth: timing-safe compare even after the indexed lookup.
    if (!timingSafeEqual(row.token_hash, hash)) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    if (row.revoked_at !== null) return c.json({ error: 'unauthorized' }, 401)
    if (row.disabled_at !== null) return c.json({ error: 'unauthorized' }, 401)

    db.prepare('UPDATE human SET last_active_at=? WHERE id=?')
      .run(new Date().toISOString(), row.human_id)

    c.set('token', { id: row.token_id, human_id: row.human_id, label: row.label })
    c.set('peer', {
      id: row.human_id,
      handle: row.handle,
      display_name: row.display_name,
    })
    return next()
  }
}
