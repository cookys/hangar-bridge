import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serve, type ServerType } from '@hono/node-server'
import { openDatabase } from '../../relay/src/db/db.ts'
import { MessageStore } from '../../relay/src/messages/store.ts'
import { Fanout } from '../../relay/src/fanout.ts'
import { PresenceRegistry } from '../../relay/src/presence/registry.ts'
import { buildApp } from '../../relay/src/app.ts'
import { generateRawToken, hashToken } from '../../relay/src/auth/hash.ts'
import { seedPeers } from '../../relay/src/auth/peers-file.ts'

export interface HarnessPeer {
  handle: string
  token: string
  configDir: string
}

export interface Harness {
  relayUrl: string
  /**
   * Map of peer-handle → bearer + config-dir. The bearer is the raw 43-char
   * URL-safe base64 secret that the peer would normally have in
   * `~/.config/hangar-bridge/secret`; the harness keeps it in-memory and
   * also drops a copy in each peer's tmp configDir so peer-agent CLI flows
   * (send, respond) can be tested end-to-end.
   */
  peers: Record<string, HarnessPeer>
  /**
   * Back-compat alias for `peers`. Removed in a future cleanup; kept for
   * one release so any in-tree scenario tests that still reference
   * `humans.xxx` keep working during the P2 rewrite.
   * @deprecated use `peers`
   */
  humans: Record<string, HarnessPeer>
  cleanup: () => Promise<void>
}

/**
 * Bootstraps a single-tenant hangar-bridge relay + N peers in-process.
 *
 * Replaces upstream's `initTeam + adminPair + admin /users + /auth/pair` flow
 * with direct per-peer secret seeding (P2 auth simplification). Each peer
 * gets a unique raw secret hashed and seeded into the `human` + `token`
 * tables, so the bearer middleware lookup pattern stays identical to upstream
 * (Layer 1 timing-safe compare) and Layer 2 sender-stamp falls out of the
 * same DB join.
 */
export async function startHarness(
  handles: string[],
  opts: { permissionRelay?: boolean } = {}
): Promise<Harness> {
  if (handles.length === 0) throw new Error('startHarness requires at least one handle')

  const db = openDatabase(':memory:')
  const peers: Record<string, HarnessPeer> = {}
  const seedEntries = handles.map(handle => {
    const raw = generateRawToken()
    peers[handle] = { handle, token: raw, configDir: '' }
    return { handle, secret_sha256_hex: hashToken(raw).toString('hex'), display_name: handle }
  })
  seedPeers(db, seedEntries)

  const app = buildApp({
    db,
    store: new MessageStore(db),
    fanout: new Fanout(),
    presence: new PresenceRegistry(),
    now: () => new Date(),
  })
  const { server, port } = await new Promise<{ server: ServerType; port: number }>(resolve => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, info => {
      resolve({ server: s, port: info.port })
    })
  })
  const relayUrl = `http://127.0.0.1:${port}`

  for (const handle of handles) {
    const peer = peers[handle]!
    peer.configDir = makeConfigDir(handle, relayUrl, peer.token, opts.permissionRelay ?? false)
  }

  return {
    relayUrl,
    peers,
    humans: peers,
    cleanup: async () => {
      await new Promise<void>(resolve => server.close(() => resolve()))
      for (const p of Object.values(peers)) {
        if (p.configDir) rmSync(p.configDir, { recursive: true, force: true })
      }
    },
  }
}

function makeConfigDir(handle: string, relayUrl: string, token: string, permissionRelay: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), `e2e-${handle}-`))
  const cfgDir = join(dir, '.config', 'hangar-bridge')
  mkdirSync(cfgDir, { recursive: true })
  const secretPath = join(cfgDir, 'secret')
  writeFileSync(secretPath, token, { mode: 0o600 })
  try { chmodSync(secretPath, 0o600) } catch { /* Windows */ }
  writeFileSync(join(cfgDir, 'config.json'), JSON.stringify({
    relay_url: relayUrl,
    token_path: secretPath,
    self_handle: handle,
    permission_relay: { enabled: permissionRelay, routing: 'ask_thread_participants' },
    presence: { auto_publish_cwd: false, auto_publish_branch: false, auto_publish_repo: false },
    audit_log: join(cfgDir, 'audit'),
  }, null, 2))
  return dir
}
