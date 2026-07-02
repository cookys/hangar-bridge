/**
 * P4 — INDEPENDENT, SPEC-DERIVED presence harness (decorrelated).
 *
 * Authored FROM THE SPEC (docs/plans/2026-07-02-relay-to-nats-migration.md §2 AC7,
 * §5 Phase 4), BLIND to the implementer's `presence-tracker.test.ts` /
 * `*-independent.test.ts`. Default-assume broken.
 *
 * AC7 (the contract being verified):
 *  - The periodic `presence_update` HEARTBEAT is the SOURCE OF TRUTH for online
 *    state: a peer is online IFF its last heartbeat is within a TTL window.
 *  - `$SYS` CONNECT/DISCONNECT events are OPTIONAL accelerants (low-latency
 *    arrival/departure hints). They must NEVER override the heartbeat TTL — a
 *    peer whose heartbeat is stale is OFFLINE even if the last $SYS event was
 *    CONNECT.
 *  - With `$SYS` suppressed entirely, presence still works from heartbeats alone.
 *
 * Discipline: every clock read is an INJECTED number (no wall-clock sleeps for
 * the tracker logic). Hooks are resolved via variable-specifier dynamic import
 * (tsc stays clean; the module surface is `any`). A missing hook SKIPs-with-
 * reason; a present-but-wrong hook FAILs.
 *
 * Module override hooks (used by the author's self-validation against mutants):
 *   P4_PRESENCE_MODULE   — specifier/URL for the presence-tracker module
 *   P4_TRANSPORT_MODULE  — specifier/URL for the nats-transport module
 *   P4_LIVE_NATS_URL     — if set, the clause-5 LIVE round-trip runs against it
 */
import { describe, it, expect } from 'vitest'

// ── Module resolution (variable specifier ⇒ tsc sees `any`, stays clean) ──────
const TRACKER_SPEC = process.env.P4_PRESENCE_MODULE ?? './presence-tracker.ts'
const TRANSPORT_SPEC = process.env.P4_TRANSPORT_MODULE ?? './nats-transport.ts'

let createPresenceTracker: ((ttlMs: number) => any) | undefined
let trackerLoadError: unknown
try {
  const m: any = await import(/* @vite-ignore */ TRACKER_SPEC)
  createPresenceTracker = m?.createPresenceTracker
} catch (e) {
  trackerLoadError = e
}

// Probe a live instance to learn which hooks exist (present-but-wrong ⇒ FAIL,
// absent ⇒ SKIP).
let probe: any
try {
  probe = typeof createPresenceTracker === 'function' ? createPresenceTracker(1000) : undefined
} catch (e) {
  trackerLoadError = trackerLoadError ?? e
}
const hasFn = (name: string): boolean => !!probe && typeof probe[name] === 'function'

const TRACKER_ABSENT = typeof createPresenceTracker !== 'function' || !probe
const H_HEARTBEAT = hasFn('onHeartbeat')
const H_ISONLINE = hasFn('isOnline')
const H_LASTSEEN = hasFn('lastSeen')
const H_SYSCONNECT = hasFn('onSysConnect')
const H_SYSDISCONNECT = hasFn('onSysDisconnect')

if (TRACKER_ABSENT) {
  // Surface WHY the whole suite went dark rather than silently passing green.
  // eslint-disable-next-line no-console
  console.warn(
    `[p4-independent] presence-tracker hooks ABSENT from "${TRACKER_SPEC}" — clauses 1-4 SKIP. ` +
      `createPresenceTracker=${typeof createPresenceTracker}` +
      (trackerLoadError ? ` loadError=${String((trackerLoadError as any)?.message ?? trackerLoadError)}` : ''),
  )
}

const TTL = 1000

describe('AC7 — heartbeat SoT (clause 1: no $SYS)', () => {
  const skip = TRACKER_ABSENT || !(H_HEARTBEAT && H_ISONLINE && H_LASTSEEN)

  it.skipIf(skip)('online after a heartbeat; still online AT the TTL boundary; OFFLINE once now-last>TTL', () => {
    const t = createPresenceTracker!(TTL)
    const t0 = 10_000
    t.onHeartbeat('alpha', t0)

    // Freshly heartbeated ⇒ online.
    expect(t.isOnline('alpha', t0)).toBe(true)
    // Clearly-within window ⇒ online.
    expect(t.isOnline('alpha', t0 + TTL - 1)).toBe(true)
    // Boundary: "within a TTL window" is inclusive (now-last === TTL) ⇒ online.
    expect(t.isOnline('alpha', t0 + TTL)).toBe(true)
    // One tick past the window (now-last > TTL) ⇒ OFFLINE. (A tracker that
    // ignores heartbeats stays online-never/always here ⇒ RED.)
    expect(t.isOnline('alpha', t0 + TTL + 1)).toBe(false)

    // lastSeen is the SoT heartbeat timestamp.
    expect(t.lastSeen('alpha')).toBe(t0)
  })

  it.skipIf(skip)('an unknown handle is OFFLINE with a null lastSeen', () => {
    const t = createPresenceTracker!(TTL)
    expect(t.isOnline('nobody', 12_345)).toBe(false)
    expect(t.lastSeen('nobody')).toBeNull()
  })
})

