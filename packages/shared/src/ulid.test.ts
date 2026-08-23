import { describe, it, expect } from 'vitest'
import { newMessageId, isValidMessageId, compareMessageIds, newInstanceId, isValidInstanceId } from './ulid.ts'

describe('message id', () => {
  it('generates ids with msg_ prefix followed by a ULID', () => {
    const id = newMessageId()
    expect(id).toMatch(/^msg_[0-9A-HJKMNP-TV-Z]{26}$/)
  })
  it('generates strictly sortable ids when called sequentially', () => {
    const ids = Array.from({ length: 50 }, () => newMessageId())
    const sorted = [...ids].sort()
    expect(ids).toEqual(sorted)
  })
  it('validates well-formed ids', () => {
    expect(isValidMessageId(newMessageId())).toBe(true)
  })
  it('rejects malformed ids', () => {
    expect(isValidMessageId('not-a-msg-id')).toBe(false)
    expect(isValidMessageId('msg_')).toBe(false)
    expect(isValidMessageId('')).toBe(false)
  })
  it('compares ids by lexicographic order', () => {
    const a = newMessageId()
    const b = newMessageId()
    expect(compareMessageIds(a, b)).toBeLessThan(0)
    expect(compareMessageIds(b, a)).toBeGreaterThan(0)
    expect(compareMessageIds(a, a)).toBe(0)
  })
})

/**
 * P2 presence uniqueness: an instance id is a per-PROCESS ULID that
 * disambiguates two sessions sharing one token label. It is an observability
 * key only — never an addressing unit (plan §2.1).
 */
describe('instance id', () => {
  it('generates a bare ULID (no msg_ prefix — instances are not messages)', () => {
    const id = newInstanceId()
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(isValidMessageId(id)).toBe(false)
  })
  it('generates strictly sortable ids when called sequentially', () => {
    const ids = Array.from({ length: 50 }, () => newInstanceId())
    expect(ids).toEqual([...ids].sort())
    expect(new Set(ids).size).toBe(ids.length)
  })
  it('validates well-formed instance ids', () => {
    expect(isValidInstanceId(newInstanceId())).toBe(true)
  })
  it('rejects malformed instance ids', () => {
    expect(isValidInstanceId('')).toBe(false)
    expect(isValidInstanceId('not-a-ulid')).toBe(false)
    // must not accept a label-separator character — the relay composes
    // `${tokenLabel}#${instance}`, so a '#' in the instance would be ambiguous
    expect(isValidInstanceId('01ARZ3NDEKTSV4RRFFQ69G5F#V')).toBe(false)
    expect(isValidInstanceId(newInstanceId() + 'X')).toBe(false)
    expect(isValidInstanceId(newMessageId())).toBe(false)
  })
})
