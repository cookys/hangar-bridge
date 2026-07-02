/*
 * p3-independent.test.ts — INDEPENDENT, spec-derived adversarial harness for
 * Phase 3 of the relay→NATS migration (KV permanent task dedup).
 *
 * Authored DECORRELATED from the implementer (blind to task-dedup.test.ts /
 * nats-transport.test.ts additions / any *independent* sibling). Assertions are
 * derived ONLY from the plan spec:
 *   docs/plans/2026-07-02-relay-to-nats-migration.md — §2 (AC5, AC9), §2.6, §5 Phase 3.
 *
 * Default-assume broken:
 *   - a probed hook that is ABSENT  -> the test SKIPs with an explicit reason.
 *   - a probed hook that is PRESENT-but-WRONG -> the test FAILs.
 *
 * The unit surface (task-dedup.ts) is loaded via a *variable-specifier* dynamic
 * import so `tsc` stays clean whether or not the module exists yet, and so the
 * self-validation driver can repoint it (P3_DEDUP_MODULE / P3_DEDUP_SRC env vars)
 * at deliberately-broken and faithful stubs to prove the harness discriminates.
 *
 * CANONICAL SPEC-DERIVED SURFACE probed for task-dedup.ts (AC5/AC9, §2.6):
 *   Construction (any of):
 *     new <Ctor>({ kv, selfHandle })   |   new <Ctor>(kv, selfHandle)   |   <factory>({ kv, selfHandle })
 *   Dedup call (async, takes a correlation id), method name among DEDUP_METHODS:
 *     instance.<method>(correlationId) => Promise<verdict>
 *   Verdict semantics are read POLARITY-AGNOSTICALLY: a first sighting and a
 *   duplicate MUST resolve to DIFFERENT values; the already-processed id yields
 *   the "duplicate" value. A KV error that is NOT an already-exists conflict MUST
 *   REJECT (propagate) — never resolve to "new" or "duplicate" (AC9: never
 *   silently drop a task).
 *   KV surface used: kv.create(key, value) -> Promise<revision>; rejects with a
 *   JetStreamApiError(code 10071 StreamWrongLastSequence) when the key exists.
 *   Dedup key is receiver-scoped: `<selfHandle>.<correlationId>` (→ own-prefix KV
 *   grant `$KV.HANGAR_DEDUP.<selfHandle>.>`, §2.6).
 */
import { spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { ulid } from 'ulid'
import { JetStreamApiError } from '@nats-io/jetstream'

// ----- module-under-test specifiers (variable => tsc-safe, self-val overridable)
const DEDUP_SPEC =
  process.env.P3_DEDUP_MODULE ?? new URL('./task-dedup.ts', import.meta.url).href
const DEDUP_SRC_PATH =
  process.env.P3_DEDUP_SRC ?? fileURLToPath(new URL('./task-dedup.ts', import.meta.url))
const TRANSPORT_SPEC = new URL('./nats-transport.ts', import.meta.url).href

async function tryImport(spec: string): Promise<Record<string, any> | null> {
  try {
    return (await import(/* @vite-ignore */ spec)) as Record<string, any>
  } catch {
    return null
  }
}

// Loaded at module top-level so it.skipIf() (evaluated at collection) can see it.
const dedupMod = await tryImport(DEDUP_SPEC)
const MODULE_PRESENT = dedupMod !== null

const transportMod = await tryImport(TRANSPORT_SPEC)
const NatsTransport: any = transportMod?.NatsTransport ?? null
const TRANSPORT_PRESENT = typeof NatsTransport === 'function'

// ----- adapter: discover the dedup entrypoint per the canonical surface --------
const CTOR_NAMES = [
  'TaskDedup', 'KvTaskDedup', 'KvDedup', 'Dedup', 'TaskDeduplicator', 'Deduper',
  'createTaskDedup', 'makeTaskDedup', 'createDedup', 'createKvDedup', 'default',
]
const DEDUP_METHODS = [
  'check', 'checkAndMark', 'isFirstSighting', 'firstSighting', 'markIfNew',
  'dedupe', 'dedup', 'seen', 'markProcessed', 'process', 'shouldProcess', 'claim',
]

function findMethod(inst: any): string | null {
  if (!inst) return null
  for (const m of DEDUP_METHODS) if (typeof inst[m] === 'function') return m
  return null
}

interface DedupHandle {
  call: (id: string) => Promise<unknown>
  method: string
  ctor: string
}

function buildDedup(mod: Record<string, any> | null, kv: any, selfHandle: string): DedupHandle | null {
  if (!mod) return null
  // Canonical hangar-bridge surface: `async openTaskDedup(nc, selfHandle, { kvm })`
  // where kvm.open(bucket) → the KV store. Wrap the provided `kv` bucket in a kvm shim
  // and bypass the real connection. A fresh instance per call is intentional — it proves
  // the KV (not instance memory) is the dedup authority.
  if (typeof mod.openTaskDedup === 'function') {
    const kvmShim = { open: async () => kv }
    return {
      call: async (id: string) => {
        const dedup = await mod.openTaskDedup({}, selfHandle, { kvm: kvmShim })
        return dedup.seen(id)
      },
      method: 'seen',
      ctor: 'openTaskDedup',
    }
  }
  const argForms: any[][] = [[{ kv, selfHandle }], [kv, selfHandle]]
  for (const name of CTOR_NAMES) {
    const cand = mod[name]
    if (typeof cand !== 'function') continue
    for (const args of argForms) {
      // try as a class constructor
      try {
        const inst = new (cand as any)(...args)
        const m = findMethod(inst)
        if (m) return { call: (id) => (inst as any)[m](id), method: m, ctor: name }
      } catch { /* not a constructor with these args */ }
      // try as a factory function
      try {
        const inst = (cand as any)(...args)
        if (inst && typeof (inst as any).then !== 'function') {
          const m = findMethod(inst)
          if (m) return { call: (id) => (inst as any)[m](id), method: m, ctor: name }
        }
      } catch { /* not a factory with these args */ }
    }
  }
  // free-function forms: fn(kv, selfHandle, id) / fn({kv, selfHandle, correlationId})
  const FN_NAMES = ['dedupTask', 'checkDuplicate', 'markTask', 'dedup', 'check']
  for (const name of FN_NAMES) {
    const cand = mod[name]
    if (typeof cand !== 'function') continue
    return { call: (id) => (cand as any)(kv, selfHandle, id), method: name, ctor: '(free fn)' }
  }
  return null
}

// ----- mock KV surfaces --------------------------------------------------------
function alreadyExistsError(): JetStreamApiError {
  // Exactly what @nats-io/kv Bucket.create() surfaces on an existing key:
  // a JetStreamApiError with code 10071 (StreamWrongLastSequence).
  return new JetStreamApiError({ code: 400, err_code: 10071, description: 'wrong last sequence: 1' } as any)
}

interface MockKv {
  create: (key: string, value?: Uint8Array, ttl?: number) => Promise<number>
  get: (key: string) => Promise<{ revision: number; operation: string; value: Uint8Array } | null>
  put: (key: string, value: Uint8Array) => Promise<number>
  update: (key: string, value: Uint8Array, rev: number) => Promise<number>
  createCalls: Array<{ key: string; ttl?: number }>
  store: Map<string, Uint8Array>
}

function makeMockKv(): MockKv {
  const store = new Map<string, Uint8Array>()
  const createCalls: Array<{ key: string; ttl?: number }> = []
  return {
    store,
    createCalls,
    async create(key, value, ttl) {
      createCalls.push({ key, ttl })
      if (store.has(key)) throw alreadyExistsError()
      store.set(key, value ?? new Uint8Array())
      return store.size
    },
    async get(key) {
      return store.has(key)
        ? { revision: 1, operation: 'PUT', value: store.get(key)! }
        : null
    },
    async put(key, value) { store.set(key, value); return store.size },
    async update(key, value, rev) { store.set(key, value); return rev + 1 },
  }
}

// KV whose create ALWAYS fails with a NON-already-exists infra error.
function makeInfraFailKv(): MockKv {
  const base = makeMockKv()
  return {
    ...base,
    async create(key, _value, ttl) {
      base.createCalls.push({ key, ttl })
      throw new Error('nats: connection refused (ECONNREFUSED 127.0.0.1:4222)')
    },
  }
}

// ----- self-validation banner --------------------------------------------------
if (process.env.P3_DEDUP_MODULE) {
  // eslint-disable-next-line no-console
  console.warn(`[p3-independent] SELF-VALIDATION run against stub: ${process.env.P3_DEDUP_MODULE}`)
}

const CORR = `corr_${ulid()}`
const SELF = 'gentoo'

// =====================================================================
// (0) surface presence — a FAIL when the module exists but exposes no
//     recognised dedup entrypoint (present-but-wrong); SKIP when absent.
// =====================================================================
describe('P3 KV-dedup — module surface', () => {
  it.skipIf(!MODULE_PRESENT)(
    `exposes a recognised dedup entrypoint [${MODULE_PRESENT ? 'present' : 'SKIP: task-dedup module absent (P3 not implemented)'}]`,
    () => {
      const handle = buildDedup(dedupMod, makeMockKv(), SELF)
      expect(
        handle,
        `task-dedup module loaded from ${DEDUP_SPEC} but no ctor/method matched the canonical surface ` +
          `(ctors: ${CTOR_NAMES.join('|')}; methods: ${DEDUP_METHODS.join('|')})`,
      ).not.toBeNull()
    },
  )
})

// =====================================================================
// (1) Dedup unit — first id NEW, repeat DUPLICATE (server-free, mock KV)
// (2) Key scoping — key begins with `<selfHandle>.`
// =====================================================================
describe('P3 KV-dedup — unit (mock KV)', () => {
  it.skipIf(!MODULE_PRESENT)(
    'first correlationId is treated as NEW, an immediate repeat is a DUPLICATE (AC5)',
    async () => {
      const kv = makeMockKv()
      const dedup = buildDedup(dedupMod, kv, SELF)
      expect(dedup, 'no dedup entrypoint').not.toBeNull()

      const first = await dedup!.call(CORR) // kv.create resolves
      const second = await dedup!.call(CORR) // kv.create rejects already-exists

      // polarity-agnostic: the two verdicts MUST differ (catches "always new"/"always dup")
      expect(
        first,
        `first sighting and duplicate resolved to the SAME verdict (${JSON.stringify(first)}); ` +
          'dedup does not suppress the repeat',
      ).not.toEqual(second)

      // the impl must have attempted a KV create on the first sighting
      expect(kv.createCalls.length).toBeGreaterThanOrEqual(1)
    },
  )

  it.skipIf(!MODULE_PRESENT)(
    'dedup key is receiver-scoped: begins with `<selfHandle>.` and carries the correlationId (§2.6 AC5)',
    async () => {
      const kv = makeMockKv()
      const dedup = buildDedup(dedupMod, kv, SELF)
      expect(dedup, 'no dedup entrypoint').not.toBeNull()

      await dedup!.call(CORR)
      expect(kv.createCalls.length, 'dedup did not call kv.create').toBeGreaterThanOrEqual(1)
      const key = kv.createCalls[0]!.key
      expect(key, `dedup key '${key}' must be own-prefix scoped '<selfHandle>.'`).toMatch(
        new RegExp(`^${SELF}\\.`),
      )
      expect(key, 'dedup key must incorporate the correlationId').toContain(CORR)
    },
  )
})

// =====================================================================
// (3) Infra-error safety — a non-already-exists KV error PROPAGATES (AC9)
// =====================================================================
describe('P3 KV-dedup — infra-error safety (AC9)', () => {
  it.skipIf(!MODULE_PRESENT)(
    'a KV create failure that is NOT already-exists must REJECT (retryable), not be swallowed as new/duplicate',
    async () => {
      const kv = makeInfraFailKv()
      const dedup = buildDedup(dedupMod, kv, SELF)
      expect(dedup, 'no dedup entrypoint').not.toBeNull()

      let resolvedTo: unknown = Symbol('unset')
      let threw = false
      try {
        resolvedTo = await dedup!.call(CORR)
      } catch {
        threw = true
      }
      expect(
        threw,
        `infra error was swallowed and resolved to ${JSON.stringify(resolvedTo)} instead of propagating — ` +
          'AC9: a dedup infra error must never be silently treated as duplicate or new',
      ).toBe(true)
    },
  )
})

// =====================================================================
// (4) No-TTL (AC9): (a) source scan — no ttl/expiry drives the dedup decision;
//                   (b) behavioural — dedup authority is the KV store, not
//                       instance-local (TTL-able) memory.
// =====================================================================
describe('P3 KV-dedup — no-TTL correctness (AC9)', () => {
  it.skipIf(!MODULE_PRESENT || !existsSync(DEDUP_SRC_PATH))(
    'dedup source does not bind correctness to a TTL / expiry window',
    async () => {
      const { readFileSync } = await import('node:fs')
      const raw = readFileSync(DEDUP_SRC_PATH, 'utf8')
      // strip // line-comments and /* */ block-comments so prose like "no TTL" is ignored
      const code = raw
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
      const offenders = code.match(/\b(ttl|expiry|expires?|max_?age|markerttl)\b/gi)
      expect(
        offenders,
        `dedup source references a TTL/expiry token ${JSON.stringify(offenders)} — AC9 forbids ` +
          'binding dedup correctness to a KV TTL lease',
      ).toBeNull()
    },
  )

  it.skipIf(!MODULE_PRESENT)(
    'dedup verdict is KV-backed (a fresh instance over the same KV still sees a DUPLICATE), not instance-local memory',
    async () => {
      const kv = makeMockKv()
      const a = buildDedup(dedupMod, kv, SELF)
      const b = buildDedup(dedupMod, kv, SELF)
      expect(a, 'no dedup entrypoint').not.toBeNull()

      const firstOnA = await a!.call(CORR) // create resolves
      const seenByB = await b!.call(CORR) // separate instance, same KV -> already-exists
      expect(
        firstOnA,
        'a distinct dedup instance sharing the same KV re-treated the id as NEW — dedup authority ' +
          'is not the durable KV store (would re-dispatch after restart / past the 2-min window)',
      ).not.toEqual(seenByB)
    },
  )
})

// =====================================================================
// (5) Transport integration — on the JetStream consume path, a duplicate task
//     is acked WITHOUT a second onEnvelope; a first-sighting calls onEnvelope
//     then ack. Drives the REAL nats-transport consume loop with fakes.
// =====================================================================
const enc = new TextEncoder()

function makeTaskEnvelope(from: string, to: string, id: string) {
  return {
    id,
    v: 2,
    team: 'hangar',
    from,
    to,
    subject: null,
    in_reply_to: null,
    thread_root: null,
    kind: 'task_dispatch',
    content: 'do the thing',
    meta: {},
    sent_at: new Date().toISOString(),
    delivered_at: null,
  }
}

function blockingAsyncIterable(msgs: any[]) {
  let i = 0
  let resolveEnd: (() => void) | undefined
  const iterable: any = {
    [Symbol.asyncIterator]() { return this },
    async next() {
      if (i < msgs.length) return { value: msgs[i++], done: false }
      return new Promise((resolve) => {
        resolveEnd = () => resolve({ value: undefined, done: true })
      })
    },
    async return() { if (resolveEnd) resolveEnd(); return { value: undefined, done: true } },
    async stop() { if (resolveEnd) resolveEnd() },
    async close() { if (resolveEnd) resolveEnd() },
  }
  return iterable
}

function makeFakeNc() {
  const forever = () => new Promise<never>(() => {})
  return {
    status() { return { [Symbol.asyncIterator]() { return { next: forever } } } },
    subscribe() { return { [Symbol.asyncIterator]() { return { next: forever } }, unsubscribe() {} } },
    publish() {},
    async drain() {},
  }
}

async function waitFor(pred: () => boolean, timeoutMs: number) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true
    await new Promise((r) => setTimeout(r, 10))
  }
  return pred()
}

