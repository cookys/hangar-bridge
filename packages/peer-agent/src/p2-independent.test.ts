/**
 * P2-INDEPENDENT — adversarial, spec-derived verification of the AC6 two-tier
 * delivery matrix (core NATS vs JetStream WorkQueue `HANGAR_TASKS`).
 *
 * Authored by the INDEPENDENT VERIFICATION AUTHOR, decorrelated from the P2
 * implementer: derived FROM THE SPEC
 *   - docs/plans/2026-07-02-relay-to-nats-migration.md §2 (AC6), §2.6, §5 Phase 2
 * and the module's PUBLIC surface only. It is BLIND to the implementer's own
 * `nats-transport.test.ts` / `nats-transport.live.test.ts` additions (never read).
 *
 * Default posture: ASSUME BROKEN. The module under test is loaded via a
 * variable-specifier dynamic import so tsc stays clean and so a deliberately
 * broken stub can be swapped in for self-validation (env P2_MODULE_SPECIFIER).
 * Absent hook  → SKIP-with-reason.  Present-but-wrong → FAIL.
 *
 * AC6 spec being verified:
 *   - chat / presence_update / permission_request / permission_verdict → core NATS
 *   - task_dispatch / task_result                                      → JetStream WorkQueue
 *   - a to==='@team' task_dispatch|task_result is REJECTED (never enters the stream)
 *   - NO double delivery: task kinds are NOT delivered by BOTH the core subscription
 *     AND the JetStream consumer.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'

// ── module-under-test loading (variable specifier: tsc-clean + swappable) ──────
const MOD_SPEC = process.env.P2_MODULE_SPECIFIER ?? './nats-transport.ts'

type Envelope = Record<string, unknown> & { kind: string }
type OutboundMessage = {
  to: string
  kind: string
  content: string
  subject?: string | null
  in_reply_to?: string | null
  meta?: Record<string, string>
}
interface TransportOptsLike {
  selfHandle: string
  natsUrl: string
  nkeySeed: string
  roster: Record<string, { owned: string[]; interest: string[] }>
  onEnvelope: (env: Envelope) => void
  onAuthError: () => void
  connector?: (opts: unknown) => Promise<unknown>
  jsFactory?: (nc: unknown) => unknown
  reconnectBaseMs?: number
}
interface TransportLike {
  start(): Promise<void>
  stop(): Promise<void>
  send(msg: OutboundMessage, opts?: { idempotency_key?: string }): Promise<Envelope>
}
type TransportCtor = new (opts: TransportOptsLike) => TransportLike

async function loadTransportCtor(): Promise<TransportCtor | null> {
  try {
    const m = (await import(/* @vite-ignore */ MOD_SPEC)) as { NatsTransport?: TransportCtor }
    return m.NatsTransport ?? null
  } catch {
    return null
  }
}

let EnvelopeSchema: { safeParse: (v: unknown) => { success: boolean; error?: { issues: Array<{ path: (string | number)[] }> } } }
let TEAM_BROADCAST_HANDLE: string
let ulid: () => string
const TE = new TextEncoder()
const TD = new TextDecoder()

beforeAll(async () => {
  const shared = (await import('@hangar-bridge/shared')) as {
    EnvelopeSchema: typeof EnvelopeSchema
    TEAM_BROADCAST_HANDLE: string
  }
  EnvelopeSchema = shared.EnvelopeSchema
  TEAM_BROADCAST_HANDLE = shared.TEAM_BROADCAST_HANDLE
  const u = (await import('ulid')) as { ulid: () => string }
  ulid = u.ulid
})

const ROSTER = { alpha: { owned: [], interest: [] }, beta: { owned: [], interest: [] } }
const msgId = () => `msg_${ulid()}`
const nowIso = () => new Date().toISOString()

