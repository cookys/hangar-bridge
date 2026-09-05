import { describe, it, expect, beforeEach } from 'vitest'
import { openDatabase, type Db } from '../db/db.ts'
import { MessageStore, type FinalizeGrantResult } from './store.ts'
import type { OutboundMessage } from '@hangar-bridge/shared'

function seed(db: Db) {
  const now = new Date().toISOString()
  db.prepare("INSERT INTO team(id,name,retention_days,created_at) VALUES (?,?,?,?)")
    .run('t1', 'acme', 7, now)
  for (const h of ['alice', 'bob', 'charlie']) {
    db.prepare("INSERT INTO human(id,team_id,handle,display_name,created_at) VALUES (?,?,?,?,?)")
      .run(`h_${h}`, 't1', h, h, now)
  }
}

describe('MessageStore', () => {
  let db: Db
  let store: MessageStore
  beforeEach(() => { db = openDatabase(':memory:'); seed(db); store = new MessageStore(db) })

  it('assigns id/from/sent_at and returns the full envelope', () => {
    const inbound: OutboundMessage = { to: 'bob', kind: 'chat', content: 'hi' }
    const e = store.insert('t1', 'alice', inbound)
    expect(e.id).toMatch(/^msg_/)
    expect(e.from).toBe('alice')
    expect(e.to).toBe('bob')
    expect(e.sent_at).toBeTruthy()
    expect(e.delivered_at).toBeNull()
    expect(e.thread_root).toBeNull()
  })

  it('denormalizes thread_root from in_reply_to chain', () => {
    const root = store.insert('t1', 'alice', { to: 'bob', kind: 'chat', content: 'root' })
    const r1 = store.insert('t1', 'bob', {
      to: 'alice', kind: 'chat', content: 'r1', in_reply_to: root.id
    })
    const r2 = store.insert('t1', 'alice', {
      to: 'bob', kind: 'chat', content: 'r2', in_reply_to: r1.id
    })
    expect(r1.thread_root).toBe(root.id)
    expect(r2.thread_root).toBe(root.id)
  })

  it('rejects unknown recipient handle', () => {
    expect(() => store.insert('t1', 'alice', {
      to: 'mallory', kind: 'chat', content: 'x'
    })).toThrow(/unknown recipient/)
  })

  it('allows broadcast with no other team members (stored as no-op fanout)', () => {
    // Broadcast with no other peers is NOT an error — it's just a no-op fanout.
    const e = store.insert('t1', 'alice', { to: '@team', kind: 'chat', content: 'anyone?' })
    expect(e.to).toBe('@team')
  })

  it('rejects permission_verdict without in_reply_to', () => {
    expect(() => store.insert('t1', 'alice', {
      to: 'bob', kind: 'permission_verdict', content: '',
      meta: { request_id: 'abcde', behavior: 'allow' }
    } as OutboundMessage)).toThrow(/in_reply_to/)
  })

  it('fetchSince returns messages after the given ULID ordered ascending', () => {
    const a = store.insert('t1', 'alice', { to: 'bob', kind: 'chat', content: '1' })
    const b = store.insert('t1', 'alice', { to: 'bob', kind: 'chat', content: '2' })
    const c = store.insert('t1', 'alice', { to: 'bob', kind: 'chat', content: '3' })
    const list = store.fetchSince('t1', 'bob', a.id)
    expect(list.map(e => e.id)).toEqual([b.id, c.id])
  })

  it('fetchPendingSince returns undelivered messages after the cursor', () => {
    const a = store.insert('t1', 'alice', { to: 'bob', kind: 'chat', content: '1' })
    store.markDelivered(a.id)
    store.insert('t1', 'alice', { to: 'bob', kind: 'chat', content: '2' })
    const pending = store.fetchPendingSince('t1', 'bob', '')
    expect(pending).toHaveLength(1)
    expect(pending[0]!.content).toBe('2')
  })

  it('markDelivered is idempotent', () => {
    const a = store.insert('t1', 'alice', { to: 'bob', kind: 'chat', content: '1' })
    store.markDelivered(a.id)
    expect(() => store.markDelivered(a.id)).not.toThrow()
  })
})

