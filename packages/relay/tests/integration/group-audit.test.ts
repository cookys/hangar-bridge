import { describe, it, expect, beforeEach } from 'vitest'
import { ALL_MEMBER_CAPS, newInstanceId } from '@hangar-bridge/shared'
import { openDatabase, type Db } from '../../src/db/db.ts'
import { MessageStore } from '../../src/messages/store.ts'
import { Fanout } from '../../src/fanout.ts'
import { PresenceRegistry } from '../../src/presence/registry.ts'
import { ClaimStore } from '../../src/claims/store.ts'
import { buildApp } from '../../src/app.ts'
import { generateRawToken, hashToken } from '../../src/auth/hash.ts'
import { seedPeers, type LoadedPeersFile } from '../../src/auth/peers-file.ts'

type Handle = 'a' | 'b' | 'c'

function strictRoster(tokens: Record<Handle, string>): LoadedPeersFile {
  const peer = (handle: Handle, defaultGroup: string) => ({
    handle,
    secret_sha256_hex: hashToken(tokens[handle]).toString('hex'),
    display_name: handle,
    subjects: { owned: [] as string[], interest: [] as string[] },
    default_group: defaultGroup,
  })
  return {
    mode: 'strict',
    peers: [peer('a', 'cookys'), peer('b', 'cookys'), peer('c', 'lab')],
    groups: [
      { id: 'cookys', description: 'home', history: 'all', members: [
        { handle: 'a', caps: ALL_MEMBER_CAPS.slice() },
        { handle: 'b', caps: ALL_MEMBER_CAPS.slice() },
      ] },
      { id: 'lab', description: 'lab', history: 'all', members: [
        { handle: 'b', caps: ALL_MEMBER_CAPS.slice() },
        { handle: 'c', caps: ALL_MEMBER_CAPS.slice() },
      ] },
    ],
  }
}

describe('strict group refusal audits', () => {
  let db: Db
  let app: ReturnType<typeof buildApp>
  let tok: Record<Handle, string>
  let inst: Record<Handle, string>

  beforeEach(() => {
    db = openDatabase(':memory:')
    tok = { a: generateRawToken(), b: generateRawToken(), c: generateRawToken() }
    inst = { a: newInstanceId(), b: newInstanceId(), c: newInstanceId() }
    seedPeers(db, strictRoster(tok))
    app = buildApp({
      db,
      store: new MessageStore(db),
      fanout: new Fanout(),
      presence: new PresenceRegistry(),
      claims: new ClaimStore(db),
      now: () => new Date('2026-09-16T00:00:00.000Z'),
      addressRules: 'on',
      groupsMode: 'strict',
    })
  })

  const post = (who: Handle, body: unknown, headers: Record<string, string> = {}) =>
    app.request('/v1/messages', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tok[who]}`,
        'content-type': 'application/json',
        'x-hangar-instance': inst[who],
        ...headers,
      },
      body: JSON.stringify(body),
    })

  const auditDetails = (event: string) =>
    (db.prepare('SELECT detail_json FROM audit_log WHERE event=? ORDER BY id').all(event) as Array<{ detail_json: string }>)
      .map(row => JSON.parse(row.detail_json) as Record<string, string>)

  const own = (handle: Handle, owned: string[]) => {
    db.prepare('UPDATE human SET subjects=? WHERE handle=?')
      .run(JSON.stringify({ owned, interest: [] }), handle)
  }

  it('audits strict idempotency_mismatch with group_id', async () => {
    const first = await post('b', { to: 'c', kind: 'chat', content: 'x', group: 'lab', all_sessions: true }, { 'idempotency-key': 'idem-audit' })
    expect(first.status).toBe(201)

    const res = await post('b', { to: 'a', kind: 'chat', content: 'x', group: 'cookys', all_sessions: true }, { 'idempotency-key': 'idem-audit' })
    expect(res.status).toBe(422)
    expect((await res.json() as { error: string }).error).toBe('idempotency_mismatch')

    expect(auditDetails('group.idempotency_mismatch')).toContainEqual({
      group_id: 'cookys',
      handle: 'b',
      cached_group_id: 'lab',
    })
  })

  it('audits strict cross-group not_in_thread with group_id', async () => {
    const parent = await (await post('a', { to: 'b', kind: 'chat', content: 'root', all_sessions: true })).json() as { id: string }

    const res = await post('b', { to: 'c', kind: 'chat', content: 'r', group: 'lab', thread_root: parent.id, all_sessions: true })
    expect(res.status).toBe(403)
    expect((await res.json() as { error: string }).error).toBe('not_in_thread')

    expect(auditDetails('group.not_in_thread')).toContainEqual({
      group_id: 'lab',
      handle: 'b',
      thread_root: parent.id,
    })
  })

  it('audits strict unknown in_reply_to parent with group_id before address refusals', async () => {
    const parent = await (await post('a', { to: 'b', kind: 'chat', content: 'root', all_sessions: true })).json() as { id: string }

    const res = await post('b', { to: 'c', kind: 'chat', content: 'ack', group: 'lab', in_reply_to: parent.id, all_sessions: true })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid_message', message: `unknown in_reply_to: ${parent.id}` })

    expect(auditDetails('group.unknown_parent')).toContainEqual({
      group_id: 'lab',
      handle: 'b',
      in_reply_to: parent.id,
    })
  })

  it('includes group_id on strict subject ACL audits', async () => {
    own('b', ['mple2'])

    const publish = await post('b', { to: 'c', kind: 'task_dispatch', content: 'go', group: 'lab', subject: 'other.ns' })
    expect(publish.status).toBe(403)
    expect(auditDetails('subject.publish_denied')[0]).toMatchObject({ group_id: 'lab', handle: 'b', subject: 'other.ns' })

    const recipient = await post('b', { to: 'c', kind: 'task_dispatch', content: 'go', group: 'lab', subject: 'mple2.cmd' })
    expect(recipient.status).toBe(409)
    expect(auditDetails('subject.recipient_denied')[0]).toMatchObject({ group_id: 'lab', to: 'c', subject: 'mple2.cmd' })
  })
})
