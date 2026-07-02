import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TEAM_BROADCAST_HANDLE, type Envelope } from '@hangar-bridge/shared'
import { checkDeliver, checkPublish, loadRoster, type RosterMap } from './subject-acl.ts'

const roster: RosterMap = {
  alice: {
    owned: ['proj', 'ops.task'],
    interest: ['chat.', 'ops.>'],
  },
  bob: {
    owned: ['proj'],
    interest: ['proj.>'],
  },
}

const mkEnv = (base: Partial<Envelope>): Envelope => ({
  id: 'msg_01HZXM8N8JY2M0YB0P9ZJ4WQ5G',
  v: 2,
  team: 'hangar',
  from: 'alice',
  to: 'bob',
  subject: 'proj.task',
  in_reply_to: null,
  thread_root: null,
  kind: 'chat',
  content: 'hello',
  meta: {},
  sent_at: '2026-01-01T00:00:00.000Z',
  delivered_at: null,
  ...base,
})

describe('checkPublish', () => {
  it('rejects publisher without namespace ownership', () => {
    const env = mkEnv({ from: 'bob', subject: 'mple2.status' })
    expect(checkPublish(env, roster)).toEqual({ ok: false, reason: 'forbidden_subject' })
  })

  it('rejects recipient without namespace ownership', () => {
    const env = mkEnv({ subject: 'proj.task', to: 'charlie' })
    expect(checkPublish(env, { ...roster, charlie: { owned: [], interest: [] } })).toEqual({
      ok: false,
      reason: 'recipient_not_owner',
    })
  })

  it('rejects non-null subject on in_reply_to', () => {
    const env = mkEnv({ in_reply_to: 'msg_01HZXM8N8JY2M0YB0P9ZJ4WQ6' })
    expect(checkPublish(env, roster)).toEqual({ ok: false, reason: 'in_reply_to_must_be_null' })
  })

  it('rejects subjected presence_update and permission_* kinds', () => {
    expect(checkPublish(mkEnv({ kind: 'presence_update' }), roster)).toEqual({ ok: false, reason: 'forbidden_subject' })
    expect(checkPublish(mkEnv({ kind: 'permission_request' }), roster)).toEqual({ ok: false, reason: 'forbidden_subject' })
    expect(checkPublish(mkEnv({ kind: 'permission_verdict' }), roster)).toEqual({ ok: false, reason: 'forbidden_subject' })
  })

  it('rejects subjected direct-to-team', () => {
    const env = mkEnv({
      to: TEAM_BROADCAST_HANDLE,
      subject: 'proj.task',
    })
    expect(checkPublish(env, roster)).toEqual({ ok: false, reason: 'recipient_not_owner' })
  })

  it('allows null-subject regardless of ACL', () => {
    expect(checkPublish(mkEnv({ subject: null }), roster)).toMatchObject({ ok: true })
    expect(checkPublish(mkEnv({ subject: null, from: 'nobody', to: TEAM_BROADCAST_HANDLE }), roster)).toMatchObject({ ok: true })
  })
})

describe('checkDeliver', () => {
  it('allows null-subject messages', () => {
    const env = mkEnv({ to: 'alice', subject: null })
    expect(checkDeliver(env, 'alice', roster)).toBe(true)
  })

  it('denies non-owner local recipient', () => {
    // subject namespace is `other`; deliver only when the local handle OWNS that
    // namespace (fail-closed). Owner → true; non-owner → false.
    const env = mkEnv({ to: 'alice', from: 'bob', subject: 'other.subject' })
    // owns 'other' with no narrowing interest → delivered; owns nothing → denied.
    expect(checkDeliver(env, 'alice', { ...roster, alice: { owned: ['other'], interest: [] } })).toBe(true)
    expect(checkDeliver(env, 'alice', { ...roster, alice: { owned: [], interest: [] } })).toBe(false)
  })

  it('uses receiver interest to narrow deliverability', () => {
    const narrow = mkEnv({ subject: 'ops.task.2' })
    const narrowedRoster: RosterMap = {
      ...roster,
      alice: {
        ...roster.alice,
        owned: ['ops'],
        interest: ['ops.task.>'],
      },
    }
    expect(checkDeliver(narrow, 'alice', narrowedRoster)).toBe(true)
    expect(checkDeliver(mkEnv({ subject: 'ops.other' }), 'alice', narrowedRoster)).toBe(false)
  })
})

describe('loadRoster', () => {
  it('parses roster file shape into owned/interest map', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-'))
    try {
      const p = join(dir, 'fleet-roster.json')
      writeFileSync(p, JSON.stringify({
        alice: { display_name: 'Alice', owned: ['proj'], interest: ['proj.>'] },
        bob: { display_name: 'Bob', owned: [], interest: [] },
      }))
      expect(loadRoster(p)).toEqual({
        alice: { owned: ['proj'], interest: ['proj.>'] },
        bob: { owned: [], interest: [] },
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