describe('AC7 — stale heartbeat overrides a cached $SYS CONNECT (clause 2, LOAD-BEARING)', () => {
  const skip = TRACKER_ABSENT || !(H_HEARTBEAT && H_SYSCONNECT && H_ISONLINE)

  it.skipIf(skip)('past BOTH TTLs the peer is OFFLINE even though the last $SYS event was CONNECT', () => {
    const t = createPresenceTracker!(TTL)
    const t0 = 0 // heartbeat
    const t1 = 500 // later $SYS CONNECT (the "cached CONNECT" impression)
    t.onHeartbeat('alpha', t0)
    t.onSysConnect('alpha', t1)

    // Pick a `now` that is past BOTH the heartbeat TTL and the CONNECT TTL.
    const now = t1 + TTL + 1 // 1501: now-t0=1501>1000 AND now-t1=1001>1000
    expect(now - t0).toBeGreaterThan(TTL)
    expect(now - t1).toBeGreaterThan(TTL)

    // The cached CONNECT must NOT keep it online. A broken tracker that lets a
    // CONNECT pin a peer online past the heartbeat TTL returns true here ⇒ RED.
    expect(t.isOnline('alpha', now)).toBe(false)
    // The SoT timestamp still reflects the heartbeat only, never the $SYS event.
    expect(t.lastSeen('alpha')).toBe(t0)
  })
})

describe('AC7 — $SYS CONNECT accelerant is TTL-bounded (clause 3)', () => {
  const skip = TRACKER_ABSENT || !(H_SYSCONNECT && H_ISONLINE && H_LASTSEEN)

  it.skipIf(skip)('a CONNECT with no heartbeat marks online immediately, then expires with no follow-up', () => {
    const t = createPresenceTracker!(TTL)
    const c = 2_000
    t.onSysConnect('alpha', c)

    // Optimistic online hint immediately, and up to its own TTL boundary.
    expect(t.isOnline('alpha', c)).toBe(true)
    expect(t.isOnline('alpha', c + TTL)).toBe(true)
    // But it is itself TTL-bounded: with no heartbeat, it expires.
    expect(t.isOnline('alpha', c + TTL + 1)).toBe(false)

    // A $SYS CONNECT is NOT a heartbeat: lastSeen (the SoT) stays null.
    expect(t.lastSeen('alpha')).toBeNull()
  })
})