function makeEnvelope(over: Partial<Envelope> & { kind: string; from: string; to: string }): Envelope {
  return {
    id: msgId(),
    v: 2,
    team: 'hangar',
    subject: null,
    in_reply_to: over.kind === 'task_result' || over.kind === 'permission_verdict' ? msgId() : null,
    thread_root: null,
    content: 'x',
    meta: {},
    sent_at: nowIso(),
    delivered_at: null,
    ...over,
  }
}
function wire(sender: string, recipient: string, kind: string, envOver: Partial<Envelope> = {}): { subject: string; data: Uint8Array } {
  const subject = `fleet.${sender}.to.${recipient}.${kind}`
  const env = makeEnvelope({ from: sender, to: recipient, kind, ...envOver })
  return { subject, data: TE.encode(JSON.stringify(env)) }
}
const kindOf = (subject: string) => subject.split('.').pop() as string

async function waitFor(pred: () => boolean, timeoutMs = 1500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pred()) return true
    await new Promise(r => setTimeout(r, 10))
  }
  return pred()
}

// ── controllable async source: doubles as a core subscription AND a JS consumer ─
class AsyncQueue<T> {
  private items: T[] = []
  private resolvers: Array<(r: IteratorResult<T>) => void> = []
  private done = false
  push(item: T): void {
    const r = this.resolvers.shift()
    if (r) r({ value: item, done: false })
    else this.items.push(item)
  }
  close(): void {
    this.done = true
    let r: ((x: IteratorResult<T>) => void) | undefined
    while ((r = this.resolvers.shift())) r({ value: undefined as unknown as T, done: true })
  }
  unsubscribe(): void {
    this.close()
  }
  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    // The returned iterator is itself async-iterable: the module extracts
    // `messages[Symbol.asyncIterator]()` and then `for await (… of iterator)`,
    // which re-invokes [Symbol.asyncIterator] on the iterator object.
    const self = this
    const it: AsyncIterableIterator<T> = {
      next: (): Promise<IteratorResult<T>> => {
        const item = self.items.shift()
        if (item !== undefined) return Promise.resolve({ value: item, done: false })
        if (self.done) return Promise.resolve({ value: undefined as unknown as T, done: true })
        return new Promise(res => self.resolvers.push(res))
      },
      return: (): Promise<IteratorResult<T>> => {
        // Wake any already-pending next() so a for-await parked on us can exit
        // (the module's stop() awaits the JetStream task after return()).
        self.close()
        return Promise.resolve({ value: undefined as unknown as T, done: true })
      },
      [Symbol.asyncIterator](): AsyncIterableIterator<T> {
        return it
      },
    }
    return it
  }
}

interface CoreCall { subject: string; payload: Uint8Array }
function makeFakeNc() {
  const publishCalls: CoreCall[] = []
  const subs: Array<{ subject: string; queue: AsyncQueue<{ subject: string; data: Uint8Array }> }> = []
  const nc = {
    publish: (subject: string, payload: Uint8Array) => {
      publishCalls.push({ subject, payload })
    },
    subscribe: (subject: string) => {
      const queue = new AsyncQueue<{ subject: string; data: Uint8Array }>()
      subs.push({ subject, queue })
      return queue
    },
    // empty status stream: watchStatus() completes immediately, connected stays true
    status: () => (async function* () {})(),
    drain: async () => {},
    flush: async () => {},
  }
  return { nc, publishCalls, subs }
}
interface JsCall { subject: string; payload: Uint8Array }
function makeFakeJs() {
  const publishCalls: JsCall[] = []
  const consumerQueue = new AsyncQueue<{
    subject: string
    data: Uint8Array
    ack: () => Promise<void>
    nak: () => Promise<void>
    term: () => Promise<void>
  }>()
  const acks: string[] = []
  const js = {
    publish: async (subject: string, payload: Uint8Array) => {
      publishCalls.push({ subject, payload })
      return { seq: publishCalls.length, duplicate: false, stream: 'HANGAR_TASKS' }
    },
    consumers: {
      get: async (_stream: string, _durable: string) => ({
        consume: async () => consumerQueue,
      }),
    },
  }
  return { js, publishCalls, consumerQueue, acks }
}

