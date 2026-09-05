import { describe, it, expect, beforeEach, vi } from 'vitest'
import { openDatabase, type Db } from './db/db.ts'
import { ReplyLimiter, REPLY_LIMITER_DEFAULTS } from './reply-limiter.ts'
import { purgeReplyState, startInactivitySweeper } from './purge.ts'

describe('ReplyLimiter (REPLY_ROUTING_SPEC.md §9)', () => {
  let db: Db
  let limiter: ReplyLimiter
  beforeEach(() => { db = openDatabase(':memory:'); limiter = new ReplyLimiter(db) })

  it('allows up to maxPerWindow acquisitions, then refuses the next with retry_after_s', () => {
    const now = 0
    for (let i = 0; i < 10; i++) {
      expect(limiter.tryAcquire('thread_a', 'alice', now)).toEqual({ ok: true })
    }
    const result = limiter.tryAcquire('thread_a', 'alice', now)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.retry_after_s).toBe(REPLY_LIMITER_DEFAULTS.windowMs / 1000)
    }
  })

  it('at the boundary (count=9), only one of two further acquisitions succeeds', () => {
    const now = 0
    for (let i = 0; i < 9; i++) {
      expect(limiter.tryAcquire('thread_b', 'alice', now)).toEqual({ ok: true })
    }
    const first = limiter.tryAcquire('thread_b', 'alice', now)
    const second = limiter.tryAcquire('thread_b', 'alice', now)
    expect(first).toEqual({ ok: true })
    expect(second.ok).toBe(false)
    const row = db.prepare(
      "SELECT count FROM reply_limiter WHERE thread_root='thread_b' AND handle='alice'"
    ).get() as { count: number }
    expect(row.count).toBe(10)
  })

  it('a new window resets the count', () => {
    const now = 0
    for (let i = 0; i < 10; i++) limiter.tryAcquire('thread_c', 'alice', now)
    expect(limiter.tryAcquire('thread_c', 'alice', now).ok).toBe(false)
    const nextWindow = REPLY_LIMITER_DEFAULTS.windowMs
    expect(limiter.tryAcquire('thread_c', 'alice', nextWindow)).toEqual({ ok: true })
  })

  it('is keyed per (thread_root, handle): a different handle has its own budget', () => {
    const now = 0
    for (let i = 0; i < 10; i++) limiter.tryAcquire('thread_d', 'alice', now)
    expect(limiter.tryAcquire('thread_d', 'alice', now).ok).toBe(false)
    expect(limiter.tryAcquire('thread_d', 'bob', now)).toEqual({ ok: true })
  })

  it('is keyed per thread_root too: a different thread has its own budget', () => {
    const now = 0
    for (let i = 0; i < 10; i++) limiter.tryAcquire('thread_e1', 'alice', now)
    expect(limiter.tryAcquire('thread_e1', 'alice', now).ok).toBe(false)
    expect(limiter.tryAcquire('thread_e2', 'alice', now)).toEqual({ ok: true })
  })

  it('honours custom maxPerWindow / windowMs overrides', () => {
    const now = 0
    for (let i = 0; i < 3; i++) {
      expect(limiter.tryAcquire('thread_f', 'alice', now, { maxPerWindow: 3, windowMs: 1000 })).toEqual({ ok: true })
    }
    const refused = limiter.tryAcquire('thread_f', 'alice', now, { maxPerWindow: 3, windowMs: 1000 })
    expect(refused).toEqual({ ok: false, retry_after_s: 1 })
  })

  it('is one statement: exactly one row exists per (thread_root, handle, window)', () => {
    const now = 0
    for (let i = 0; i < 5; i++) limiter.tryAcquire('thread_g', 'alice', now)
    const rows = db.prepare(
      'SELECT count FROM reply_limiter WHERE thread_root=? AND handle=?'
    ).all('thread_g', 'alice') as Array<{ count: number }>
    expect(rows).toHaveLength(1)
    expect(rows[0]!.count).toBe(5)
  })

  it('survives a relay restart because state is a row, not memory (re-instantiation keeps counting)', () => {
    const now = 0
    for (let i = 0; i < 7; i++) limiter.tryAcquire('thread_h', 'alice', now)
    const restarted = new ReplyLimiter(db)
    for (let i = 0; i < 3; i++) expect(restarted.tryAcquire('thread_h', 'alice', now)).toEqual({ ok: true })
    expect(restarted.tryAcquire('thread_h', 'alice', now).ok).toBe(false)
  })
})