describe('AC7 — $SYS DISCONNECT is an immediate offline hint (clause 4)', () => {
  const skip = TRACKER_ABSENT || !(H_HEARTBEAT && H_SYSDISCONNECT && H_ISONLINE)

  it.skipIf(skip)('a most-recent DISCONNECT marks offline even with a fresh heartbeat; a later heartbeat re-onlines', () => {
    const t = createPresenceTracker!(TTL)
    // Heartbeat is comfortably fresh…
    t.onHeartbeat('alpha', 100)
    expect(t.isOnline('alpha', 110)).toBe(true)

    // …but a DISCONNECT that is the most-recent signal wins immediately, even
    // though now-heartbeat (110) is well within TTL. (A tracker that ignores
    // DISCONNECT returns true ⇒ RED.)
    t.onSysDisconnect('alpha', 200)
    expect(t.isOnline('alpha', 210)).toBe(false)

    // A later heartbeat is once again the most-recent signal ⇒ re-online.
    t.onHeartbeat('alpha', 300)
    expect(t.isOnline('alpha', 310)).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Clause 5 — transport integration (if the tracker is wired into NatsTransport).
// Driven WITHOUT a live server via an in-memory NATS-subject bus so two real
// NatsTransport instances exchange a REAL presence_update envelope (no hand-
// crafted wire bytes). listPeers() must derive online/last_seen from the
// heartbeat SoT. An optional LIVE round-trip is env-gated (skip-with-reason).
// ─────────────────────────────────────────────────────────────────────────────

let NatsTransport: any
let transportLoadError: unknown
try {
  const m: any = await import(/* @vite-ignore */ TRANSPORT_SPEC)
  NatsTransport = m?.NatsTransport
} catch (e) {
  transportLoadError = e
}
const TRANSPORT_ABSENT = typeof NatsTransport !== 'function'

if (TRANSPORT_ABSENT) {
  // eslint-disable-next-line no-console
  console.warn(
    `[p4-independent] NatsTransport ABSENT from "${TRANSPORT_SPEC}" — clause 5 SKIPs.` +
      (transportLoadError ? ` loadError=${String((transportLoadError as any)?.message ?? transportLoadError)}` : ''),
  )
}

/** NATS subject matcher: `*` = one token, `>` = tail. */
function subjectMatches(filter: string, subject: string): boolean {
  const f = filter.split('.')
  const s = subject.split('.')
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '>') return true
    if (i >= s.length) return false
    if (f[i] === '*') continue
    if (f[i] !== s[i]) return false
  }
  return f.length === s.length
}

/** A minimal in-memory pub/sub broker shared across fake connections. */
function makeBus() {
  const subs: any[] = []
  return {
    publish(subject: string, data: Uint8Array) {
      for (const sub of subs) if (!sub.closed && subjectMatches(sub.filter, subject)) sub._push({ subject, data })
    },
    subscribe(filter: string) {
      const queue: any[] = []
      let pending: ((r: IteratorResult<any>) => void) | null = null
      const sub: any = {
        filter,
        subject: filter,
        closed: false,
        _push(msg: any) {
          if (pending) {
            const p = pending
            pending = null
            p({ value: msg, done: false })
          } else queue.push(msg)
        },
        unsubscribe() {
          this.closed = true
          if (pending) {
            const p = pending
            pending = null
            p({ value: undefined, done: true })
          }
        },
        [Symbol.asyncIterator]() {
          return {
            next: () => {
              if (queue.length) return Promise.resolve({ value: queue.shift(), done: false })
              if (sub.closed) return Promise.resolve({ value: undefined, done: true })
              return new Promise<IteratorResult<any>>((res) => {
                pending = res
              })
            },
          }
        },
      }
      subs.push(sub)
      return sub
    },
  }
}

/** A fake NatsConnection backed by the shared bus. */
function makeFakeConn(bus: ReturnType<typeof makeBus>) {
  return {
    subscribe: (filter: string) => bus.subscribe(filter),
    publish: (subject: string, payload: Uint8Array) => bus.publish(subject, payload),
    // watchStatus consumes this: yield nothing, finish immediately.
    status: () => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ value: undefined, done: true }) }) }),
    drain: async () => {},
  }
}

/** A fake JetStream client: consumers.get() parks forever (unblocked by stop). */
function makeFakeJs() {
  return { consumers: { get: () => new Promise(() => {}) }, publish: async () => ({}) }
}

const NEVER_HEARTBEAT_HANDLE = 'gamma'
const roster = {
  alpha: { owned: [], interest: [] },
  beta: { owned: [], interest: [] },
  [NEVER_HEARTBEAT_HANDLE]: { owned: [], interest: [] },
}

function newTransport(selfHandle: string, conn: any, now: () => number) {
  return new NatsTransport({
    selfHandle,
    natsUrl: 'nats://unused',
    // The fake connector bypasses connect(), so the seed is never decoded here.
    nkeySeed: 'SEED-UNUSED-fake-connector-bypasses-connect',
    roster,
    onEnvelope: () => {},
    onAuthError: () => {},
    connector: async () => conn,
    jsFactory: () => makeFakeJs(),
    dedup: { seen: async () => false }, // skip background KV open
    presenceTtlMs: TTL,
    heartbeatMs: 10_000_000, // effectively never; presence is driven explicitly
    now,
  })
}

async function flush(times = 40) {
  for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r))
}

async function pollPeer(
  tx: any,
  handle: string,
  predicate: (p: any) => boolean,
  tries = 60,
): Promise<any> {
  let last: any
  for (let i = 0; i < tries; i++) {
    const peers = await tx.listPeers()
    last = peers.find((p: any) => p.handle === handle)
    if (last && predicate(last)) return last
    await flush(5)
  }
  return last
}