// A "started" transport with injected core + JS sinks. Returns null if module absent.
async function startWithFakes(selfHandle: string) {
  const Ctor = await loadTransportCtor()
  if (!Ctor) return null
  const fakeNc = makeFakeNc()
  const fakeJs = makeFakeJs()
  const received: Envelope[] = []
  const t = new Ctor({
    selfHandle,
    natsUrl: 'nats://127.0.0.1:0',
    nkeySeed: 'SUAJUNUSTUB', // never used: connector is stubbed
    roster: ROSTER,
    onEnvelope: env => received.push(env),
    onAuthError: () => {},
    connector: async () => fakeNc.nc as unknown,
    jsFactory: () => fakeJs.js as unknown,
    reconnectBaseMs: 10,
  })
  await t.start()
  return { t, fakeNc, fakeJs, received }
}

// ── 1. ROUTING (unit, server-free) ─────────────────────────────────────────────
describe('P2 AC6 · routing matrix (core vs JetStream)', () => {
  const CORE_KINDS = ['chat', 'presence_update', 'permission_request', 'permission_verdict']
  const TASK_KINDS = ['task_dispatch', 'task_result']

  it('routes the four non-task kinds to the CORE sink and never to JetStream', async ctx => {
    const h = await startWithFakes('alpha')
    if (!h) return ctx.skip()
    try {
      for (const kind of CORE_KINDS) {
        const before = h.fakeJs.publishCalls.length
        await h.t.send({ to: 'beta', kind, content: 'hello', in_reply_to: kind === 'permission_verdict' ? msgId() : null })
        expect(h.fakeJs.publishCalls.length, `${kind} must NOT publish to JetStream`).toBe(before)
      }
      const coreKinds = h.fakeNc.publishCalls.map(c => kindOf(c.subject)).sort()
      expect(coreKinds, 'exactly the four non-task kinds on the core sink').toEqual([...CORE_KINDS].sort())
      expect(h.fakeJs.publishCalls.length, 'JetStream sink untouched by non-task kinds').toBe(0)
    } finally {
      await h.t.stop()
    }
  })

  it('routes task_dispatch / task_result to the JETSTREAM sink and never to core', async ctx => {
    const h = await startWithFakes('alpha')
    if (!h) return ctx.skip()
    try {
      for (const kind of TASK_KINDS) {
        const beforeCore = h.fakeNc.publishCalls.length
        await h.t.send({ to: 'beta', kind, content: 'work', in_reply_to: kind === 'task_result' ? msgId() : null })
        expect(h.fakeNc.publishCalls.length, `${kind} must NOT publish to core NATS`).toBe(beforeCore)
      }
      const jsKinds = h.fakeJs.publishCalls.map(c => kindOf(c.subject)).sort()
      expect(jsKinds, 'exactly the two task kinds on the JetStream sink').toEqual([...TASK_KINDS].sort())
      expect(h.fakeNc.publishCalls.length, 'core sink untouched by task kinds').toBe(0)
      for (const c of h.fakeJs.publishCalls) {
        expect(c.subject, 'task wire subject shape').toMatch(/^fleet\.alpha\.to\.beta\.(task_dispatch|task_result)$/)
      }
    } finally {
      await h.t.stop()
    }
  })

  it('classifies each of the six kinds into EXACTLY one lane (partition, no overlap/gap)', async ctx => {
    const h = await startWithFakes('alpha')
    if (!h) return ctx.skip()
    try {
      const all = [...CORE_KINDS, ...TASK_KINDS]
      for (const kind of all) {
        await h.t.send({ to: 'beta', kind, content: 'z', in_reply_to: kind === 'task_result' || kind === 'permission_verdict' ? msgId() : null })
      }
      const total = h.fakeNc.publishCalls.length + h.fakeJs.publishCalls.length
      expect(total, 'each kind published exactly once, no double-classification').toBe(all.length)
      expect(h.fakeNc.publishCalls.length).toBe(CORE_KINDS.length)
      expect(h.fakeJs.publishCalls.length).toBe(TASK_KINDS.length)
    } finally {
      await h.t.stop()
    }
  })
})

