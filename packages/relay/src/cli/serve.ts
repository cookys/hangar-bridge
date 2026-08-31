import { existsSync } from 'node:fs'
import { serve } from '@hono/node-server'
import { buildApp } from '../app.ts'
import { openDatabase } from '../db/db.ts'
import { MessageStore } from '../messages/store.ts'
import { Fanout } from '../fanout.ts'
import { PresenceRegistry } from '../presence/registry.ts'
import { ClaimStore } from '../claims/store.ts'
import { startInactivitySweeper } from '../purge.ts'
import { initRelayFromPeersFile } from './init.ts'
import { logJson } from '../logger.ts'

export interface ServeOpts {
  db_path: string
  port: number
  host: string
  inactive_days?: number   // auto-purge users idle this long (default 30, disable with 0)
  sweep_interval_ms?: number   // (default 1h)
  peers_file?: string   // when set, SIGHUP re-seeds the roster from it with no restart
}

/**
 * Re-seed the roster from peers.json against the LIVE db handle. Idempotent
 * (see seedPeers): adding a peer or rotating a secret takes effect with no
 * restart and no dropped SSE streams. A malformed file is rejected and the
 * in-memory authorization already seeded keeps serving — the failure mode a
 * restart cannot offer, where a bad file leaves the fleet with no relay at all.
 * Returns true iff the reload applied.
 */
export function reloadRoster(db: ReturnType<typeof openDatabase>, peersFile: string): boolean {
  try {
    const r = initRelayFromPeersFile(db, { peers_file: peersFile })
    logJson('info', 'relay.roster.reloaded', { seeded: r.seeded.length })
    return true
  } catch (err) {
    logJson('error', 'relay.roster.reload_failed', {
      error: err instanceof Error ? err.message : String(err),
    })
    return false
  }
}

export function startServer(opts: ServeOpts) {
  if (!existsSync(opts.db_path)) {
    console.error(
      `No database at ${opts.db_path}.\n` +
      `Run \`node packages/relay/dist/index.js init\` first to seed peers and schema.`
    )
    process.exit(1)
  }
  const db = openDatabase(opts.db_path)
  const store = new MessageStore(db)
  const fanout = new Fanout()
  const presence = new PresenceRegistry()
  const claims = new ClaimStore(db)
  const app = buildApp({ db, store, fanout, presence, claims, now: () => new Date() })
  const server = serve({ fetch: app.fetch, port: opts.port, hostname: opts.host })

  const days = opts.inactive_days ?? 30
  if (days > 0) {
    const intervalMs = opts.sweep_interval_ms ?? 60 * 60 * 1000
    startInactivitySweeper(db, { intervalMs, days, now: () => new Date() })
    logJson('info', 'relay.inactivity_sweeper.started', { days, interval_ms: intervalMs })
  }

  if (opts.peers_file) {
    const peersFile = opts.peers_file
    process.on('SIGHUP', () => { reloadRoster(db, peersFile) })
    logJson('info', 'relay.roster.reload_handler.armed', { peers_file: peersFile })
  }

  logJson('info', 'relay.started', { host: opts.host, port: opts.port, db_path: opts.db_path })
  return server
}