describe('MessageStore reply routing (REPLY_ROUTING_SPEC.md §3.1, §8.1, §8.2)', () => {
  let db: Db
  let store: MessageStore
  beforeEach(() => { db = openDatabase(':memory:'); seed(db); store = new MessageStore(db) })

  const route = (overrides: Partial<Parameters<MessageStore['insertRoute']>[0]> = {}): Parameters<MessageStore['insertRoute']>[0] => ({
    msg_id: 'msg_r1', team_id: 't1', from_handle: 'alice', to_handle: 'bob',
    thread_root: 'msg_r1', created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  })

  it('insertRoute + getRoute round-trip', () => {
    store.insertRoute(route())
    const r = store.getRoute('msg_r1')
    expect(r?.from_handle).toBe('alice')
    expect(r?.to_handle).toBe('bob')
    expect(r?.thread_root).toBe('msg_r1')
    expect(r?.legacy_width).toBeNull()
  })

  it('getRoute returns null for an unknown id', () => {
    expect(store.getRoute('msg_missing')).toBeNull()
  })

  it('getRouteByCorrelation finds by correlation_id, null when absent', () => {
    store.insertRoute(route({ correlation_id: 'corr-1' }))
    expect(store.getRouteByCorrelation('corr-1')?.msg_id).toBe('msg_r1')
    expect(store.getRouteByCorrelation('corr-missing')).toBeNull()
  })

  it('getLiveRoute returns null once expires_at is in the past, the route otherwise', () => {
    store.insertRoute(route({ expires_at: '2026-01-01T00:00:00.000Z' }))
    expect(store.getLiveRoute('msg_r1', '2026-01-02T00:00:00.000Z')).toBeNull()
    expect(store.getLiveRoute('msg_r1', '2026-01-01T00:00:00.000Z')).not.toBeNull()
  })

  it('getLiveRoute never expires a durable route (expires_at NULL)', () => {
    store.insertRoute(route())
    expect(store.getLiveRoute('msg_r1', '2099-01-01T00:00:00.000Z')).not.toBeNull()
  })

  it('getLiveRoute returns null for an unknown id', () => {
    expect(store.getLiveRoute('msg_missing', '2026-01-01T00:00:00.000Z')).toBeNull()
  })

  it('tombstoneRoute sets unaddressable_at without deleting the row', () => {
    store.insertRoute(route())
    store.tombstoneRoute('msg_r1', '2026-01-02T00:00:00.000Z')
    const r = store.getRoute('msg_r1')
    expect(r?.unaddressable_at).toBe('2026-01-02T00:00:00.000Z')
    expect(r?.msg_id).toBe('msg_r1')
  })

  it('insertGrants inserts one grant per snapshot entry and ignores a duplicate', () => {
    store.insertRoute(route())
    store.insertGrants('msg_r1', [
      { handle: 'bob', instance: 'inst-1' },
      { handle: 'bob', instance: 'inst-1' },
    ])
    expect(store.hasGrant('msg_r1', 'bob', 'inst-1')).toBe(true)
    const count = db.prepare("SELECT COUNT(*) AS n FROM reply_grant WHERE msg_id='msg_r1'").get() as { n: number }
    expect(count.n).toBe(1)
  })

  it('insertGrants defaults selector to the empty string', () => {
    store.insertRoute(route())
    store.insertGrants('msg_r1', [{ handle: 'bob', instance: 'inst-1' }])
    const row = db.prepare(
      "SELECT selector FROM reply_grant WHERE msg_id='msg_r1' AND handle='bob' AND instance='inst-1'"
    ).get() as { selector: string }
    expect(row.selector).toBe('')
  })

  it('hasGrant checks the full composite key including selector', () => {
    store.insertRoute(route())
    store.insertGrants('msg_r1', [{ handle: 'bob', instance: 'inst-1', selector: 'pane@gen1' }])
    expect(store.hasGrant('msg_r1', 'bob', 'inst-1', 'pane@gen1')).toBe(true)
    expect(store.hasGrant('msg_r1', 'bob', 'inst-1')).toBe(false)
    expect(store.hasGrant('msg_r1', 'charlie', 'inst-1', 'pane@gen1')).toBe(false)
  })

  describe('finalizeGrant state machine (§8.1)', () => {
    it('replaces a blank-selector grant with the selector', () => {
      store.insertRoute(route())
      store.insertGrants('msg_r1', [{ handle: 'bob', instance: 'inst-1' }])
      expect(store.finalizeGrant('msg_r1', 'bob', 'inst-1', 'pane@gen1')).toBe('replaced')
      expect(store.hasGrant('msg_r1', 'bob', 'inst-1')).toBe(false)
      expect(store.hasGrant('msg_r1', 'bob', 'inst-1', 'pane@gen1')).toBe(true)
      const count = db.prepare("SELECT COUNT(*) AS n FROM reply_grant WHERE msg_id='msg_r1'").get() as { n: number }
      expect(count.n).toBe(1)
    })

    it('is a no-op when the exact non-blank grant already exists', () => {
      store.insertRoute(route())
      store.insertGrants('msg_r1', [{ handle: 'bob', instance: 'inst-1', selector: 'pane@gen1' }])
      expect(store.finalizeGrant('msg_r1', 'bob', 'inst-1', 'pane@gen1')).toBe('exists')
      const count = db.prepare("SELECT COUNT(*) AS n FROM reply_grant WHERE msg_id='msg_r1'").get() as { n: number }
      expect(count.n).toBe(1)
    })

    it('inserts alongside an existing different non-blank grant (widening)', () => {
      store.insertRoute(route())
      store.insertGrants('msg_r1', [{ handle: 'bob', instance: 'inst-1', selector: 'pane@gen1' }])
      expect(store.finalizeGrant('msg_r1', 'bob', 'inst-1', 'pane@gen2')).toBe('inserted')
      expect(store.hasGrant('msg_r1', 'bob', 'inst-1', 'pane@gen1')).toBe(true)
      expect(store.hasGrant('msg_r1', 'bob', 'inst-1', 'pane@gen2')).toBe(true)
    })

    it('returns null when neither a blank nor a non-blank grant exists', () => {
      store.insertRoute(route())
      expect(store.finalizeGrant('msg_r1', 'bob', 'inst-1', 'pane@gen1')).toBeNull()
      expect(store.hasGrant('msg_r1', 'bob', 'inst-1', 'pane@gen1')).toBe(false)
    })

    it('tolerates a blank grant AND the exact target selector both already present (does not throw on the PK)', () => {
      // A stray/racing state: the blank row was never cleaned up after an
      // earlier finalise that already granted this exact selector. The
      // 'replaced' branch's plain INSERT would previously throw on
      // reply_grant's PRIMARY KEY here.
      store.insertRoute(route())
      store.insertGrants('msg_r1', [
        { handle: 'bob', instance: 'inst-1', selector: '' },
        { handle: 'bob', instance: 'inst-1', selector: 'pane@gen1' },
      ])
      let result: FinalizeGrantResult | undefined
      expect(() => { result = store.finalizeGrant('msg_r1', 'bob', 'inst-1', 'pane@gen1') }).not.toThrow()
      expect(result).toBe('exists')
      expect(store.hasGrant('msg_r1', 'bob', 'inst-1')).toBe(false)               // blank never survives
      expect(store.hasGrant('msg_r1', 'bob', 'inst-1', 'pane@gen1')).toBe(true)
      const count = db.prepare("SELECT COUNT(*) AS n FROM reply_grant WHERE msg_id='msg_r1'").get() as { n: number }
      expect(count.n).toBe(1)
    })
  })

  describe('writeRouteAndMessage (§3.2 write order: route + grants + message, one transaction)', () => {
    it('writes the route, grants, and the message row all inside one transaction', () => {
      const built = store.insert('t1', 'alice', { to: 'bob', kind: 'chat', content: 'placeholder' })
      // Simulate the route handler's flow: build the envelope first (above,
      // just to get a real id shape), then call the atomic write with a
      // FRESH id so we can assert route+grant+message all land together.
      const msgId = 'msg_atomic1'
      store.writeRouteAndMessage({
        route: {
          msg_id: msgId, team_id: 't1', from_handle: 'alice', sender_instance: 'inst-a',
          to_handle: 'bob', thread_root: msgId, created_at: '2026-01-01T00:00:00.000Z',
        },
        grants: [{ handle: 'bob', instance: 'inst-b', selector: '' }],
        envelope: { ...built, id: msgId },
        persistMessage: true,
      })
      expect(store.getRoute(msgId)).not.toBeNull()
      expect(store.hasGrant(msgId, 'bob', 'inst-b')).toBe(true)
      const row = db.prepare('SELECT id FROM message WHERE id=?').get(msgId)
      expect(row).toBeTruthy()
    })

    it('skips the message insert when persistMessage is false (ephemeral directed chat)', () => {
      const built = store.insert('t1', 'alice', { to: 'bob', kind: 'chat', content: 'placeholder' })
      const msgId = 'msg_ephemeral1'
      store.writeRouteAndMessage({
        route: {
          msg_id: msgId, team_id: 't1', from_handle: 'alice', to_handle: 'bob',
          thread_root: msgId, created_at: '2026-01-01T00:00:00.000Z',
          expires_at: '2026-01-08T00:00:00.000Z',
        },
        grants: [],
        envelope: { ...built, id: msgId },
        persistMessage: false,
      })
      expect(store.getRoute(msgId)).not.toBeNull()
      const row = db.prepare('SELECT id FROM message WHERE id=?').get(msgId)
      expect(row).toBeUndefined()
    })

    it('skips the route entirely when `route` is null (protocol kinds)', () => {
      const built = store.insert('t1', 'alice', { to: 'bob', kind: 'chat', content: 'placeholder' })
      const msgId = 'msg_noroute1'
      store.writeRouteAndMessage({
        route: null,
        grants: [],
        envelope: { ...built, id: msgId, kind: 'presence_update' },
        persistMessage: true,
      })
      expect(store.getRoute(msgId)).toBeNull()
      const row = db.prepare('SELECT id FROM message WHERE id=?').get(msgId)
      expect(row).toBeTruthy()
    })

    it('rolls back the message insert if the route insert fails (atomicity)', () => {
      const built = store.insert('t1', 'alice', { to: 'bob', kind: 'chat', content: 'placeholder' })
      const msgId = 'msg_atomic_fail1'
      // A duplicate msg_id on the route (PK violation) forces the route
      // insert to throw; the message row must not survive it.
      store.insertRoute({
        msg_id: msgId, team_id: 't1', from_handle: 'alice', to_handle: 'bob',
        thread_root: msgId, created_at: '2026-01-01T00:00:00.000Z',
      })
      expect(() => store.writeRouteAndMessage({
        route: {
          msg_id: msgId, team_id: 't1', from_handle: 'alice', to_handle: 'bob',
          thread_root: msgId, created_at: '2026-01-01T00:00:00.000Z',
        },
        grants: [],
        envelope: { ...built, id: msgId },
        persistMessage: true,
      })).toThrow()
      const row = db.prepare('SELECT id FROM message WHERE id=?').get(msgId)
      expect(row).toBeUndefined()
    })
  })

  it('fetchMailboxSince returns only that handle\'s mailbox rows, ascending, without marking delivered', () => {
    const now = new Date().toISOString()
    const insMsg = db.prepare(`
      INSERT INTO message(id,v,team_id,from_handle,to_handle,kind,content,meta_json,sent_at)
      VALUES (?,?,?,?,?,?,?,?,?)
    `)
    insMsg.run('msg_mb1', 2, 't1', 'alice', '@mailbox:bob', 'chat', 'for bob 1', '{}', now)
    insMsg.run('msg_mb2', 2, 't1', 'alice', '@mailbox:charlie', 'chat', 'for charlie', '{}', now)
    insMsg.run('msg_mb3', 2, 't1', 'alice', '@mailbox:bob', 'chat', 'for bob 2', '{}', now)

    const list = store.fetchMailboxSince('bob', '', 100)
    expect(list.map(e => e.id)).toEqual(['msg_mb1', 'msg_mb3'])
    expect(list.every(e => e.delivered_at === null)).toBe(true)

    const row = db.prepare("SELECT delivered_at FROM message WHERE id='msg_mb1'").get() as { delivered_at: string | null }
    expect(row.delivered_at).toBeNull()
  })

  it('fetchMailboxSince respects the since_id cursor and limit', () => {
    const now = new Date().toISOString()
    const insMsg = db.prepare(`
      INSERT INTO message(id,v,team_id,from_handle,to_handle,kind,content,meta_json,sent_at)
      VALUES (?,?,?,?,?,?,?,?,?)
    `)
    insMsg.run('msg_mb1', 2, 't1', 'alice', '@mailbox:bob', 'chat', '1', '{}', now)
    insMsg.run('msg_mb2', 2, 't1', 'alice', '@mailbox:bob', 'chat', '2', '{}', now)
    insMsg.run('msg_mb3', 2, 't1', 'alice', '@mailbox:bob', 'chat', '3', '{}', now)

    expect(store.fetchMailboxSince('bob', 'msg_mb1', 100).map(e => e.id)).toEqual(['msg_mb2', 'msg_mb3'])
    expect(store.fetchMailboxSince('bob', '', 1).map(e => e.id)).toEqual(['msg_mb1'])
  })
})