// ── 2. NO DOUBLE DELIVERY ──────────────────────────────────────────────────────
describe('P2 AC6 · no double delivery (core drops task kinds)', () => {
  it('DROPS an inbound task fed through the CORE subscription; delivers non-task there', async ctx => {
    const h = await startWithFakes('beta')
    if (!h) return ctx.skip()
    try {
      const directSub = h.fakeNc.subs.find(s => s.subject.includes('.to.beta.'))
      expect(directSub, 'transport must open a core subscription for its own handle').toBeTruthy()

      // Feed a well-formed task_dispatch addressed to beta through the CORE lane.
      directSub!.queue.push(wire('alpha', 'beta', 'task_dispatch'))
      // Feed a chat too — proves the core pipe is live and the drop is task-SPECIFIC.
      directSub!.queue.push(wire('alpha', 'beta', 'chat'))

      await waitFor(() => h.received.some(e => e.kind === 'chat'))
      // Give any (erroneous) task delivery a chance to surface before asserting absence.
      await new Promise(r => setTimeout(r, 60))

      const taskDeliveries = h.received.filter(e => e.kind === 'task_dispatch')
      expect(taskDeliveries.length, 'core subscription must DROP task kinds (no double delivery)').toBe(0)
      expect(h.received.some(e => e.kind === 'chat'), 'core subscription still delivers non-task kinds').toBe(true)
    } finally {
      await h.t.stop()
    }
  })

  it('delivers the task via the JETSTREAM consumer path exactly once (and acks)', async ctx => {
    const h = await startWithFakes('beta')
    if (!h) return ctx.skip()
    try {
      let acked = 0
      const w = wire('alpha', 'beta', 'task_dispatch')
      h.fakeJs.consumerQueue.push({
        subject: w.subject,
        data: w.data,
        ack: async () => {
          acked += 1
        },
        nak: async () => {},
        term: async () => {},
      })
      const got = await waitFor(() => h.received.some(e => e.kind === 'task_dispatch'))
      expect(got, 'JetStream consumer path must deliver the task').toBe(true)
      expect(h.received.filter(e => e.kind === 'task_dispatch').length, 'delivered exactly once via JS').toBe(1)
      expect(await waitFor(() => acked === 1), 'JS delivery is acked').toBe(true)
    } finally {
      await h.t.stop()
    }
  })
})

// ── 3. @team TASK REJECTION ─────────────────────────────────────────────────────
describe('P2 AC6 · @team task rejection (never enters the stream)', () => {
  for (const kind of ['task_dispatch', 'task_result']) {
    it(`rejects send({to:'@team', kind:'${kind}'}) before any JetStream publish`, async ctx => {
      const h = await startWithFakes('alpha')
      if (!h) return ctx.skip()
      try {
        await expect(
          h.t.send({ to: TEAM_BROADCAST_HANDLE, kind, content: 'x', in_reply_to: kind === 'task_result' ? msgId() : null }),
        ).rejects.toThrow()
        expect(h.fakeJs.publishCalls.length, `@team ${kind} must never reach JetStream`).toBe(0)
        expect(
          h.fakeNc.publishCalls.some(c => kindOf(c.subject) === kind),
          `@team ${kind} must not leak onto core either`,
        ).toBe(false)
      } finally {
        await h.t.stop()
      }
    })
  }

  it('still allows a legitimate @team chat (rejection is task-specific, not a blanket @team block)', async ctx => {
    const h = await startWithFakes('alpha')
    if (!h) return ctx.skip()
    try {
      await expect(h.t.send({ to: TEAM_BROADCAST_HANDLE, kind: 'chat', content: 'hi team' })).resolves.toBeTruthy()
      expect(h.fakeNc.publishCalls.some(c => c.subject === 'fleet.alpha.to.team.chat')).toBe(true)
      expect(h.fakeJs.publishCalls.length).toBe(0)
    } finally {
      await h.t.stop()
    }
  })
})

