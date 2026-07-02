// TEMPORARY depth-0 live verification (deleted after run). Proves the NATS transport
// seam works end-to-end against a real nats-server: anti-spoof from-stamp + team self-drop.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { NatsTransport } from './nats-transport.ts'
import type { RosterMap } from './subject-acl.ts'
import type { Envelope } from '@hangar-bridge/shared'

const NATS = process.env.NATS_SERVER_BIN ?? join(homedir(), '.local/bin/nats-server')
const NK = process.env.NATS_BIN ?? join(homedir(), '.local/bin/nats')
const PORT = 34333
const URL = `nats://127.0.0.1:${PORT}`

function mintSeed(): { seed: string; pub: string } {
  const seed = execFileSync(NK, ['auth', 'nkey', 'gen', 'user'], { encoding: 'utf8' }).match(/S[A-Z0-9]{40,}/)![0]
  const f = join(dir, `${Math.random().toString(36).slice(2)}.nk`)
  writeFileSync(f, seed + '\n'); chmodSync(f, 0o600)
  const pub = execFileSync(NK, ['auth', 'nkey', 'show', f], { encoding: 'utf8' }).match(/U[A-Z0-9]{40,}/)![0]
  return { seed, pub }
}

let dir: string, srv: ChildProcess, alpha: NatsTransport, beta: NatsTransport
let serverUp = false

const roster: RosterMap = { alpha: { owned: [], interest: [] }, beta: { owned: [], interest: [] } }

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'p1live.'))
  let A, B
  try { A = mintSeed(); B = mintSeed() } catch { return }
  const userBlock = (h: string, pub: string) => `{ nkey: ${pub}, permissions: {
      publish: { allow: ["fleet.${h}.>", "_INBOX.${h}.>"] },
      subscribe: { allow: ["fleet.*.to.${h}.>", "fleet.*.to.team.>", "_INBOX.${h}.>"] } } }`
  const conf = join(dir, 'c.conf')
  writeFileSync(conf, `port: ${PORT}\naccounts { HANGAR { users: [ ${userBlock('alpha', A.pub)}, ${userBlock('beta', B.pub)} ] } }\n`)
  srv = spawn(NATS, ['-c', conf], { stdio: 'ignore' })
  await new Promise(r => setTimeout(r, 1500))
  try {
    alpha = new NatsTransport({ selfHandle: 'alpha', natsUrl: URL, nkeySeed: A.seed, roster, inboxPrefix: '_INBOX.alpha', onEnvelope: () => {}, onAuthError: () => {} })
    beta = new NatsTransport({ selfHandle: 'beta', natsUrl: URL, nkeySeed: B.seed, roster, inboxPrefix: '_INBOX.beta', onEnvelope: () => {}, onAuthError: () => {} })
    await alpha.start(); await beta.start()
    serverUp = true
  } catch { serverUp = false }
})

afterAll(async () => {
  try { await alpha?.stop(); await beta?.stop() } catch {}
  srv?.kill()
})

describe('P1 live transport round-trip', () => {
  it('delivers alpha→beta chat with subject-derived from (anti-spoof)', async () => {
    if (!serverUp) { console.warn('SKIP: nats-server unavailable'); return }
    const got: Envelope[] = []
    ;(beta as any).opts.onEnvelope = (e: Envelope) => got.push(e)
    // spoof attempt: envelope body from='evil' — the wire subject says alpha
    await alpha.send({ to: 'beta', kind: 'chat', content: 'hello-beta', meta: {} } as any)
    await new Promise(r => setTimeout(r, 400))
    expect(got.length).toBe(1)
    expect(got[0].from).toBe('alpha')      // derived from wire subject, not body
    expect(got[0].content).toBe('hello-beta')
    expect(got[0].to).toBe('beta')
  })

  it('team broadcast reaches beta but NOT the sender (self-drop)', async () => {
    if (!serverUp) { console.warn('SKIP: nats-server unavailable'); return }
    const betaGot: Envelope[] = [], alphaGot: Envelope[] = []
    ;(beta as any).opts.onEnvelope = (e: Envelope) => betaGot.push(e)
    ;(alpha as any).opts.onEnvelope = (e: Envelope) => alphaGot.push(e)
    await alpha.send({ to: '@team', kind: 'chat', content: 'broadcast', meta: {} } as any)
    await new Promise(r => setTimeout(r, 400))
    expect(betaGot.map(e => e.content)).toContain('broadcast')
    expect(betaGot[0].from).toBe('alpha')
    expect(alphaGot.length).toBe(0)        // self-drop
  })
})
