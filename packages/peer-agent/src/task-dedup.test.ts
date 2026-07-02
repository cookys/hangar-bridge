import { describe, it, expect, vi } from 'vitest'
import { openTaskDedup, dedupKey, isAlreadyExists, correlationIdOf, type KvLike, type KvmLike } from './task-dedup.ts'

function fakeKvm(kv: KvLike): KvmLike {
  return { open: vi.fn(async () => kv) }
}

describe('dedupKey', () => {
  it('prefixes the writer handle (own-prefix scope, §2.6/AC9)', () => {
    expect(dedupKey('beta', '01ARZ3ND')).toBe('beta.01ARZ3ND')
  })
  it('sanitises characters outside the KV key charset', () => {
    expect(dedupKey('beta', 'a b/c#d')).toBe('beta.a_b/c_d')
  })
})

describe('isAlreadyExists', () => {
  it('matches the live JetStream duplicate signature (code 10071 / wrong last sequence)', () => {
    expect(isAlreadyExists({ code: 10071, message: 'wrong last sequence: 1' })).toBe(true)
    expect(isAlreadyExists(new Error('wrong last sequence: 3'))).toBe(true)
  })
  it('does NOT match an unrelated infra error', () => {
    expect(isAlreadyExists(new Error('connection refused'))).toBe(false)
    expect(isAlreadyExists({ code: 503 })).toBe(false)
  })
})

describe('correlationIdOf', () => {
  it('prefers meta.correlation_id, falls back to the envelope id', () => {
    expect(correlationIdOf({ correlation_id: 'c1' }, 'msg_x')).toBe('c1')
    expect(correlationIdOf(undefined, 'msg_x')).toBe('msg_x')
    expect(correlationIdOf({}, 'msg_x')).toBe('msg_x')
  })
})

describe('openTaskDedup.seen', () => {
  it('returns false on first sighting, true on a repeat (create rejects duplicate)', async () => {
    let calls = 0
    const kv: KvLike = {
      create: vi.fn(async () => {
        calls += 1
        if (calls === 1) return 1
        throw { code: 10071, message: 'wrong last sequence: 1' }
      }),
    }
    const dedup = await openTaskDedup({} as never, 'beta', { kvm: fakeKvm(kv) })
    expect(await dedup.seen('corr-1')).toBe(false) // new
    expect(await dedup.seen('corr-1')).toBe(true)  // duplicate
    expect(kv.create).toHaveBeenNthCalledWith(1, 'beta.corr-1', new Uint8Array())
  })

  it('PROPAGATES a non-already-exists infra error (never swallowed as dup/new)', async () => {
    const kv: KvLike = { create: vi.fn(async () => { throw new Error('connection refused') }) }
    const dedup = await openTaskDedup({} as never, 'beta', { kvm: fakeKvm(kv) })
    await expect(dedup.seen('corr-9')).rejects.toThrow('connection refused')
  })

  it('uses create (existence) only — no watch/TTL drives correctness (AC9)', async () => {
    const kv = { create: vi.fn(async () => 1) } as KvLike & { watch?: unknown; put?: unknown }
    const dedup = await openTaskDedup({} as never, 'beta', { kvm: fakeKvm(kv) })
    await dedup.seen('corr-1')
    expect(kv.create).toHaveBeenCalledOnce()
    expect((kv as Record<string, unknown>).watch).toBeUndefined() // no watcher path used
  })
})
