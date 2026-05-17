import type { Db } from '../../src/db/db.ts'
import { generateRawToken, hashToken } from '../../src/auth/hash.ts'
import { seedPeers } from '../../src/auth/peers-file.ts'

export interface SeededPeer {
  handle: string
  token: string
}

/**
 * Seeds the hangar-bridge DB with N peers under the singleton `'hangar'`
 * team_id (D10 stub posture). Returns the raw secret for each peer so tests
 * can authenticate as that peer.
 */
export function seedPeerSecrets(db: Db, handles: string[]): Record<string, SeededPeer> {
  const out: Record<string, SeededPeer> = {}
  const entries = handles.map(handle => {
    const raw = generateRawToken()
    out[handle] = { handle, token: raw }
    return { handle, secret_sha256_hex: hashToken(raw).toString('hex'), display_name: handle }
  })
  seedPeers(db, entries)
  return out
}