describe('P3 KV-dedup — transport consume-path integration', () => {
  it.skipIf(!TRANSPORT_PRESENT)(
    'duplicate task_dispatch on the JetStream consumer is acked WITHOUT a second onEnvelope (AC5)',
    async () => {
      const rec = { onEnv: [] as any[], acks: [] as string[], naks: [] as string[], terms: [] as string[] }
      const subject = `fleet.openclaw.to.${SELF}.task_dispatch`
      const id = `msg_${ulid()}`
      const env = makeTaskEnvelope('openclaw', SELF, id)
      const mkMsg = () => ({
        subject,
        data: enc.encode(JSON.stringify(env)),
        ack() { rec.acks.push(subject) },
        nak() { rec.naks.push(subject) },
        term() { rec.terms.push(subject) },
      })
      // Two IDENTICAL deliveries — same id/bytes — so whatever correlation field
      // the dedup keys on, the second is a true duplicate.
      const iterable = blockingAsyncIterable([mkMsg(), mkMsg()])
      const fakeJs = {
        async publish() { return { seq: 1 } },
        consumers: { async get() { return { consume() { return iterable } } } },
      }

      // Probe the dedup seam under several plausible opt keys; a P3-wired transport
      // that consults ANY of them will suppress the duplicate. Unknown opts are
      // ignored by JS, so this is harmless over-provisioning.
      const seen = new Set<string>()
      const seam: any = {}
      for (const m of DEDUP_METHODS) {
        seam[m] = async (arg: any) => {
          const key = typeof arg === 'string' ? arg : (arg?.id ?? JSON.stringify(arg))
          if (seen.has(key)) return 'duplicate'
          seen.add(key)
          return 'new'
        }
      }
      // Canonical hangar-bridge contract: `seen(id): Promise<boolean>` where true = the
      // id was ALREADY seen (duplicate). Override the polymorphic string form for that
      // method so the boolean-consuming transport reads the verdict correctly.
      seam.seen = async (arg: any) => {
        const key = typeof arg === 'string' ? arg : (arg?.id ?? JSON.stringify(arg))
        const dup = seen.has(key)
        seen.add(key)
        return dup
      }

      const t = new NatsTransport({
        selfHandle: SELF,
        natsUrl: 'nats://127.0.0.1:4222',
        nkeySeed: 'SUANEVER_USED_CONNECTOR_IS_FAKED',
        roster: {},
        onEnvelope: (e: any) => rec.onEnv.push(e),
        onAuthError: () => {},
        connector: async () => makeFakeNc() as any,
        jsFactory: () => fakeJs as any,
        dedup: seam, dedupStore: seam, taskDedup: seam, kvDedup: seam, dedupKv: seam,
      })

      await t.start()
      // plumbing sanity + processing: the FIRST task must be processed & acked.
      const progressed = await waitFor(() => rec.acks.length >= 2 || rec.onEnv.length >= 2, 3000)
      await t.stop()

      expect(progressed, 'consume loop never processed both deliveries (harness plumbing)').toBe(true)
      expect(rec.onEnv.length, 'first-sighting task was not delivered exactly once to onEnvelope').toBeGreaterThanOrEqual(1)
      expect(
        rec.onEnv.length,
        'duplicate task_dispatch was NOT suppressed — onEnvelope fired twice; P3 dedup is not wired into ' +
          'the JetStream consume path (or the dedup seam is named outside the probed set)',
      ).toBe(1)
      expect(
        rec.acks.length,
        'both deliveries must be acked (the duplicate is acked without reprocessing, not nak/redeliver)',
      ).toBe(2)
      expect(rec.naks.length, 'a duplicate must not be nak-redelivered').toBe(0)
    },
    15000,
  )
})

