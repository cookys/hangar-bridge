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
    const marker = new TextEncoder().encode('legacy-seen')
    const kv: KvLike = {
      create: vi.fn(async () => {
        calls += 1
        if (calls === 1) return 1
        throw { code: 10071, message: 'wrong last sequence: 1' }
      }),
      get: vi.fn(async () => ({ value: marker })),
    }
    const dedup = await openTaskDedup({} as never, 'beta', { kvm: fakeKvm(kv) })
    expect(await dedup.seen('corr-1')).toBe(false) // new
    expect(await dedup.seen('corr-1')).toBe(true)  // duplicate
    expect(kv.create).toHaveBeenNthCalledWith(1, 'beta.corr-1', marker)
  })

  it('binds to the provisioned bucket with direct reads and no create authority', async () => {
    const kv: KvLike = {
      create: vi.fn(async () => 1),
      get: vi.fn(async () => null),
    }
    const kvm = fakeKvm(kv)
    await openTaskDedup({} as never, 'beta', { kvm })
    expect(kvm.open).toHaveBeenCalledWith('HANGAR_DEDUP', {
      allow_direct: true,
      bindOnly: true,
    })
  })

  it('PROPAGATES a non-already-exists infra error (never swallowed as dup/new)', async () => {
    const kv: KvLike = {
      create: vi.fn(async () => { throw new Error('connection refused') }),
      get: vi.fn(),
    }
    const dedup = await openTaskDedup({} as never, 'beta', { kvm: fakeKvm(kv) })
    await expect(dedup.seen('corr-9')).rejects.toThrow('connection refused')
  })

  it('uses create (existence) only — no watch/TTL drives correctness (AC9)', async () => {
    const kv = {
      create: vi.fn(async () => 1),
      get: vi.fn(),
    } as KvLike & { watch?: unknown; put?: unknown }
    const dedup = await openTaskDedup({} as never, 'beta', { kvm: fakeKvm(kv) })
    await dedup.seen('corr-1')
    expect(kv.create).toHaveBeenCalledOnce()
    expect((kv as Record<string, unknown>).watch).toBeUndefined() // no watcher path used
  })

  it('classifies same-envelope redelivery as retry and a different envelope as duplicate', async () => {
    let stored: Uint8Array | null = null
    const kv: KvLike = {
      create: vi.fn(async (_key, value) => {
        if (stored) throw { code: 10071, message: 'wrong last sequence: 1' }
        stored = value
        return 1
      }),
      get: vi.fn(async () => stored ? { value: stored } : null),
    }
    const dedup = await openTaskDedup({} as never, 'beta', { kvm: fakeKvm(kv) })
    expect(await dedup.classify('corr-1', 'msg_A')).toBe('new')
    expect(await dedup.classify('corr-1', 'msg_A')).toBe('retry')
    expect(await dedup.classify('corr-1', 'msg_B')).toBe('duplicate')
  })

  it('fails retryably when a conflicting marker cannot be re-read', async () => {
    const kv: KvLike = {
      create: vi.fn(async () => { throw { code: 10071 } }),
      get: vi.fn(async () => null),
    }
    const dedup = await openTaskDedup({} as never, 'beta', { kvm: fakeKvm(kv) })
    await expect(dedup.classify('corr-1', 'msg_A')).rejects.toThrow(/disappeared/)
  })

  it('does not record completion until markCompleted is called', async () => {
    let stored: Uint8Array | null = null
    const kv: KvLike = {
      create: vi.fn(async (_key, value) => { stored = value; return 1 }),
      get: vi.fn(async () => stored ? { value: stored } : null),
    }
    const dedup = await openTaskDedup({} as never, 'beta', { kvm: fakeKvm(kv) })
    expect(await dedup.isCompleted('corr-1')).toBe(false)
    await dedup.markCompleted('corr-1', 'msg_A')
    expect(await dedup.isCompleted('corr-1')).toBe(true)
  })
})
