import type { Db } from '../db/db.ts'
import { loadPeersFile, seedPeers } from '../auth/peers-file.ts'

export interface InitFromFileOpts {
  peers_file: string
  now?: () => Date
}

export interface InitFromFileResult {
  seeded: string[]
}

/**
 * Replaces upstream's pair-code-based `initTeam` (P2 auth simplification).
 *
 * Reads peers.json from disk and seeds the relay DB so the bearer middleware
 * can resolve each incoming Bearer token to a peer handle. Idempotent: safe to
 * call on every relay startup, and the rotation case (a peer's secret hash
 * changed) is handled by `seedPeers` (old token revoked, new one inserted).
 */
export function initRelayFromPeersFile(db: Db, opts: InitFromFileOpts): InitFromFileResult {
  const peers = loadPeersFile(opts.peers_file)
  seedPeers(db, peers, opts.now?.() ?? new Date())
  return { seeded: peers.map(p => p.handle) }
}