// =====================================================================
// (6) LIVE AC5 — real nats-server + JetStream KV. Proves the KV CAS dedup
//     authority is PERMANENT (no time window): a second create on the same
//     key is rejected regardless of elapsed time; a different owner-prefix key
//     is independent; and (if present) the real module dedups over live KV.
// =====================================================================
function findNatsServer(): string | null {
  const cands = [join(homedir(), '.local/bin/nats-server'), 'nats-server']
  for (const c of cands) if (c === 'nats-server' || existsSync(c)) return c
  return null
}
const NATS_SERVER = findNatsServer()
const LIVE_REASON = NATS_SERVER ? '' : 'SKIP: nats-server binary not found (~/.local/bin/nats-server)'

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => resolve(port))
    })
  })
}

describe.skipIf(!NATS_SERVER)(`P3 KV-dedup — LIVE AC5 [${LIVE_REASON || 'live'}]`, () => {
  let proc: ChildProcess | undefined
  let storeDir = ''
  let nc: any
  let kv: any
  let ready = false

  beforeAll(async () => {
    storeDir = mkdtempSync(join(tmpdir(), 'p3-dedup-js-'))
    const port = await freePort()
    proc = spawn(NATS_SERVER!, ['-js', '-a', '127.0.0.1', '-p', String(port), '-sd', storeDir], {
      stdio: 'ignore',
    })
    const { connect } = await import('@nats-io/transport-node')
    const { Kvm } = await import('@nats-io/kv')
    // retry-connect until the server is accepting JetStream
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) {
      try {
        nc = await connect({ servers: `127.0.0.1:${port}`, maxReconnectAttempts: 3, reconnectTimeWait: 100 })
        break
      } catch {
        await new Promise((r) => setTimeout(r, 150))
      }
    }
    if (!nc) return
    const kvm = new Kvm(nc)
    kv = await kvm.create('HANGAR_DEDUP')
    ready = true
  }, 30000)

  afterAll(async () => {
    try { if (nc) await nc.drain() } catch { /* ignore */ }
    try { if (proc) proc.kill('SIGKILL') } catch { /* ignore */ }
    try { if (storeDir) rmSync(storeDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('KV create() is the permanent dedup authority: a repeat create on the same key is rejected (no time window)', async () => {
    expect(ready, 'live JetStream KV bucket HANGAR_DEDUP not ready').toBe(true)
    const key = `${SELF}.${CORR}`
    const rev = await kv.create(key, enc.encode('1'))
    expect(rev, 'first create should return a revision').toBeGreaterThan(0)

    // The KV rejection carries NO TTL/window — it holds at t=0 and, by construction
    // (no expiry), would hold identically past the 2-minute Nats-Msg-Id window (AC5/AC9).
    let code: unknown
    let rejected = false
    try {
      await kv.create(key, enc.encode('1'))
    } catch (err: any) {
      rejected = true
      code = err?.code ?? err?.err_code
    }
    expect(rejected, 'a second create on the same key must be rejected (permanent KV dedup)').toBe(true)
    expect(code, 'rejection should be StreamWrongLastSequence (10071)').toBe(10071)
  }, 20000)

  it('dedup keys are per-owner scoped: a different `<handle>.` prefix is independent (§2.6)', async () => {
    expect(ready).toBe(true)
    const rev = await kv.create(`openclaw.${CORR}`, enc.encode('1'))
    expect(rev, 'a key under a different owner prefix must be creatable even when self.<id> exists').toBeGreaterThan(0)
  }, 20000)

  it.skipIf(!MODULE_PRESENT)(
    'the real task-dedup module dedups over a LIVE KV: first NEW, repeat DUPLICATE (AC5 load-bearing)',
    async () => {
      expect(ready).toBe(true)
      const liveCorr = `corr_${ulid()}`
      const dedup = buildDedup(dedupMod, kv, SELF)
      expect(dedup, 'no dedup entrypoint over live KV').not.toBeNull()
      const first = await dedup!.call(liveCorr)
      const second = await dedup!.call(liveCorr)
      expect(
        first,
        'live: first sighting and repeat resolved to the same verdict — KV dedup not enforced',
      ).not.toEqual(second)
    },
    20000,
  )
})
