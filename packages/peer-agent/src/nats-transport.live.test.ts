import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { NatsTransport } from './nats-transport.ts'
import type { Envelope } from '@hangar-bridge/shared'

const NATS_SERVER = process.env.NATS_SERVER_BIN ?? join(homedir(), '.local/bin/nats-server')
const NATS = process.env.NATS_BIN ?? join(homedir(), '.local/bin/nats')
const PORT = 34333
const URL = `nats://127.0.0.1:${PORT}`

type SeedBundle = { seed: string; pub: string; seedPath: string }

function mintSeed(dir: string): SeedBundle {
  const seed = execFileSync(NATS, ['auth', 'nkey', 'gen', 'user'], { encoding: 'utf8' }).match(/S[A-Z0-9]{40,}/)![0]
  const seedPath = join(dir, `seed-${Math.random().toString(36).slice(2)}.nk`)
  writeFileSync(seedPath, `${seed}\n`)
  chmodSync(seedPath, 0o600)
  const pub = execFileSync(NATS, ['auth', 'nkey', 'show', seedPath], { encoding: 'utf8' }).match(/U[A-Z0-9]{40,}/)![0]
  return { seed, pub, seedPath }
}

function runNatsCommand(adminSeedPath: string, args: string[]): void {
  execFileSync(NATS, ['--server', URL, '--nkey', adminSeedPath, '--inbox-prefix', '_INBOX.admin', ...args], {
    encoding: 'utf8',
    stdio: 'ignore',
  })
}

function writeServerConfig(
  dir: string,
  alphaPub: string,
  betaPub: string,
  adminPub: string,
): string {
  const conf = `
port: ${PORT}
jetstream {
  store_dir: ${JSON.stringify(join(dir, 'js-store'))}
}
accounts {
  HANGAR {
    jetstream: enabled
    users: [
      {
        nkey: ${alphaPub}
        permissions: {
          publish: { allow: ["fleet.alpha.>", "$JS.>", "$KV.>", "_INBOX.alpha.>"] }
          subscribe: { allow: ["fleet.*.to.alpha.>", "fleet.*.to.team.>", "$JS.>", "$KV.>", "_INBOX.alpha.>"] }
        }
      },
      {
        nkey: ${betaPub}
        permissions: {
          publish: { allow: ["fleet.beta.>", "$JS.>", "$KV.>", "_INBOX.beta.>"] }
          subscribe: { allow: ["fleet.*.to.beta.>", "fleet.*.to.team.>", "$JS.>", "$KV.>", "_INBOX.beta.>"] }
        }
      },
      {
        nkey: ${adminPub}
        permissions: {
          publish: { allow: ["$JS.>", "_INBOX.>"] }
          subscribe: { allow: ["$JS.>", "_INBOX.>"] }
        }
      }
    ]
  }
}
`
  const confPath = join(dir, 'c.conf')
  writeFileSync(confPath, conf)
  return confPath
}

function provisionJetstream(adminSeedPath: string): void {
  const subjects = [
    'fleet.*.to.alpha.task_dispatch',
    'fleet.*.to.alpha.task_result',
    'fleet.*.to.beta.task_dispatch',
    'fleet.*.to.beta.task_result',
  ].join(',')

  runNatsCommand(adminSeedPath, ['stream', 'add', 'HANGAR_TASKS', '--subjects', subjects, '--retention', 'work', '--replicas', '1', '--storage', 'file', '--defaults'])
  runNatsCommand(adminSeedPath, ['consumer', 'add', 'HANGAR_TASKS', 'alpha', '--filter', 'fleet.*.to.alpha.>', '--pull', '--defaults'])
  runNatsCommand(adminSeedPath, ['consumer', 'add', 'HANGAR_TASKS', 'beta', '--filter', 'fleet.*.to.beta.>', '--pull', '--defaults'])
  // Permanent-dedup KV bucket (P3/AC5).
  runNatsCommand(adminSeedPath, ['kv', 'add', 'HANGAR_DEDUP', '--replicas', '1', '--storage', 'file'])
}

