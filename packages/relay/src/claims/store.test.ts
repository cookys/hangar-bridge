import { describe, it, expect, beforeEach } from 'vitest'
import { openDatabase, type Db } from '../db/db.ts'
import { ClaimStore } from './store.ts'

const T = 'hangar'

describe('ClaimStore', () => {
  let db: Db
  let clock: number
  const now = () => new Date(clock)
  let s: ClaimStore
  beforeEach(() => {
    db = openDatabase(':memory:')
    clock = Date.parse('2026-01-01T00:00:00Z')
    s = new ClaimStore(db, now)
  })

  it('acquires an unclaimed key', () => {
    const r = s.acquire(T, 'repo:x:file', 'alice', 'laptop', 60, 'editing')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.renewed).toBe(false)
      expect(r.claim.owner_handle).toBe('alice')
      expect(r.claim.note).toBe('editing')
      expect(r.claim.expires_at).toBe(new Date(clock + 60_000).toISOString())
    }
  })

  it('same owner renew extends expiry and preserves created_at', () => {
    const a = s.acquire(T, 'k', 'alice', 'laptop', 60, null)
    const created = a.ok ? a.claim.created_at : ''
    clock += 30_000
    const b = s.acquire(T, 'k', 'alice', 'desktop', 60, 'renewed')
    expect(b.ok).toBe(true)
    if (b.ok) {
      expect(b.renewed).toBe(true)
      expect(b.claim.created_at).toBe(created)               // preserved
      expect(b.claim.owner_label).toBe('desktop')            // updated
      expect(b.claim.expires_at).toBe(new Date(clock + 60_000).toISOString())
    }
  })

  it('conflicts when a different owner holds a live claim', () => {
    s.acquire(T, 'k', 'alice', 'laptop', 60, null)
    clock += 30_000
    const r = s.acquire(T, 'k', 'bob', 'laptop', 60, null)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.conflict.owner_handle).toBe('alice')
  })

  it('an expired claim is re-acquirable by anyone', () => {
    s.acquire(T, 'k', 'alice', 'laptop', 60, null)
    clock += 61_000 // past expiry
    const r = s.acquire(T, 'k', 'bob', 'laptop', 60, null)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.renewed).toBe(false)                          // fresh claim, not a renew
      expect(r.claim.owner_handle).toBe('bob')
    }
  })

  it('list returns only live claims, ordered by key', () => {
    s.acquire(T, 'b-key', 'alice', 'l', 60, null)
    s.acquire(T, 'a-key', 'alice', 'l', 60, null)
    s.acquire(T, 'gone', 'alice', 'l', 10, null)
    clock += 30_000 // 'gone' (ttl 10s) expired; the 60s ones still live
    const keys = s.list(T).map(c => c.claim_key)
    expect(keys).toEqual(['a-key', 'b-key'])
  })

  it('owner can release; released=true, then gone from list', () => {
    s.acquire(T, 'k', 'alice', 'l', 60, null)
    const r = s.release(T, 'k', 'alice')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.released).toBe(true)
    expect(s.list(T)).toEqual([])
  })

  it('release of an absent key is idempotent (released=false)', () => {
    const r = s.release(T, 'nope', 'alice')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.released).toBe(false)
  })

  it('non-owner cannot release a live claim (conflict)', () => {
    s.acquire(T, 'k', 'alice', 'l', 60, null)
    const r = s.release(T, 'k', 'bob')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.conflict.owner_handle).toBe('alice')
    expect(s.list(T).length).toBe(1) // still held
  })

  it('releasing an expired claim held by another handle succeeds (idempotent cleanup)', () => {
    s.acquire(T, 'k', 'alice', 'l', 10, null)
    clock += 61_000 // alice's claim expired
    const r = s.release(T, 'k', 'bob') // expired ⇒ not a live-owner conflict
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.released).toBe(true)
  })
})