describe('purgeReplyState (REPLY_ROUTING_SPEC.md §12)', () => {
  let db: Db
  beforeEach(() => { db = openDatabase(':memory:') })

  it('deletes reply_limiter rows older than two windows, keeps recent ones', () => {
    const windowMs = REPLY_LIMITER_DEFAULTS.windowMs
    const now = 10 * windowMs
    const stale = new Date(now - 3 * windowMs).toISOString()   // 3 windows back: stale
    const recent = new Date(now - windowMs).toISOString()      // 1 window back: kept
    db.prepare('INSERT INTO reply_limiter(thread_root,handle,window_start,count) VALUES (?,?,?,?)')
      .run('t_old', 'alice', stale, 5)
    db.prepare('INSERT INTO reply_limiter(thread_root,handle,window_start,count) VALUES (?,?,?,?)')
      .run('t_new', 'alice', recent, 5)

    const result = purgeReplyState(db, now)

    const remaining = db.prepare('SELECT thread_root FROM reply_limiter').all() as Array<{ thread_root: string }>
    expect(remaining.map(r => r.thread_root)).toEqual(['t_new'])
    expect(result.limiterRows).toBe(1)
  })

  it('deletes expired reply_route rows and cascades their grants, keeps durable/live ones', () => {
    db.prepare("INSERT INTO team(id,name,retention_days,created_at) VALUES ('t1','t1',7,'2026-01-01T00:00:00Z')").run()
    db.prepare(`
      INSERT INTO reply_route(msg_id,team_id,from_handle,to_handle,thread_root,created_at,expires_at)
      VALUES ('msg_expired','t1','alice','bob','msg_expired','2026-01-01T00:00:00Z','2026-01-02T00:00:00.000Z')
    `).run()
    db.prepare(`
      INSERT INTO reply_route(msg_id,team_id,from_handle,to_handle,thread_root,created_at,expires_at)
      VALUES ('msg_durable','t1','alice','bob','msg_durable','2026-01-01T00:00:00Z',NULL)
    `).run()
    db.prepare(`
      INSERT INTO reply_route(msg_id,team_id,from_handle,to_handle,thread_root,created_at,expires_at)
      VALUES ('msg_not_yet','t1','alice','bob','msg_not_yet','2026-01-01T00:00:00Z','2026-02-01T00:00:00.000Z')
    `).run()
    db.prepare("INSERT INTO reply_grant(msg_id,handle,instance,selector) VALUES ('msg_expired','bob','inst-1','')").run()
    db.prepare("INSERT INTO reply_grant(msg_id,handle,instance,selector) VALUES ('msg_durable','bob','inst-1','')").run()
    db.prepare("INSERT INTO reply_grant(msg_id,handle,instance,selector) VALUES ('msg_not_yet','bob','inst-1','')").run()

    const result = purgeReplyState(db, new Date('2026-01-03T00:00:00.000Z').getTime())

    expect(db.prepare("SELECT 1 FROM reply_route WHERE msg_id='msg_expired'").get()).toBeUndefined()
    expect(db.prepare("SELECT 1 FROM reply_route WHERE msg_id='msg_durable'").get()).toBeTruthy()
    expect(db.prepare("SELECT 1 FROM reply_route WHERE msg_id='msg_not_yet'").get()).toBeTruthy()
    expect(db.prepare("SELECT COUNT(*) AS n FROM reply_grant WHERE msg_id='msg_expired'").get()).toEqual({ n: 0 })
    expect(db.prepare("SELECT COUNT(*) AS n FROM reply_grant WHERE msg_id='msg_durable'").get()).toEqual({ n: 1 })
    expect(db.prepare("SELECT COUNT(*) AS n FROM reply_grant WHERE msg_id='msg_not_yet'").get()).toEqual({ n: 1 })
    expect(result.routes).toBe(1)
  })
})

describe('startInactivitySweeper — purgeReplyState runs once per tick, not once per team', () => {
  // purgeReplyState (§9/§12) has no team_id filter — it sweeps reply_limiter
  // and reply_route relay-wide by window_start/expires_at alone — so calling
  // it inside the per-team purgeInactive loop would be pure wasted work on
  // every team beyond the first (each subsequent DELETE matches nothing,
  // since the first already removed everything stale). Pin the call count
  // directly: same-module function calls aren't interceptable with
  // vi.spyOn under this Vitest/Vite transform (verified), so intercept at
  // db.prepare() instead and count how many times the DELETE statement text
  // is actually prepared.
  it('prepares the reply_limiter DELETE exactly once per tick regardless of team count', () => {
    vi.useFakeTimers()
    try {
      const db = openDatabase(':memory:')
      db.prepare("INSERT INTO team(id,name,retention_days,created_at) VALUES ('t2','t2',7,'2026-01-01T00:00:00Z')").run()
      db.prepare("INSERT INTO team(id,name,retention_days,created_at) VALUES ('t3','t3',7,'2026-01-01T00:00:00Z')").run()

      const originalPrepare = db.prepare.bind(db)
      const preparedSql: string[] = []
      db.prepare = ((sql: string) => {
        preparedSql.push(sql)
        return originalPrepare(sql)
      }) as typeof db.prepare

      const handle = startInactivitySweeper(db, {
        intervalMs: 1000, days: 9999, now: () => new Date('2026-06-01T00:00:00.000Z'),
      })
      vi.advanceTimersByTime(1000)
      clearInterval(handle)

      const limiterDeleteCalls = preparedSql.filter(sql => sql.includes('DELETE FROM reply_limiter'))
      const routeDeleteCalls = preparedSql.filter(sql => sql.includes('DELETE FROM reply_route'))
      expect(limiterDeleteCalls).toHaveLength(1)
      expect(routeDeleteCalls).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
