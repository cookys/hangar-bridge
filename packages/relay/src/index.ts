#!/usr/bin/env node
import { openDatabase } from './db/db.ts'
import { initRelayFromPeersFile } from './cli/init.ts'
import { startServer } from './cli/serve.ts'
import { existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { loadEnvFiles } from '@hangar-bridge/shared'

async function main() {
  loadEnvFiles()
  const [, , cmd] = process.argv
  const dataDir = process.env.HANGAR_DATA ?? '/data'
  const dbPath = join(dataDir, 'hangar-bridge.sqlite')
  const port = Number(process.env.PORT ?? 443)
  const host = process.env.HOST ?? '0.0.0.0'
  // Default sweeper OFF (HANGAR_INACTIVE_DAYS=0): in hangar-bridge each peer
  // is operator-managed and rotation goes through peers.json, so the upstream
  // "purge after 30d inactive" policy doesn't apply.
  const inactiveDays = Number(process.env.HANGAR_INACTIVE_DAYS ?? 0)
  const peersFile = process.env.HANGAR_PEERS_FILE
    ?? join(homedir(), '.config', 'hangar-bridge', 'peers.json')

  if (cmd === 'init') {
    mkdirSync(dirname(dbPath), { recursive: true })
    const db = openDatabase(dbPath)
    const r = initRelayFromPeersFile(db, { peers_file: peersFile })
    console.log(`OK Seeded ${r.seeded.length} peer(s) from ${peersFile}: ${r.seeded.join(', ')}`)
    console.log(`OK DB at ${dbPath} ready for serve`)
    return
  }

  // On every `serve` startup, re-seed from peers.json so secret rotation /
  // adding a peer just needs scp + restart (no separate init step).
  if (!existsSync(dbPath)) {
    mkdirSync(dirname(dbPath), { recursive: true })
  }
  {
    const db = openDatabase(dbPath)
    initRelayFromPeersFile(db, { peers_file: peersFile })
    db.close()
  }

  startServer({ db_path: dbPath, port, host, inactive_days: inactiveDays })
}

const invokedAsScript = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]!).href
if (invokedAsScript) {
  main().catch(err => { console.error(err); process.exit(1) })
}
