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
  subject: null,
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
  it('round-trips a subjected direct envelope (subject preserved)', () => {
    const e: Envelope = { ...validChatEnvelope(), to: 'bob', subject: 'mple2.command.assign' }
    const back = envelopeFromRow(envelopeToRow(e))
    expect(back.subject).toBe('mple2.command.assign')
    expect(back).toEqual(e)
  })
  it('property: arbitrary valid envelopes round-trip cleanly', () => {
    const arb = fc.record({
      id: fc.constantFrom('msg_01HRK7Y0000000000000000000', 'msg_01HRK7Y0000000000000000001'),
      v: fc.constant(PROTOCOL_VERSION),
      team: fc.stringMatching(/^[a-zA-Z0-9_-]{1,32}$/),
      from: fc.constantFrom('alice', 'bob', 'charlie'),
      to: fc.constantFrom('alice', 'bob', '@team'),
      subject: fc.constant(null),
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

describe('subject field (routing + ACL)', () => {
  it('omitted subject defaults to null (back-compat)', () => {
    const e = validChatEnvelope() as Record<string, unknown>
    delete e.subject
    expect(EnvelopeSchema.parse(e).subject).toBe(null)
  })
  it('accepts a valid dotted lowercase subject on a direct message', () => {
    const e = { ...validChatEnvelope(), to: 'bob', subject: 'mple2.command.assign' }
    expect(EnvelopeSchema.parse(e).subject).toBe('mple2.command.assign')
  })
  it('rejects uppercase / hyphen / leading-dot subjects', () => {
    for (const s of ['Mple2', 'mple2-x', '.mple2', 'mple2.', 'mple2..x']) {
      expect(() => EnvelopeSchema.parse({ ...validChatEnvelope(), to: 'bob', subject: s })).toThrow()
    }
  })
  it('rejects a subject longer than 128 chars', () => {
    const s = 'a' + '.b'.repeat(80) // > 128
    expect(() => EnvelopeSchema.parse({ ...validChatEnvelope(), to: 'bob', subject: s })).toThrow()
  })
  it('#3: subjected @team CHAT is accepted (subject-scoped broadcast)', () => {
    const e = EnvelopeSchema.parse({ ...validChatEnvelope(), to: '@team', kind: 'chat', subject: 'mple2.x' })
    expect(e.subject).toBe('mple2.x')
    expect(e.to).toBe('@team')
  })
  it('#3: subjected @team of a non-chat kind (task_dispatch) is rejected (R1)', () => {
    expect(() => EnvelopeSchema.parse({ ...validChatEnvelope(), to: '@team', kind: 'task_dispatch', subject: 'mple2.x' }))
      .toThrow(/only for chat/)
  })
  it('#3: a subjected @team chat still cannot be a reply (M4 ack channel preserved)', () => {
    expect(() => EnvelopeSchema.parse({
      ...validChatEnvelope(), to: '@team', kind: 'chat', subject: 'mple2.x',
      in_reply_to: 'msg_01HRK7Y0000000000000000001',
    })).toThrow(/subject=null/)
  })
  it('ACK CHANNEL: subject + in_reply_to is rejected', () => {
    const e = { ...validChatEnvelope(), to: 'bob', subject: 'mple2.x', in_reply_to: 'msg_01HRK7Y0000000000000000001' }
    expect(() => EnvelopeSchema.parse(e)).toThrow(/subject=null/)
  })
  it('null-subject @team stays valid (legacy broadcast)', () => {
    expect(EnvelopeSchema.parse({ ...validChatEnvelope(), to: '@team', subject: null })).toBeDefined()
  })
})

describe('OutboundMessageSchema subject', () => {
  it('omitted subject normalizes to null (default)', () => {
    expect(OutboundMessageSchema.parse({ to: 'bob', kind: 'chat', content: 'hi' }).subject).toBe(null)
  })
  it('accepts a subjected direct outbound', () => {
    const m = OutboundMessageSchema.parse({ to: 'bob', kind: 'task_dispatch', content: 'x', subject: 'mple2.assign' })
    expect(m.subject).toBe('mple2.assign')
  })
  it('ack (in_reply_to, no subject) is accepted — not spuriously 400d (B2)', () => {
    expect(OutboundMessageSchema.parse({
      to: 'bob', kind: 'chat', content: 'ack', in_reply_to: 'msg_01HRK7Y0000000000000000001'
    })).toBeDefined()
  })
  it('null-subject @team broadcast is accepted (B2)', () => {
    expect(OutboundMessageSchema.parse({ to: '@team', kind: 'task_dispatch', content: 'x' })).toBeDefined()
  })
  it('#3: subjected @team task_dispatch is rejected (commands stay direct, R1)', () => {
    expect(() => OutboundMessageSchema.parse({ to: '@team', kind: 'task_dispatch', content: 'x', subject: 'mple2.x' }))
      .toThrow(/only for chat/)
  })
  it('#3: subjected @team chat is accepted (subject-scoped broadcast)', () => {
    const m = OutboundMessageSchema.parse({ to: '@team', kind: 'chat', content: 'x', subject: 'mple2.x' })
    expect(m.subject).toBe('mple2.x')
  })
  it('subject + in_reply_to is rejected', () => {
    expect(() => OutboundMessageSchema.parse({
      to: 'bob', kind: 'chat', content: 'x', subject: 'mple2.x', in_reply_to: 'msg_01HRK7Y0000000000000000001'
    })).toThrow(/subject=null/)
  })
})
