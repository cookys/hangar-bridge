import { describe, it, expect } from 'vitest'
import { parseReturnSelectorHeader } from './messages.ts'

/**
 * REPLY_ROUTING_SPEC.md §8.1 return-selector grammar, parsed at the
 * `/v1/messages` chokepoint: `<name>@<ULID>` (a courier's pasted-into pane)
 * or the literal `~none`; absent -> null; anything else is malformed.
 */
describe('parseReturnSelectorHeader (§8.1 grammar)', () => {
  it('absent header -> ok, null', () => {
    expect(parseReturnSelectorHeader(undefined)).toEqual({ ok: true, value: null })
    expect(parseReturnSelectorHeader(null)).toEqual({ ok: true, value: null })
    expect(parseReturnSelectorHeader('')).toEqual({ ok: true, value: null })
  })

  it("literal '~none' -> ok, '~none'", () => {
    expect(parseReturnSelectorHeader('~none')).toEqual({ ok: true, value: '~none' })
  })

  it('well-formed <name>@<ULID> -> ok, verbatim', () => {
    const raw = 'revival.3d--agy@01HRK7Y0000000000000000000'
    expect(parseReturnSelectorHeader(raw)).toEqual({ ok: true, value: raw })
  })

  it('name at the boundary lengths (1 char, 64 chars) is accepted', () => {
    const ulid = '01HRK7Y0000000000000000000'
    expect(parseReturnSelectorHeader(`a@${ulid}`)).toEqual({ ok: true, value: `a@${ulid}` })
    const name64 = 'a'.repeat(64)
    expect(parseReturnSelectorHeader(`${name64}@${ulid}`)).toEqual({ ok: true, value: `${name64}@${ulid}` })
  })

  it('rejects a name over 64 chars', () => {
    const ulid = '01HRK7Y0000000000000000000'
    expect(parseReturnSelectorHeader(`${'a'.repeat(65)}@${ulid}`)).toEqual({ ok: false })
  })

  it('rejects a name starting with a disallowed character', () => {
    expect(parseReturnSelectorHeader('-leading@01HRK7Y0000000000000000000')).toEqual({ ok: false })
  })

  it('rejects a malformed ULID half', () => {
    expect(parseReturnSelectorHeader('agy@not-a-ulid')).toEqual({ ok: false })
  })

  it('rejects no @ at all', () => {
    expect(parseReturnSelectorHeader('agy')).toEqual({ ok: false })
  })

  it('rejects an empty name before @', () => {
    expect(parseReturnSelectorHeader('@01HRK7Y0000000000000000000')).toEqual({ ok: false })
  })
})