describe('drain self-exclusion (REPLY_ROUTING_SPEC.md §4)', () => {
  let db: Db
  let store: MessageStore
  beforeEach(() => { db = openDatabase(':memory:'); seed(db); store = new MessageStore(db) })

  it('fetchSince excludes a durable bare-handle self-send for the SENDING instance, includes it for another', () => {
    store.insert('t1', 'alice', {
      to: 'alice', kind: 'chat', content: 'note to self', meta: { sender_instance: 'inst-A' },
    })
    expect(store.fetchSince('t1', 'alice', '', 'inst-A')).toHaveLength(0)
    expect(store.fetchSince('t1', 'alice', '', 'inst-B')).toHaveLength(1)
  })

  it('fetchSince is byte-identical to today when no pollerInstance is given', () => {
    store.insert('t1', 'alice', {
      to: 'alice', kind: 'chat', content: 'note to self', meta: { sender_instance: 'inst-A' },
    })
    expect(store.fetchSince('t1', 'alice', '')).toHaveLength(1)
  })

  it('fetchPendingSince applies the same self-exclusion when given a poller instance', () => {
    store.insert('t1', 'alice', {
      to: 'alice', kind: 'chat', content: 'note', meta: { sender_instance: 'inst-A' },
    })
    expect(store.fetchPendingSince('t1', 'alice', '', 'inst-A')).toHaveLength(0)
    expect(store.fetchPendingSince('t1', 'alice', '', 'inst-B')).toHaveLength(1)
    expect(store.fetchPendingSince('t1', 'alice', '')).toHaveLength(1)
  })

  it('fetchInboxSince applies the same self-exclusion when given a poller instance', () => {
    store.insert('t1', 'alice', {
      to: 'alice', kind: 'chat', content: 'note', meta: { sender_instance: 'inst-A' },
    })
    expect(store.fetchInboxSince('t1', 'alice', '', 100, 'inst-A')).toHaveLength(0)
    expect(store.fetchInboxSince('t1', 'alice', '', 100, 'inst-B')).toHaveLength(1)
    expect(store.fetchInboxSince('t1', 'alice', '', 100)).toHaveLength(1)
  })

  it('a legacy self-send with no sender_instance in meta is still delivered (no way to tell apart)', () => {
    store.insert('t1', 'alice', { to: 'alice', kind: 'chat', content: 'legacy note to self' })
    expect(store.fetchSince('t1', 'alice', '', 'inst-A')).toHaveLength(1)
  })

  it('@team rows are unaffected by pollerInstance (that exclusion is already by whole handle)', () => {
    store.insert('t1', 'alice', { to: '@team', kind: 'chat', content: 'hi all', meta: { sender_instance: 'inst-A' } })
    expect(store.fetchSince('t1', 'alice', '', 'inst-A')).toHaveLength(0)
    expect(store.fetchSince('t1', 'bob', '', 'inst-B')).toHaveLength(1)
  })

  it('never returns a @mailbox: row from any of the three drain/poll methods (§8.2 owns those exclusively)', () => {
    const now = new Date().toISOString()
    db.prepare(`
      INSERT INTO message(id,v,team_id,from_handle,to_handle,kind,content,meta_json,sent_at)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run('msg_mb_x', 2, 't1', 'alice', '@mailbox:bob', 'chat', 'for bob', '{}', now)
    expect(store.fetchSince('t1', 'bob', '')).toHaveLength(0)
    expect(store.fetchPendingSince('t1', 'bob', '')).toHaveLength(0)
    expect(store.fetchInboxSince('t1', 'bob', '', 100)).toHaveLength(0)
  })

  it('returns nothing even when the caller passes a @mailbox:-prefixed to_handle literally (no caller should, but the predicate must not trust it)', () => {
    const now = new Date().toISOString()
    db.prepare(`
      INSERT INTO message(id,v,team_id,from_handle,to_handle,kind,content,meta_json,sent_at)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run('msg_mb_y', 2, 't1', 'alice', '@mailbox:bob', 'chat', 'for bob', '{}', now)
    expect(store.fetchSince('t1', '@mailbox:bob', '')).toHaveLength(0)
    expect(store.fetchPendingSince('t1', '@mailbox:bob', '')).toHaveLength(0)
    expect(store.fetchInboxSince('t1', '@mailbox:bob', '', 100)).toHaveLength(0)
  })
})
