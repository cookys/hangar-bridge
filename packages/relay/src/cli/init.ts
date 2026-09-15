import type { Db } from '../db/db.ts'
import { loadPeersFile, seedPeers, type SeedDiff } from '../auth/peers-file.ts'

export interface InitFromFileOpts {
  peers_file: string
  now?: () => Date
}

export interface InitFromFileResult {
  seeded: string[]
  mode: 'legacy' | 'strict'
  diff: SeedDiff
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
  const loaded = loadPeersFile(opts.peers_file)
  const diff = seedPeers(db, loaded, opts.now?.() ?? new Date())
  return { seeded: loaded.peers.map(p => p.handle), mode: loaded.mode, diff }
}
