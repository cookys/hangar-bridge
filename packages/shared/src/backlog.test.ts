import { describe, it, expect } from 'vitest'
import {
  BacklogEventSchema, BacklogEndEventSchema, SSE_EVENT_BACKLOG, SSE_EVENT_BACKLOG_END,
  REPLAY_MAX_MIN, REPLAY_MAX_MAX, BACKLOG_SCAN_CAP, BACKLOG_BY_SENDER_CAP,
} from './backlog.ts'

const ID = 'msg_01ARZ3NDEKTSV4RRFFQ69G5FAV'

describe('backlog event schemas (replay butler)', () => {
  it('names the two SSE events and the bounds the relay enforces', () => {
    expect(SSE_EVENT_BACKLOG).toBe('backlog')
    expect(SSE_EVENT_BACKLOG_END).toBe('backlog_end')
    expect(REPLAY_MAX_MIN).toBe(1)
    expect(REPLAY_MAX_MAX).toBe(1000)
    expect(BACKLOG_SCAN_CAP).toBe(10_000)
    expect(BACKLOG_BY_SENDER_CAP).toBe(20)
  })

  it('accepts a well-formed backlog event', () => {
    const e = BacklogEventSchema.parse({
      pending: 137, pending_capped: false, oldest: ID, newest: ID, resume_since: '',
      by_sender: { alice: 130, '@team': 7 }, replayed_exempt: 2,
    })
    expect(e.pending).toBe(137)
  })

  it('rejects a negative pending, a bad id, or a non-integer count', () => {
    expect(() => BacklogEventSchema.parse({
      pending: -1, pending_capped: false, oldest: ID, newest: ID, resume_since: '', by_sender: {}, replayed_exempt: 0,
    })).toThrow()
    expect(() => BacklogEventSchema.parse({
      pending: 1, pending_capped: false, oldest: 'nope', newest: ID, resume_since: '', by_sender: {}, replayed_exempt: 0,
    })).toThrow()
    expect(() => BacklogEventSchema.parse({
      pending: 1, pending_capped: false, oldest: ID, newest: ID, resume_since: '', by_sender: { a: 1.5 }, replayed_exempt: 0,
    })).toThrow()
  })

  it('backlog_end carries only newest', () => {
    expect(BacklogEndEventSchema.parse({ newest: ID })).toEqual({ newest: ID })
    expect(() => BacklogEndEventSchema.parse({ newest: 'x' })).toThrow()
  })
})