// ── 4. in_reply_to INVARIANT (shared schema) ───────────────────────────────────
describe('P2 · task_result in_reply_to invariant (shared EnvelopeSchema)', () => {
  it('REJECTS a task_result with null in_reply_to', () => {
    const bad = makeEnvelope({ from: 'alpha', to: 'beta', kind: 'task_result', in_reply_to: null })
    const res = EnvelopeSchema.safeParse(bad)
    expect(res.success, 'task_result with null in_reply_to must be rejected').toBe(false)
    if (!res.success) {
      expect(res.error!.issues.some(i => i.path.includes('in_reply_to'))).toBe(true)
    }
  })

  it('ACCEPTS a task_result carrying a valid in_reply_to (control)', () => {
    const ok = makeEnvelope({ from: 'alpha', to: 'beta', kind: 'task_result', in_reply_to: msgId() })
    expect(EnvelopeSchema.safeParse(ok).success).toBe(true)
  })
})

// ── 5. LIVE backfill (the load-bearing AC6 proof) ──────────────────────────────
// Guarded: SKIP-with-reason if the local NATS/JetStream substrate is unavailable;
// real ASSERTIONS (durable task replay to an offline peer; core chat NOT replayed)
// FAIL if the substrate is present but the two-tier durability contract is wrong.
function findNatsServer(): string | null {
  const candidates = [
    join(homedir(), '.local', 'bin', 'nats-server'),
    '/usr/local/bin/nats-server',
    '/usr/bin/nats-server',
  ]
  for (const c of candidates) if (existsSync(c)) return c
  return null
}

