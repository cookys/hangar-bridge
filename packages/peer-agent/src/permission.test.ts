import { describe, it, expect, beforeEach } from 'vitest'
import { PermissionTracker, PermissionOutboundTracker } from './permission.ts'

describe('PermissionTracker', () => {
  let t: PermissionTracker
  beforeEach(() => { t = new PermissionTracker({ ttlMs: 1000 }) })

  it('records an incoming request_id with the msg_id that carried it', () => {
    t.recordIncoming('abcde', 'msg_01HR0000000000000000000001')
    expect(t.msgIdFor('abcde')).toBe('msg_01HR0000000000000000000001')
  })

  it('drops entries after ttl', async () => {
    const t2 = new PermissionTracker({ ttlMs: 10 })
    t2.recordIncoming('abcde', 'msg_x')
    await new Promise(r => setTimeout(r, 30))
    expect(t2.msgIdFor('abcde')).toBeUndefined()
  })

  it('returns undefined for unknown request_id', () => {
    expect(t.msgIdFor('xxxxx')).toBeUndefined()
  })
})

describe('PermissionOutboundTracker (SEC-M1 responder authorization)', () => {
  let t: PermissionOutboundTracker
  beforeEach(() => { t = new PermissionOutboundTracker({ ttlMs: 1000 }) })

  it('authorizes only handles we relayed the request to', () => {
    t.recordRelay('abcde', ['alice'])
    expect(t.isAuthorizedResponder('abcde', 'alice')).toBe(true)
    expect(t.isAuthorizedResponder('abcde', 'bob')).toBe(false)
  })

  it('is fail-closed for a request_id we never relayed', () => {
    expect(t.isAuthorizedResponder('never1', 'alice')).toBe(false)
  })

  it('normalizes request_id case (phone autocorrect defense)', () => {
    t.recordRelay('ABCDE', ['alice'])
    expect(t.isAuthorizedResponder('abcde', 'alice')).toBe(true)
  })

  it('@team target authorizes any (roster-gated) responder', () => {
    t.recordRelay('abcde', ['@team'])
    expect(t.isAuthorizedResponder('abcde', 'carol')).toBe(true)
  })

  it('merges targets when the same request_id is relayed to more peers', () => {
    t.recordRelay('abcde', ['alice'])
    t.recordRelay('abcde', ['dave'])
    expect(t.isAuthorizedResponder('abcde', 'alice')).toBe(true)
    expect(t.isAuthorizedResponder('abcde', 'dave')).toBe(true)
  })

  it('drops authorization after ttl', async () => {
    const t2 = new PermissionOutboundTracker({ ttlMs: 10 })
    t2.recordRelay('abcde', ['alice'])
    expect(t2.isAuthorizedResponder('abcde', 'alice')).toBe(true)
    await new Promise(r => setTimeout(r, 30))
    expect(t2.isAuthorizedResponder('abcde', 'alice')).toBe(false)
  })
})
