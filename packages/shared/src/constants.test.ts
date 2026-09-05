import { describe, it, expect } from 'vitest'
import { MAILBOX_PREFIX, isMailboxHandle } from './constants.ts'

describe('isMailboxHandle (§6.5)', () => {
  it('is true for a mailbox-prefixed handle with a name after the prefix', () => {
    expect(isMailboxHandle('@mailbox:cuda')).toBe(true)
  })
  it(`MAILBOX_PREFIX is '@mailbox:'`, () => {
    expect(MAILBOX_PREFIX).toBe('@mailbox:')
  })
  it('is false for the bare prefix with nothing after it', () => {
    expect(isMailboxHandle('@mailbox:')).toBe(false)
  })
  it('is false for a plain handle', () => {
    expect(isMailboxHandle('cuda')).toBe(false)
  })
  it('is false for @team', () => {
    expect(isMailboxHandle('@team')).toBe(false)
  })
})
