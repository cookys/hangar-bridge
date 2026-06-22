import { describe, it, expect } from 'vitest'
import { namespaceOf, ownsNamespace, matchesInterest } from './subject.ts'

describe('namespaceOf', () => {
  it('returns the first dot-token', () => {
    expect(namespaceOf('mple2.command.assign')).toBe('mple2')
    expect(namespaceOf('mple2.status')).toBe('mple2')
  })
  it('returns the whole string when there is no dot', () => {
    expect(namespaceOf('mple2')).toBe('mple2')
  })
})

describe('ownsNamespace (fail-closed, exact first-token)', () => {
  const owned = new Set(['mple2', 'infra'])
  it('grants the whole namespace subtree to an owner', () => {
    expect(ownsNamespace('mple2', owned)).toBe(true)
    expect(ownsNamespace('mple2.command.assign', owned)).toBe(true)
    expect(ownsNamespace('infra.deploy', owned)).toBe(true)
  })
  it('denies a non-owned namespace', () => {
    expect(ownsNamespace('other.thing', owned)).toBe(false)
  })
  it('matches on EXACT first token, never string-prefix (no mple2evil bypass)', () => {
    expect(ownsNamespace('mple2evil.x', owned)).toBe(false)
    expect(ownsNamespace('mple2evil', owned)).toBe(false)
  })
  it('fail-closed: an empty owned set grants nothing', () => {
    expect(ownsNamespace('mple2.command', new Set())).toBe(false)
  })
})

describe('matchesInterest (exact OR trailing ">")', () => {
  it('matches exact subjects', () => {
    expect(matchesInterest('mple2.command', ['mple2.command'])).toBe(true)
    expect(matchesInterest('mple2.command', ['mple2.status'])).toBe(false)
  })
  it('trailing ">" matches the base and its subtree', () => {
    expect(matchesInterest('mple2.status', ['mple2.status>'])).toBe(true)
    expect(matchesInterest('mple2.status.heartbeat', ['mple2.status>'])).toBe(true)
    expect(matchesInterest('mple2.command', ['mple2.status>'])).toBe(false)
  })
  it('"mple2>" and "mple2.>" both match the whole namespace', () => {
    for (const pat of ['mple2>', 'mple2.>']) {
      expect(matchesInterest('mple2', [pat])).toBe(true)
      expect(matchesInterest('mple2.command.assign', [pat])).toBe(true)
      expect(matchesInterest('other.x', [pat])).toBe(false)
    }
  })
  it('does NOT treat "_" or other chars as wildcards (only trailing ">")', () => {
    expect(matchesInterest('mple2_command', ['mple2_command'])).toBe(true)
    expect(matchesInterest('mple2xcommand', ['mple2_command'])).toBe(false)
  })
  it('empty interest list matches nothing', () => {
    expect(matchesInterest('mple2.command', [])).toBe(false)
  })
})
