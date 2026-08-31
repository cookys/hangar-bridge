import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { startHarness, type Harness } from '../harness.ts'

/**
 * The relay is the only chokepoint every sender must pass. A source-side guard
 * has to be installed per host, per user, per harness — and the harnesses that
 * cannot load one are exactly the ones nobody can gate. These tests pin what
 * the relay itself does with a fleet-wide broadcast.
 */
const post = (h: Harness, handle: string, body: unknown) =>
  fetch(new URL('/v1/messages', h.relayUrl), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${h.peers[handle]!.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })

describe('relay broadcast gate', () => {
  let h: Harness
  afterEach(async () => { await h?.cleanup() })

  describe('enforce', () => {
    beforeEach(async () => { h = await startHarness(['alice', 'bob'], { broadcastGate: 'enforce' }) })

    it('refuses an unqualified fleet-wide chat, and says how to comply', async () => {
      const res = await post(h, 'alice', { to: '@team', kind: 'chat', content: 'everyone!' })
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string; message: string }
      expect(body.error).toBe('unqualified_broadcast')
      // The clients here are models: a 400 carrying the fix IS the migration
      // mechanism, so the text must name the alternatives.
      expect(body.message).toContain('fleet_wide')
      expect(body.message).toMatch(/project/i)
    })

    it('allows it when the sender says fleet_wide', async () => {
      const res = await post(h, 'alice', { to: '@team', kind: 'chat', content: 'relay restarting', fleet_wide: true })
      expect(res.status).toBe(201)
    })

    it('allows a project-scoped broadcast', async () => {
      const res = await post(h, 'alice', { to: '@team', kind: 'chat', content: 'anyone on this?', to_filter: { repo: 'hangar' } })
      expect(res.status).toBe(201)
    })

    it('allows a directed message', async () => {
      const res = await post(h, 'alice', { to: 'bob', kind: 'chat', content: 'just you' })
      expect(res.status).toBe(201)
    })

    it('never blocks a permission_request — ask_team routes to @team', async () => {
      // Gating this would silently kill the permission flow rather than reduce
      // noise, which is the opposite of the intent.
      const res = await post(h, 'alice', { to: '@team', kind: 'permission_request', content: 'may I?' })
      expect(res.status).toBe(201)
    })
  })

  describe('warn (the default)', () => {
    beforeEach(async () => { h = await startHarness(['alice', 'bob']) })

    it('delivers an unqualified broadcast unchanged', async () => {
      // Upgrading the relay must not change delivery on its own: enforcement
      // waits until senders have a way to comply.
      const res = await post(h, 'alice', { to: '@team', kind: 'chat', content: 'everyone!' })
      expect(res.status).toBe(201)
    })
  })
})
