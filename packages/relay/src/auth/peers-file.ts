import { readFileSync, existsSync } from 'node:fs'
import { z } from 'zod'
import { ulid } from 'ulid'
import { HANGAR_TEAM_ID, HANDLE_REGEX } from '@hangar-bridge/shared'
import type { Db } from '../db/db.ts'

const PeerEntrySchema = z.object({
  secret_sha256_hex: z.string().regex(/^[0-9a-f]{64}$/, 'must be 64 lowercase hex chars (SHA-256)'),
  display_name: z.string().min(1).max(128).optional(),
})
export const PeersFileSchema = z.record(z.string().regex(HANDLE_REGEX), PeerEntrySchema)
export type PeersFile = z.infer<typeof PeersFileSchema>

export interface PeerEntry {
  handle: string
  secret_sha256_hex: string
  display_name: string
}

export function loadPeersFile(path: string): PeerEntry[] {
  if (!existsSync(path)) {
    throw new Error(
      `peers file not found at ${path}. ` +
      `Generate it from each peer's ~/.config/hangar-bridge/secret: ` +
      `for each peer, SHA-256 the secret and write {handle: {secret_sha256_hex}} to this file (mode 0600).`
    )
  }
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  const parsed = PeersFileSchema.parse(raw)
  return Object.entries(parsed).map(([handle, entry]) => ({
    handle,
    secret_sha256_hex: entry.secret_sha256_hex,
    display_name: entry.display_name ?? handle,
  }))
}

/**
 * Replaces upstream's pair-code flow. Reads peers.json at relay startup and
 * upserts `human` + `token` rows so the bearer middleware can lookup by hash
 * exactly as before. The pre-seeded `team('hangar')` row is provided by the
 * schema (D10 stub posture).
 *
 * Idempotent: re-running with the same peers leaves the DB unchanged; rotating
 * a peer's secret updates that peer's token_hash and revokes the old token.
 */
export function seedPeers(db: Db, peers: PeerEntry[], now: Date = new Date()): void {
  const nowIso = now.toISOString()
  const tx = db.transaction(() => {
    for (const peer of peers) {
      const hash = Buffer.from(peer.secret_sha256_hex, 'hex')
      const existingHuman = db.prepare(
        "SELECT id FROM human WHERE team_id=? AND handle=?"
      ).get(HANGAR_TEAM_ID, peer.handle) as { id: string } | undefined

      const humanId = existingHuman?.id ?? `h_${ulid()}`
      if (!existingHuman) {
        db.prepare(
          "INSERT INTO human(id,team_id,handle,display_name,created_at,last_active_at) VALUES (?,?,?,?,?,?)"
        ).run(humanId, HANGAR_TEAM_ID, peer.handle, peer.display_name, nowIso, nowIso)
      } else {
        db.prepare(
          "UPDATE human SET display_name=?, disabled_at=NULL WHERE id=?"
        ).run(peer.display_name, humanId)
      }

      const existingToken = db.prepare(
        "SELECT id, token_hash FROM token WHERE human_id=? AND revoked_at IS NULL"
      ).get(humanId) as { id: string; token_hash: Buffer } | undefined

      if (!existingToken || !existingToken.token_hash.equals(hash)) {
        if (existingToken) {
          db.prepare("UPDATE token SET revoked_at=? WHERE id=?").run(nowIso, existingToken.id)
        }
        db.prepare(
          "INSERT INTO token(id,human_id,token_hash,label,tier,created_at) VALUES (?,?,?,?,?,?)"
        ).run(`tk_${ulid()}`, humanId, hash, 'shared-secret', 'admin', nowIso)
      }
    }
  })
  tx()
}
