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
  const requestMsg = 'msg_01HR0000000000000000000001'
  beforeEach(() => { t = new PermissionOutboundTracker({ ttlMs: 1000 }) })

  it('authorizes only handles we relayed the request to', () => {
    t.recordRelay('abcde', ['alice'])
    t.confirm('abcde', 'alice', requestMsg)
    expect(t.isAuthorizedResponder('abcde', 'alice', requestMsg)).toBe(true)
    expect(t.isAuthorizedResponder('abcde', 'bob', requestMsg)).toBe(false)
  })

  it('is fail-closed for a request_id we never relayed', () => {
    expect(t.isAuthorizedResponder('never1', 'alice', requestMsg)).toBe(false)
  })

  it('normalizes request_id case (phone autocorrect defense)', () => {
    t.recordRelay('ABCDE', ['alice'])
    t.confirm('abcde', 'alice', requestMsg)
    expect(t.isAuthorizedResponder('abcde', 'alice', requestMsg)).toBe(true)
  })

  it('@team target authorizes any (roster-gated) responder', () => {
    t.recordRelay('abcde', ['@team'])
    t.confirm('abcde', '@team', requestMsg)
    expect(t.isAuthorizedResponder('abcde', 'carol', requestMsg)).toBe(true)
  })

  it('replaces authority when a short request_id is reused', () => {
    t.recordRelay('abcde', ['alice'])
    t.confirm('abcde', 'alice', requestMsg)
    t.recordRelay('abcde', ['dave'])
    t.confirm('abcde', 'dave', 'msg_01HR0000000000000000000002')
    expect(t.isAuthorizedResponder('abcde', 'alice', requestMsg)).toBe(false)
    expect(t.isAuthorizedResponder('abcde', 'dave', 'msg_01HR0000000000000000000002')).toBe(true)
  })

  it('revoke removes one target but keeps the others (partial send failure)', () => {
    t.recordRelay('abcde', ['alice', 'bob'])
    t.confirm('abcde', 'alice', requestMsg)
    t.confirm('abcde', 'bob', requestMsg)
    t.revoke('abcde', 'bob') // send to bob failed
    expect(t.isAuthorizedResponder('abcde', 'alice', requestMsg)).toBe(true)
    expect(t.isAuthorizedResponder('abcde', 'bob', requestMsg)).toBe(false)
  })

  it('revoking the last target empties the set → fail-closed for that request_id', () => {
    t.recordRelay('abcde', ['alice'])
    t.revoke('abcde', 'alice') // the only send failed
    expect(t.isAuthorizedResponder('abcde', 'alice', requestMsg)).toBe(false)
    expect(t.isAuthorizedResponder('abcde', 'anyone', requestMsg)).toBe(false)
  })

  it('revoke on an unknown request_id is a no-op', () => {
    expect(() => t.revoke('never1', 'alice')).not.toThrow()
  })

  it('drops authorization after ttl', async () => {
    const t2 = new PermissionOutboundTracker({ ttlMs: 10 })
    t2.recordRelay('abcde', ['alice'])
    t2.confirm('abcde', 'alice', requestMsg)
    expect(t2.isAuthorizedResponder('abcde', 'alice', requestMsg)).toBe(true)
    await new Promise(r => setTimeout(r, 30))
    expect(t2.isAuthorizedResponder('abcde', 'alice', requestMsg)).toBe(false)
  })

  it('binds the verdict to in_reply_to and consumes authority after terminal delivery', () => {
    t.recordRelay('abcde', ['alice'])
    t.confirm('abcde', 'alice', requestMsg)
    expect(t.isAuthorizedResponder('abcde', 'alice', 'msg_01HR0000000000000000000099')).toBe(false)
    expect(t.isAuthorizedResponder('abcde', 'alice', requestMsg)).toBe(true)
    t.consume('abcde')
    expect(t.isAuthorizedResponder('abcde', 'alice', requestMsg)).toBe(false)
  })
})
