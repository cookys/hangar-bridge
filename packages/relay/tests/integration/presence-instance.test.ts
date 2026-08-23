import { describe, it, expect, beforeEach } from 'vitest'
import { newInstanceId, HANGAR_TEAM_ID } from '@hangar-bridge/shared'
import { openDatabase, type Db } from '../../src/db/db.ts'
import { MessageStore } from '../../src/messages/store.ts'
import { Fanout } from '../../src/fanout.ts'
import { PresenceRegistry } from '../../src/presence/registry.ts'
import { buildApp } from '../../src/app.ts'
import { seedPeerSecrets } from './_seed.ts'
import { ClaimStore } from '../../src/claims/store.ts'

/**
 * P2 — presence uniqueness per PROCESS, not per token label.
 *
 * Every peer on a host shares one secret, so `token.label` is the same
 * ('shared-secret') for every session. Before this change two Claude Code
 * sessions wrote and deleted the SAME registry row: whichever disconnected
 * first erased the survivor, which then read as offline for up to the TTL.
 */
describe('presence instance uniqueness', () => {
  let db: Db
  let app: ReturnType<typeof buildApp>
  let presence: PresenceRegistry
  let token: string

  beforeEach(() => {
    db = openDatabase(':memory:')
    const peers = seedPeerSecrets(db, ['alice', 'bob'])
    token = peers.alice!.token
    presence = new PresenceRegistry()
    app = buildApp({
      db,
      store: new MessageStore(db),
      fanout: new Fanout(),
      presence,
      claims: new ClaimStore(db),
      now: () => new Date(),
    })
  })

  const postPresence = (body: Record<string, unknown>) =>
    app.request('/v1/presence', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  // Read the registry directly for multi-step assertions: GET /v1/peers memoizes
  // its body for 2s, so two reads inside one test would return the same snapshot.
  // The HTTP surface itself is asserted in the dedicated test below.
  const listSessions = async (): Promise<any[]> =>
    (presence.get(HANGAR_TEAM_ID, 'alice')?.sessions ?? []) as any[]

  const peersSessions = async (): Promise<any[]> => {
    const res = await app.request('/v1/peers', { headers: { authorization: `Bearer ${token}` } })
    const list = await res.json() as any[]
    return list.find(p => p.handle === 'alice')?.sessions ?? []
  }

  const openStream = (instance?: string) => {
    const ac = new AbortController()
    const headers: Record<string, string> = { authorization: `Bearer ${token}` }
    if (instance) headers['x-hangar-instance'] = instance
    const res = app.request('/v1/stream', { headers, signal: ac.signal })
    return { ac, res }
  }

  it('keys the presence row on tokenLabel#instance', async () => {
    const inst = newInstanceId()
    expect((await postPresence({ summary: 'one', instance: inst })).status).toBe(200)
    const sessions = await listSessions()
    expect(sessions).toHaveLength(1)
    expect(sessions[0].label).toBe(`shared-secret#${inst}`)
    expect(sessions[0].instance).toBe(inst)
  })

  it('GET /v1/peers surfaces instance, worktree, delivery_state and caps', async () => {
    const inst = newInstanceId()
    await postPresence({
      summary: 'x', instance: inst, worktree: 'agent-1',
      delivery_state: 'verified', caps: 'disposition',
    })
    const s = (await peersSessions())[0]
    expect(s).toMatchObject({
      label: `shared-secret#${inst}`,
      instance: inst,
      worktree: 'agent-1',
      delivery_state: 'verified',
      caps: 'disposition',
    })
  })

  it('two processes on one shared secret keep SEPARATE presence rows', async () => {
    const a = newInstanceId()
    const b = newInstanceId()
    await postPresence({ summary: 'session A', instance: a, cwd: '/repo/a' })
    await postPresence({ summary: 'session B', instance: b, cwd: '/repo/b' })
    const sessions = await listSessions()
    expect(sessions).toHaveLength(2)
    expect(sessions.map((s: any) => s.cwd).sort()).toEqual(['/repo/a', '/repo/b'])
  })

  it('a legacy client with no instance keeps exactly the current behavior', async () => {
    await postPresence({ summary: 'legacy' })
    const sessions = await listSessions()
    expect(sessions).toHaveLength(1)
    expect(sessions[0].label).toBe('shared-secret')
    expect(sessions[0].instance).toBeUndefined()
  })

  it('a legacy row and an instance row never collide', async () => {
    await postPresence({ summary: 'legacy' })
    await postPresence({ summary: 'modern', instance: newInstanceId() })
    expect(await listSessions()).toHaveLength(2)
  })

  it('rejects a malformed instance rather than composing it into a row key', async () => {
    const res = await postPresence({ summary: 'x', instance: 'not#a#ulid' })
    expect(res.status).toBe(400)
  })

  it('carries worktree metadata on the presence row', async () => {
    await postPresence({
      summary: 'foreman',
      instance: newInstanceId(),
      cwd: '/repo/.claude/worktrees/agent-1',
      worktree: 'agent-1',
      repo: 'hangar-bridge',
      branch: 'feat/x',
    })
    const s = (await listSessions())[0]
    expect(s.worktree).toBe('agent-1')
    expect(s.cwd).toBe('/repo/.claude/worktrees/agent-1')
  })

  describe('delivery_state', () => {
    it('defaults to unverified when the client does not report one', async () => {
      await postPresence({ summary: 'x', instance: newInstanceId() })
      expect((await listSessions())[0].delivery_state).toBe('unverified')
    })

    it('surfaces a reported deaf state on /v1/peers', async () => {
      await postPresence({ summary: 'x', instance: newInstanceId(), delivery_state: 'deaf' })
      expect((await listSessions())[0].delivery_state).toBe('deaf')
    })

    it('surfaces a reported verified state on /v1/peers', async () => {
      await postPresence({ summary: 'x', instance: newInstanceId(), delivery_state: 'verified' })
      expect((await listSessions())[0].delivery_state).toBe('verified')
    })

    it('rejects an unknown delivery_state', async () => {
      const res = await postPresence({ summary: 'x', delivery_state: 'probably-fine' })
      expect(res.status).toBe(400)
    })
  })

  describe('capability bits', () => {
    it('surfaces declared caps so telemetry can gate its denominator', async () => {
      await postPresence({ summary: 'x', instance: newInstanceId(), caps: 'disposition' })
      expect((await listSessions())[0].caps).toBe('disposition')
    })

    it('omits caps for a peer that declares none (old binary, excluded from telemetry)', async () => {
      await postPresence({ summary: 'x', instance: newInstanceId() })
      expect((await listSessions())[0].caps).toBeUndefined()
    })
  })

  describe('SSE cleanup', () => {
    it('removes only the disconnecting instance row, not its sibling', async () => {
      const a = newInstanceId()
      const b = newInstanceId()
      await postPresence({ summary: 'A', instance: a })
      await postPresence({ summary: 'B', instance: b })

      const sa = openStream(a)
      const sb = openStream(b)
      await sa.res
      await sb.res

      sa.ac.abort()
      await new Promise(r => setTimeout(r, 20))

      const sessions = await listSessions()
      expect(sessions).toHaveLength(1)
      expect(sessions[0].instance).toBe(b)
      sb.ac.abort()
    })

    it('keeps the presence row while another connection for the SAME instance is live', async () => {
      // The reconnect race: the new SSE is up before the old socket finishes
      // tearing down. A per-connection remove would blank a live session.
      const inst = newInstanceId()
      await postPresence({ summary: 'A', instance: inst })

      const first = openStream(inst)
      const second = openStream(inst)
      await first.res
      await second.res

      first.ac.abort()
      await new Promise(r => setTimeout(r, 20))
      expect(await listSessions()).toHaveLength(1)

      second.ac.abort()
      await new Promise(r => setTimeout(r, 20))
      expect(await listSessions()).toHaveLength(0)
    })

    it('cleanup runs at most once per connection (abort listener + finally)', async () => {
      // stream.ts has TWO cleanup paths for one connection — the abort listener
      // and the `finally` of the read loop. Without a once-guard the refcount
      // would be decremented twice and a sibling connection's row would be
      // removed. Two connections, one aborted: the survivor must remain.
      const inst = newInstanceId()
      await postPresence({ summary: 'A', instance: inst })
      const first = openStream(inst)
      const second = openStream(inst)
      await first.res
      await second.res

      first.ac.abort()
      await new Promise(r => setTimeout(r, 50))
      expect(await listSessions()).toHaveLength(1)
      second.ac.abort()
    })

    it('a legacy stream (no instance header) still cleans up its bare-label row', async () => {
      await postPresence({ summary: 'legacy' })
      const s = openStream()
      await s.res
      s.ac.abort()
      await new Promise(r => setTimeout(r, 20))
      expect(await listSessions()).toHaveLength(0)
    })

    it('a legacy stream never deletes an instance-keyed row', async () => {
      const inst = newInstanceId()
      await postPresence({ summary: 'modern', instance: inst })
      const s = openStream()
      await s.res
      s.ac.abort()
      await new Promise(r => setTimeout(r, 20))
      const sessions = await listSessions()
      expect(sessions).toHaveLength(1)
      expect(sessions[0].instance).toBe(inst)
    })

    it('rejects a malformed x-hangar-instance header', async () => {
      const res = await app.request('/v1/stream', {
        headers: { authorization: `Bearer ${token}`, 'x-hangar-instance': 'bogus' },
      })
      expect(res.status).toBe(400)
    })

    /**
     * ACCEPTED RESIDUAL (plan §P2, Fable m4) — DO NOT try to fix this in a test.
     *
     * A heartbeat POST /v1/presence already in flight when the final SSE
     * connection closes can re-create the row after cleanup removed it. The
     * row then lives out the presence TTL (90s) before ageing away. This is
     * bounded, self-healing, and cheaper than a cross-request write barrier;
     * a test that asserted "removed forever" would be flaky by construction.
     */
    it('accepted residual: a post-cleanup heartbeat revives the row for up to the TTL', async () => {
      const inst = newInstanceId()
      await postPresence({ summary: 'A', instance: inst })
      const s = openStream(inst)
      await s.res
      s.ac.abort()
      await new Promise(r => setTimeout(r, 20))
      expect(await listSessions()).toHaveLength(0)

      // the in-flight heartbeat lands after cleanup
      await postPresence({ summary: 'A', instance: inst })
      expect(await listSessions()).toHaveLength(1)
    })
  })
})
