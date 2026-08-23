import { describe, it, expect } from 'vitest'
import { newInstanceId } from '@hangar-bridge/shared'
import { effectiveLabel, parseInstanceHeader } from './label.ts'

/**
 * P2 §2.1 — ONE shared label resolver used by BOTH the presence route and the
 * SSE cleanup path. Two sessions sharing a token label previously wrote and
 * deleted the SAME presence row (registry.ts byLabel), so either one's
 * disconnect erased the survivor. Suffixing the per-process instance id makes
 * the row key unique per process.
 */
describe('effectiveLabel', () => {
  it('suffixes the instance id onto the token label', () => {
    const inst = newInstanceId()
    expect(effectiveLabel('laptop', inst)).toBe(`laptop#${inst}`)
  })

  it('falls back to the bare token label for a legacy client with no instance', () => {
    expect(effectiveLabel('laptop', undefined)).toBe('laptop')
    expect(effectiveLabel('laptop', null)).toBe('laptop')
    expect(effectiveLabel('laptop', '')).toBe('laptop')
  })

  it('is deterministic — presence write and SSE cleanup derive the same key', () => {
    const inst = newInstanceId()
    expect(effectiveLabel('laptop', inst)).toBe(effectiveLabel('laptop', inst))
  })

  it('keeps old and new clients from cross-deleting each other', () => {
    // registry.remove is an EXACT-match delete: a legacy client's key can never
    // equal an instance-bearing key, so neither can erase the other's row.
    const inst = newInstanceId()
    expect(effectiveLabel('laptop', inst)).not.toBe(effectiveLabel('laptop', undefined))
  })

  it('separates two instances sharing one token label', () => {
    const a = newInstanceId()
    const b = newInstanceId()
    expect(effectiveLabel('laptop', a)).not.toBe(effectiveLabel('laptop', b))
  })
})

describe('parseInstanceHeader', () => {
  it('accepts a well-formed instance id', () => {
    const inst = newInstanceId()
    expect(parseInstanceHeader(inst)).toEqual({ ok: true, instance: inst })
  })

  it('accepts an absent header as the legacy path', () => {
    expect(parseInstanceHeader(undefined)).toEqual({ ok: true, instance: undefined })
    expect(parseInstanceHeader('')).toEqual({ ok: true, instance: undefined })
  })

  it('rejects a malformed instance id rather than embedding it in a row key', () => {
    expect(parseInstanceHeader('../../etc')).toEqual({ ok: false })
    expect(parseInstanceHeader('has#separator')).toEqual({ ok: false })
    expect(parseInstanceHeader('x'.repeat(300))).toEqual({ ok: false })
  })
})
