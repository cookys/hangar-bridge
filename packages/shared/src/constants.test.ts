import { describe, it, expect } from 'vitest'
import {
  MAILBOX_PREFIX, isMailboxHandle, RESERVED_CLI_INSTANCE,
  REPLY_ERROR_CODES, REPLY_ERROR_HTTP_STATUS, REPLY_ERROR_RETRYABLE,
  REPLY_LIMITER_DEFAULTS, EPHEMERAL_ROUTE_TTL_MS, LEGACY_ROUTE_TTL_MS
} from './constants.ts'

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
  // The suffix after MAILBOX_PREFIX must itself satisfy HANDLE_REGEX — a
  // mailbox address is not "any non-empty string after the prefix".
  it('is false when the suffix is @team (not a valid handle)', () => {
    expect(isMailboxHandle('@mailbox:@team')).toBe(false)
  })
  it('is false when the suffix contains a space', () => {
    expect(isMailboxHandle('@mailbox:has space')).toBe(false)
  })
  it('is false when the suffix is itself a mailbox address', () => {
    expect(isMailboxHandle('@mailbox:@mailbox:x')).toBe(false)
  })
})

describe('RESERVED_CLI_INSTANCE (§6.5)', () => {
  it(`is '~cli'`, () => {
    expect(RESERVED_CLI_INSTANCE).toBe('~cli')
  })
})

const REPLY_ERROR_CODE_LIST = [
  'use_reply_verb', 'unknown_parent', 'not_a_recipient', 'legacy_unreplyable',
  'parent_unaddressable', 'reply_storm', 'sender_instance_required',
  'handle_needs_all_sessions', 'dispatch_needs_instance', 'not_in_thread',
  'reserved_address', 'reserved_instance', 'use_relay_lane', 'return_target_gone',
  'reply_in_progress', 'idempotency_key_required', 'idempotency_mismatch',
  'grant_not_found', 'idempotency_key_invalid', 'instance_required'
] as const

describe('REPLY_ERROR_CODES / REPLY_ERROR_HTTP_STATUS / REPLY_ERROR_RETRYABLE (§13)', () => {
  it('REPLY_ERROR_CODES is exhaustive against the literal §13 code list, each mapped to itself', () => {
    expect(Object.keys(REPLY_ERROR_CODES).sort()).toEqual([...REPLY_ERROR_CODE_LIST].sort())
    for (const code of REPLY_ERROR_CODE_LIST) {
      expect(REPLY_ERROR_CODES[code]).toBe(code)
    }
  })

  it('REPLY_ERROR_HTTP_STATUS has exactly the same keys as REPLY_ERROR_CODES', () => {
    expect(Object.keys(REPLY_ERROR_HTTP_STATUS).sort()).toEqual(Object.keys(REPLY_ERROR_CODES).sort())
  })

  it('REPLY_ERROR_RETRYABLE has exactly the same keys as REPLY_ERROR_CODES', () => {
    expect(Object.keys(REPLY_ERROR_RETRYABLE).sort()).toEqual(Object.keys(REPLY_ERROR_CODES).sort())
  })

  it('use_relay_lane and return_target_gone are the only non-HTTP (null status) codes', () => {
    const nullStatusCodes = REPLY_ERROR_CODE_LIST.filter(c => REPLY_ERROR_HTTP_STATUS[c] === null)
    expect(nullStatusCodes.sort()).toEqual(['return_target_gone', 'use_relay_lane'].sort())
  })

  it('spot-checks a handful of §13 HTTP statuses', () => {
    expect(REPLY_ERROR_HTTP_STATUS.use_reply_verb).toBe(400)
    expect(REPLY_ERROR_HTTP_STATUS.unknown_parent).toBe(404)
    expect(REPLY_ERROR_HTTP_STATUS.not_a_recipient).toBe(403)
    expect(REPLY_ERROR_HTTP_STATUS.legacy_unreplyable).toBe(403)
    expect(REPLY_ERROR_HTTP_STATUS.parent_unaddressable).toBe(410)
    expect(REPLY_ERROR_HTTP_STATUS.reply_storm).toBe(429)
    expect(REPLY_ERROR_HTTP_STATUS.reply_in_progress).toBe(409)
    expect(REPLY_ERROR_HTTP_STATUS.idempotency_mismatch).toBe(422)
    expect(REPLY_ERROR_HTTP_STATUS.grant_not_found).toBe(404)
  })

  it('reply_storm and reply_in_progress are the only retryable codes', () => {
    const retryableCodes = REPLY_ERROR_CODE_LIST.filter(c => REPLY_ERROR_RETRYABLE[c])
    expect(retryableCodes.sort()).toEqual(['reply_in_progress', 'reply_storm'].sort())
  })
})

describe('reply-routing tunables (§12)', () => {
  it('REPLY_LIMITER_DEFAULTS is 10 per 10 minutes', () => {
    expect(REPLY_LIMITER_DEFAULTS).toEqual({ maxPerWindow: 10, windowMs: 10 * 60_000 })
  })
  it('EPHEMERAL_ROUTE_TTL_MS is 7 days', () => {
    expect(EPHEMERAL_ROUTE_TTL_MS).toBe(7 * 24 * 60 * 60_000)
  })
  it('LEGACY_ROUTE_TTL_MS is 7 days', () => {
    expect(LEGACY_ROUTE_TTL_MS).toBe(7 * 24 * 60 * 60_000)
  })
})