describe('AC7 — transport integration: heartbeat drives listPeers (clause 5, in-memory bus)', () => {
  it.skipIf(TRANSPORT_ABSENT)('an inbound presence_update onlines the sender with a non-null last_seen; TTL expiry offlines it; a never-heartbeat peer is offline', async () => {
    const bus = makeBus()
    const clock = { t: 100_000 }
    const now = () => clock.t

    const alpha = newTransport('alpha', makeFakeConn(bus), now)
    const beta = newTransport('beta', makeFakeConn(bus), now)

    try {
      await alpha.start()
      await beta.start()

      // Before any heartbeat: beta is offline with a null last_seen.
      let peers = await alpha.listPeers()
      const betaBefore = peers.find((p: any) => p.handle === 'beta')
      expect(betaBefore).toBeTruthy()
      expect(betaBefore.online).toBe(false)
      expect(betaBefore.last_seen).toBeNull()

      // beta emits a real presence_update heartbeat (its own handle → team lane).
      const hbTime = clock.t
      await beta.setPresence({ summary: 'beta up' })

      // alpha's inbound loop records the heartbeat ⇒ beta online, last_seen set.
      const betaOnline = await pollPeer(alpha, 'beta', (p) => p.online === true)
      expect(betaOnline?.online).toBe(true)
      expect(betaOnline?.last_seen).toBe(new Date(hbTime).toISOString())

      // At the exact TTL boundary: still online (inclusive window).
      clock.t = hbTime + TTL
      peers = await alpha.listPeers()
      expect(peers.find((p: any) => p.handle === 'beta').online).toBe(true)

      // One tick past TTL: OFFLINE — but last_seen (SoT) is retained, non-null.
      clock.t = hbTime + TTL + 1
      peers = await alpha.listPeers()
      const betaStale = peers.find((p: any) => p.handle === 'beta')
      expect(betaStale.online).toBe(false)
      expect(betaStale.last_seen).toBe(new Date(hbTime).toISOString())

      // A roster peer that never heartbeats is offline with a null last_seen.
      const gamma = peers.find((p: any) => p.handle === NEVER_HEARTBEAT_HANDLE)
      expect(gamma.online).toBe(false)
      expect(gamma.last_seen).toBeNull()

      // A peer is never "online" to itself.
      expect(peers.find((p: any) => p.handle === 'alpha').online).toBe(false)
    } finally {
      await alpha.stop().catch(() => {})
      await beta.stop().catch(() => {})
    }
  })
})

describe('AC7 — transport integration: LIVE nats-server round-trip (clause 5b, strongest proof)', () => {
  const LIVE_URL = process.env.P4_LIVE_NATS_URL
  const liveSkip = TRANSPORT_ABSENT || !LIVE_URL

  if (!LIVE_URL) {
    // eslint-disable-next-line no-console
    console.warn('[p4-independent] clause 5b LIVE SKIP — set P4_LIVE_NATS_URL to a running nats-server to run it.')
  }

  it.skipIf(liveSkip)('a real presence_update over nats-server onlines the sender; TTL expiry offlines it', async () => {
    const clock = { t: 100_000 }
    const now = () => clock.t
    // Mint an ephemeral, valid-format user nkey seed at runtime (nothing
    // committed). A no-auth dev server never challenges it, but the client
    // decodes the seed eagerly, so it must be well-formed.
    const { nkeys }: any = await import(/* @vite-ignore */ '@nats-io/transport-node')
    const liveSeed = new TextDecoder().decode(nkeys.createUser().getSeed())
    const mk = (selfHandle: string) =>
      new NatsTransport({
        selfHandle,
        natsUrl: LIVE_URL,
        nkeySeed: liveSeed,
        roster,
        onEnvelope: () => {},
        onAuthError: () => {},
        // Real connector (default) → real NATS round-trip. JetStream stubbed so
        // the presence path needs no provisioned stream.
        jsFactory: () => makeFakeJs(),
        dedup: { seen: async () => false },
        presenceTtlMs: TTL,
        heartbeatMs: 10_000_000,
        now,
      })

    const alpha = mk('alpha')
    const beta = mk('beta')
    try {
      await alpha.start()
      await beta.start()
      await flush(20)

      const hbTime = clock.t
      await beta.setPresence({ summary: 'beta up (live)' })

      const betaOnline = await pollPeer(alpha, 'beta', (p) => p.online === true, 200)
      expect(betaOnline?.online).toBe(true)
      expect(betaOnline?.last_seen).toBe(new Date(hbTime).toISOString())

      clock.t = hbTime + TTL + 1
      const peers = await alpha.listPeers()
      expect(peers.find((p: any) => p.handle === 'beta').online).toBe(false)
    } finally {
      await alpha.stop().catch(() => {})
      await beta.stop().catch(() => {})
    }
  })
})