async function makeTransport(
  handle: 'alpha' | 'beta',
  seed: string,
  onEnvelope: (env: Envelope) => void,
): Promise<NatsTransport> {
  const transport = new NatsTransport({
    selfHandle: handle,
    natsUrl: URL,
    nkeySeed: seed,
    roster: {
      alpha: { owned: ['proj'], interest: ['proj.>'] },
      beta: { owned: ['proj'], interest: ['proj.>'] },
    },
    inboxPrefix: `_INBOX.${handle}`,
    onEnvelope,
    onAuthError: () => {},
  })

  return transport
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

let dir: string
let srv: ChildProcess
let alphaSeed: SeedBundle
let betaSeed: SeedBundle
let alpha: NatsTransport
let serverUp = false

beforeAll(async () => {
  try {
    dir = mkdtempSync(join(tmpdir(), 'p1live-'))
    alphaSeed = mintSeed(dir)
    const beta = mintSeed(dir)
    const admin = mintSeed(dir)
    betaSeed = beta

    const adminPublic = execFileSync(NATS, ['auth', 'nkey', 'show', admin.seedPath], { encoding: 'utf8' }).match(/U[A-Z0-9]{40,}/)![0]
    const confPath = writeServerConfig(dir, alphaSeed.pub, beta.pub, adminPublic)

    srv = spawn(NATS_SERVER, ['-c', confPath], { stdio: 'ignore' })
    await wait(1200)

    provisionJetstream(admin.seedPath)

    alpha = await makeTransport('alpha', alphaSeed.seed, () => {})
    await alpha.start()
    serverUp = true
  } catch {
    serverUp = false
  }
})

afterAll(async () => {
  try { await alpha?.stop() } catch {}
  srv?.kill()
})

describe('P1 live transport round-trip', () => {
  it('replays offline beta task_dispatch/task_result via JetStream on reconnect', async ({ skip }) => {
    if (!serverUp) skip('SKIP: nats-server unavailable or live setup failed')

    const received: Envelope[] = []
    const beta = await makeTransport('beta', betaSeed.seed, env => received.push(env))

    await alpha.send({ to: 'beta', kind: 'task_dispatch', content: 'offline-task', meta: {} } as any)
    // in_reply_to MUST be a valid msg_<ULID> (EnvelopeSchema rejects otherwise —
    // the receive-side parseInboundEnvelope would drop a malformed task_result).
    await alpha.send({ to: 'beta', kind: 'task_result', content: 'offline-result', in_reply_to: 'msg_01ARZ3NDEKTSV4RRFFQ69G5FAV', meta: {} } as any)
    await wait(300)

    await beta.start()
    await wait(500)

    expect(received).toHaveLength(2)
    expect(received[0].from).toBe('alpha')
    expect(received[0].to).toBe('beta')
    expect(received[0].kind).toBe('task_dispatch')
    expect(received[1].kind).toBe('task_result')

    await beta.stop()
  })

  it('does not replay offline core-NATS kinds while beta is down', async ({ skip }) => {
    if (!serverUp) skip('SKIP: nats-server unavailable or live setup failed')

    const received: Envelope[] = []
    const beta = await makeTransport('beta', betaSeed.seed, env => received.push(env))

    await alpha.send({ to: 'beta', kind: 'chat', content: 'offline-chat', meta: {} } as any)
    await alpha.send({ to: 'beta', kind: 'presence_update', content: 'offline-presence', meta: {} } as any)
    await wait(300)

    await beta.start()
    await wait(500)

    expect(received).toHaveLength(0)

    await beta.stop()
  })

  it('AC5: KV permanently dedups a repeat task_dispatch (same correlation_id, distinct wire msgs)', async ({ skip }) => {
    if (!serverUp) skip('SKIP: nats-server unavailable or live setup failed')

    const received: Envelope[] = []
    const beta = await makeTransport('beta', betaSeed.seed, env => received.push(env))
    await beta.start()
    await wait(200)

    // Two SEPARATE JetStream publishes (distinct stream sequence, so the 2-minute
    // Nats-Msg-Id window would NOT collapse them) carrying the SAME correlation_id.
    // Only the KV `create` on `beta.<correlation_id>` can suppress the second.
    await alpha.send({ to: 'beta', kind: 'task_dispatch', content: 'dup-1', meta: { correlation_id: 'corr-dup-1' } } as any)
    await alpha.send({ to: 'beta', kind: 'task_dispatch', content: 'dup-2', meta: { correlation_id: 'corr-dup-1' } } as any)
    await wait(600)

    // Processed exactly once — the permanent KV dedup caught the repeat.
    expect(received).toHaveLength(1)
    expect(received[0].kind).toBe('task_dispatch')
    expect(received[0].from).toBe('alpha')

    await beta.stop()
  })
})