describe('P2 AC6 · LIVE two-tier durability (JetStream replay vs core loss)', () => {
  it(
    'offline peer receives a durable task on reconnect, but NOT a core chat sent while offline',
    async ctx => {
      const serverBin = findNatsServer()
      if (!serverBin) return ctx.skip()
      const Ctor = await loadTransportCtor()
      if (!Ctor) return ctx.skip()

      let mod: {
        connect: (o: unknown) => Promise<any>
        nkeyAuthenticator: (s: Uint8Array) => unknown
        nkeys: { createUser: () => { getSeed: () => Uint8Array; getPublicKey: () => string } }
      }
      let jsmod: {
        jetstream: (nc: unknown) => any
        jetstreamManager: (nc: unknown) => Promise<any>
        RetentionPolicy: { Workqueue: string }
        StorageType: { File: string }
        AckPolicy: { Explicit: string }
      }
      try {
        mod = (await import('@nats-io/transport-node')) as typeof mod
        jsmod = (await import('@nats-io/jetstream')) as typeof jsmod
      } catch {
        return ctx.skip()
      }

      const port = 14000 + Math.floor(Math.random() * 2000)
      const url = `nats://127.0.0.1:${port}`
      const storeDir = mkdtempSync(join(tmpdir(), 'p2-live-js-'))
      const user = mod.nkeys.createUser()
      const seedStr = TD.decode(user.getSeed())
      const pub = user.getPublicKey()
      const confPath = join(storeDir, 'nats.conf')
      writeFileSync(
        confPath,
        [
          `port: ${port}`,
          `host: "127.0.0.1"`,
          `jetstream { store_dir: "${storeDir}/js" }`,
          `authorization { users: [ { nkey: "${pub}" } ] }`,
          '',
        ].join('\n'),
      )

      let server: ChildProcess | undefined
      let admin: any
      let beta: TransportLike | undefined
      const bounded = <T>(p: Promise<T>, ms: number) =>
        Promise.race([p.catch(() => undefined), new Promise(r => setTimeout(r, ms))])
      const cleanup = async () => {
        // Kill the server FIRST so any live NATS drains/iterators terminate promptly;
        // then best-effort close clients under a hard time bound (teardown of a live
        // pull-consumer must never hang the harness and mask the AC6 proof).
        try {
          server?.kill('SIGKILL')
        } catch {
          /* ignore */
        }
        if (beta) await bounded(Promise.resolve(beta.stop()), 3000)
        if (admin) await bounded(Promise.resolve(admin.drain?.() ?? admin.close?.()), 3000)
        try {
          rmSync(storeDir, { recursive: true, force: true })
        } catch {
          /* ignore */
        }
      }

      // ── infra bring-up: any failure here is a SKIP, not a test failure ──
      try {
        server = spawn(serverBin, ['-c', confPath], { stdio: 'ignore' })
        server.on('error', () => {})

        const auth = mod.nkeyAuthenticator(TE.encode(seedStr))
        // wait for readiness by polling a real connect
        const readyDeadline = Date.now() + 8000
        while (Date.now() < readyDeadline) {
          try {
            admin = await mod.connect({ servers: url, authenticator: auth, inboxPrefix: '_INBOX.prov', maxReconnectAttempts: 3 })
            break
          } catch {
            admin = undefined
            await new Promise(r => setTimeout(r, 150))
          }
        }
        if (!admin) throw new Error('nats-server did not become ready')

        const jsm = await jsmod.jetstreamManager(admin)
        await jsm.streams.add({
          name: 'HANGAR_TASKS',
          subjects: ['fleet.*.to.beta.task_dispatch', 'fleet.*.to.beta.task_result'],
          retention: jsmod.RetentionPolicy.Workqueue,
          storage: jsmod.StorageType.File,
          num_replicas: 1,
        })
        await jsm.consumers.add('HANGAR_TASKS', {
          durable_name: 'beta',
          filter_subject: 'fleet.*.to.beta.>',
          ack_policy: jsmod.AckPolicy.Explicit,
        })
      } catch (e) {
        await cleanup()
        return ctx.skip()
      }

      // ── the actual AC6 proof: assertions from here on FAIL (not skip) ──
      try {
        // (a) publish a durable task to the OFFLINE beta via JetStream WorkQueue
        const taskEnv = makeEnvelope({ from: 'alpha', to: 'beta', kind: 'task_dispatch', content: 'run-me', in_reply_to: null })
        const pubJs = jsmod.jetstream(admin)
        const pubAck = await pubJs.publish('fleet.alpha.to.beta.task_dispatch', TE.encode(JSON.stringify(taskEnv)))
        expect(pubAck.stream, 'task must land in the HANGAR_TASKS WorkQueue').toBe('HANGAR_TASKS')

        // (b) publish a core chat to the OFFLINE beta — core has no durable backfill
        const chatEnv = makeEnvelope({ from: 'alpha', to: 'beta', kind: 'chat', content: 'ephemeral' })
        admin.publish('fleet.alpha.to.beta.chat', TE.encode(JSON.stringify(chatEnv)))
        await admin.flush()

        // (c) NOW bring beta online — durable consumer should replay the task
        const received: Envelope[] = []
        beta = new Ctor({
          selfHandle: 'beta',
          natsUrl: url,
          nkeySeed: seedStr,
          roster: ROSTER,
          onEnvelope: env => received.push(env),
          onAuthError: () => {},
        })
        await beta.start()

        const gotTask = await waitFor(() => received.some(e => e.kind === 'task_dispatch' && e.id === taskEnv.id), 10000)
        expect(gotTask, 'AC6: offline peer MUST receive the durable task via JetStream replay').toBe(true)

        // give a generous window for any (incorrect) core chat replay before asserting absence
        await new Promise(r => setTimeout(r, 1500))
        expect(
          received.some(e => e.kind === 'chat'),
          'AC6: a core chat sent while offline MUST NOT be replayed after reconnect',
        ).toBe(false)
        // and the task must not have been double-delivered
        expect(received.filter(e => e.kind === 'task_dispatch').length, 'task delivered exactly once').toBe(1)
      } finally {
        await cleanup()
      }
    },
    45000,
  )
})
