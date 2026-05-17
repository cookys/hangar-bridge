import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import {
  EnvelopeSchema, OutboundMessageSchema,
  envelopeFromRow, envelopeToRow,
  type Envelope, type OutboundMessage
} from './envelope.ts'
import { PROTOCOL_VERSION, MAX_CONTENT_BYTES } from './constants.ts'

const validChatEnvelope = (): Envelope => ({
  id: 'msg_01HRK7Y0000000000000000000', v: PROTOCOL_VERSION,
  team: 'team_abc', from: 'alice', to: 'bob',
  in_reply_to: null, thread_root: null,
  kind: 'chat', content: 'hello',
  meta: { repo: 'claudes-talking' },
  sent_at: '2026-04-17T23:01:12.345Z', delivered_at: null
})

describe('EnvelopeSchema', () => {
  it('accepts a minimal valid chat envelope', () => {
    expect(EnvelopeSchema.parse(validChatEnvelope())).toBeDefined()
  })
  it('rejects wrong protocol version', () => {
    expect(() => EnvelopeSchema.parse({ ...validChatEnvelope(), v: 3 })).toThrow()
  })
  it('rejects content larger than MAX_CONTENT_BYTES', () => {
    const e = { ...validChatEnvelope(), content: 'a'.repeat(MAX_CONTENT_BYTES + 1) }
    expect(() => EnvelopeSchema.parse(e)).toThrow(/content/)
  })
  it('accepts content at exactly MAX_CONTENT_BYTES', () => {
    const e = { ...validChatEnvelope(), content: 'a'.repeat(MAX_CONTENT_BYTES) }
    expect(EnvelopeSchema.parse(e)).toBeDefined()
  })
  it('rejects meta keys with invalid characters', () => {
    const e = { ...validChatEnvelope(), meta: { 'bad-key': 'x' } }
    expect(() => EnvelopeSchema.parse(e)).toThrow()
  })
  it('accepts `to: "@team"` for broadcast', () => {
    expect(EnvelopeSchema.parse({ ...validChatEnvelope(), to: '@team' })).toBeDefined()
  })
  it('rejects unknown kind', () => {
    expect(() => EnvelopeSchema.parse({ ...validChatEnvelope(), kind: 'surprise' })).toThrow()
  })
  it('requires in_reply_to on permission_verdict kind', () => {
    const e = {
      ...validChatEnvelope(), kind: 'permission_verdict', in_reply_to: null,
      meta: { request_id: 'abcde', behavior: 'allow' }
    }
    expect(() => EnvelopeSchema.parse(e)).toThrow(/in_reply_to/)
  })
  it('accepts task_dispatch envelope', () => {
    const e = {
      ...validChatEnvelope(), kind: 'task_dispatch',
      content: 'run pytest on the e2e suite',
      meta: { correlation_id: 'corr_abc', task_kind: 'shell' }
    }
    expect(EnvelopeSchema.parse(e)).toBeDefined()
  })
  it('accepts task_result with in_reply_to', () => {
    const e = {
      ...validChatEnvelope(), kind: 'task_result',
      in_reply_to: 'msg_01HRK7Y0000000000000000001',
      content: 'exit 0; 47 passed',
      meta: { correlation_id: 'corr_abc' }
    }
    expect(EnvelopeSchema.parse(e)).toBeDefined()
  })
  it('rejects task_result without in_reply_to', () => {
    const e = {
      ...validChatEnvelope(), kind: 'task_result', in_reply_to: null,
      content: 'exit 0', meta: { correlation_id: 'corr_abc' }
    }
    expect(() => EnvelopeSchema.parse(e)).toThrow(/in_reply_to/)
  })
  it('silently strips unknown top-level fields (not strict)', () => {
    // EnvelopeSchema is NOT z.strict — relay tolerates extras for forward-compat.
    // (Layer 2 anti-spoof enforced via OutboundMessageSchema.strict, not here.)
    const e = { ...validChatEnvelope(), futureField: 'ignored' }
    const parsed = EnvelopeSchema.parse(e) as Record<string, unknown>
    expect(parsed.futureField).toBeUndefined()
  })
  it('roundtrips task_result envelope through JSON serialization', () => {
    const e = {
      ...validChatEnvelope(), kind: 'task_result' as const,
      in_reply_to: 'msg_01HRK7Y0000000000000000001' as const,
      content: 'exit 0', meta: { correlation_id: 'corr_xyz' }
    }
    const json = JSON.stringify(EnvelopeSchema.parse(e))
    const back = EnvelopeSchema.parse(JSON.parse(json))
    expect(back).toEqual(EnvelopeSchema.parse(e))
  })
})

describe('OutboundMessageSchema', () => {
  it('accepts a minimal outbound chat', () => {
    const m: OutboundMessage = { to: 'bob', kind: 'chat', content: 'hi' }
    expect(OutboundMessageSchema.parse(m)).toBeDefined()
  })
  it('rejects outbound with id (server assigns)', () => {
    expect(() => OutboundMessageSchema.parse({
      to: 'bob', kind: 'chat', content: 'hi', id: 'msg_x'
    })).toThrow()
  })
  it('rejects outbound with from (server assigns)', () => {
    expect(() => OutboundMessageSchema.parse({
      to: 'bob', kind: 'chat', content: 'hi', from: 'alice'
    })).toThrow()
  })
})

describe('row <-> envelope conversion', () => {
  it('round-trips a known envelope through the DB row shape', () => {
    const e = validChatEnvelope()
    expect(envelopeFromRow(envelopeToRow(e))).toEqual(e)
  })
  it('property: arbitrary valid envelopes round-trip cleanly', () => {
    const arb = fc.record({
      id: fc.constantFrom('msg_01HRK7Y0000000000000000000', 'msg_01HRK7Y0000000000000000001'),
      v: fc.constant(PROTOCOL_VERSION),
      team: fc.stringMatching(/^[a-zA-Z0-9_-]{1,32}$/),
      from: fc.constantFrom('alice', 'bob', 'charlie'),
      to: fc.constantFrom('alice', 'bob', '@team'),
      in_reply_to: fc.constant(null),
      thread_root: fc.constant(null),
      kind: fc.constantFrom('chat', 'presence_update', 'task_dispatch'),
      content: fc.string({ maxLength: 1024 }),
      meta: fc.dictionary(
        fc.stringMatching(/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/),
        fc.string({ maxLength: 256 }), { maxKeys: 8 }
      ),
      sent_at: fc.constant('2026-04-17T23:01:12.345Z'),
      delivered_at: fc.constant(null)
    })
    fc.assert(fc.property(arb, e => {
      expect(envelopeFromRow(envelopeToRow(e as Envelope))).toEqual(e)
    }), { numRuns: 200 })
  })
})
