import { describe, it, expect, beforeEach } from 'vitest'
import { openDatabase, type Db } from '../../src/db/db.ts'
import { MessageStore } from '../../src/messages/store.ts'
import { Fanout } from '../../src/fanout.ts'
import { PresenceRegistry } from '../../src/presence/registry.ts'
import { buildApp } from '../../src/app.ts'
import { seedPeerSecrets } from './_seed.ts'
import { ClaimStore } from '../../src/claims/store.ts'

// Fail-closed namespace ACL over the publish chokepoint (POST /v1/messages).
describe('subject ACL — publish gate', () => {
  let db: Db
  let app: ReturnType<typeof buildApp>
  let aliceToken: string

  const own = (handle: string, owned: string[]) =>
    db.prepare('UPDATE human SET subjects=? WHERE handle=?')
      .run(JSON.stringify({ owned, interest: [] }), handle)

  beforeEach(() => {
    db = openDatabase(':memory:')
    const peers = seedPeerSecrets(db, ['alice', 'bob'])
    aliceToken = peers.alice!.token
    app = buildApp({ db, store: new MessageStore(db), fanout: new Fanout(), presence: new PresenceRegistry(), claims: new ClaimStore(db), now: () => new Date() })
  })

  const post = (body: unknown, headers: Record<string, string> = {}) =>
    app.request('/v1/messages', {
      method: 'POST',
      headers: { authorization: `Bearer ${aliceToken}`, 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body)
    })

  it('201 when publisher AND recipient own the namespace', async () => {
    own('alice', ['mple2']); own('bob', ['mple2'])
    const res = await post({ to: 'bob', kind: 'task_dispatch', content: 'go', subject: 'mple2.command.assign' })
    expect(res.status).toBe(201)
    const e = await res.json() as { subject: string }
    expect(e.subject).toBe('mple2.command.assign')
  })

  it('403 forbidden_subject + audit row when publisher does NOT own (fail-closed)', async () => {
    own('bob', ['mple2']) // recipient owns, but alice does not
    const res = await post({ to: 'bob', kind: 'task_dispatch', content: 'go', subject: 'mple2.x' })
    expect(res.status).toBe(403)
    expect((await res.json() as { error: string }).error).toBe('forbidden_subject')
    const audit = db.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE event='subject.publish_denied'").get() as { c: number }
    expect(audit.c).toBe(1)
    expect((db.prepare('SELECT COUNT(*) AS c FROM message').get() as { c: number }).c).toBe(0)
  })

  it('409 recipient_not_owner + audit when recipient does NOT own', async () => {
    own('alice', ['mple2']) // publisher owns, recipient does not
    const res = await post({ to: 'bob', kind: 'task_dispatch', content: 'go', subject: 'mple2.x' })
    expect(res.status).toBe(409)
    expect((await res.json() as { error: string }).error).toBe('recipient_not_owner')
    const audit = db.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE event='subject.recipient_denied'").get() as { c: number }
    expect(audit.c).toBe(1)
  })

  it('fail-closed: an unclaimed namespace is publishable by nobody', async () => {
    // neither alice nor bob own anything
    const res = await post({ to: 'bob', kind: 'task_dispatch', content: 'go', subject: 'mple2.x' })
    expect(res.status).toBe(403)
  })

  it('400 on subjected @team task_dispatch (commands stay direct — R1)', async () => {
    own('alice', ['mple2'])
    const res = await post({ to: '@team', kind: 'task_dispatch', content: 'go', subject: 'mple2.x' })
    expect(res.status).toBe(400)
  })

  it('#3: 201 on subjected @team CHAT when publisher owns; recipient-ownership NOT required', async () => {
    own('alice', ['mple2']) // note: NO recipient owns — @team has no single recipient
    const res = await post({ to: '@team', kind: 'chat', content: 'heads up', subject: 'mple2.status' })
    expect(res.status).toBe(201)
    const e = await res.json() as { subject: string; to: string; delivered_at: string | null }
    expect(e.subject).toBe('mple2.status')
    expect(e.to).toBe('@team')
    // subjected ⇒ NOT stamped on enqueue (stream write loop is the sole delivered_at writer)
    expect(e.delivered_at).toBe(null)
  })

  it('#3: 403 on subjected @team CHAT when publisher does NOT own the namespace', async () => {
    const res = await post({ to: '@team', kind: 'chat', content: 'x', subject: 'mple2.status' })
    expect(res.status).toBe(403)
    expect((await res.json() as { error: string }).error).toBe('forbidden_subject')
    expect((db.prepare('SELECT COUNT(*) AS c FROM message').get() as { c: number }).c).toBe(0)
  })

  it('null-subject chat is unrestricted (back-compat), regardless of ownership', async () => {
    const res = await post({ to: 'bob', kind: 'chat', content: 'hi' })
    expect(res.status).toBe(201)
  })

  it('B1: forged reserved meta keys (subject/kind) stripped at publish; task_kind label survives', async () => {
    const res = await post({
      to: 'bob', kind: 'chat', content: 'hi',
      meta: { subject: 'mple2.assign', task_kind: 'mple2.assign', kind: 'task_dispatch', foo: 'bar' }
    })
    expect(res.status).toBe(201)
    const row = db.prepare('SELECT meta_json FROM message LIMIT 1').get() as { meta_json: string }
    const meta = JSON.parse(row.meta_json) as Record<string, string>
    expect(meta.foo).toBe('bar')
    expect(meta.task_kind).toBe('mple2.assign')  // benign label, NOT reserved
    expect(meta.subject).toBeUndefined()
    expect(meta.kind).toBeUndefined()
  })

  it('B4: a subjected message with no live subscriber stays delivered_at=null (not stamped on publish)', async () => {
    own('alice', ['mple2']); own('bob', ['mple2'])
    const res = await post({ to: 'bob', kind: 'task_dispatch', content: 'go', subject: 'mple2.x' })
    expect(res.status).toBe(201)
    const row = db.prepare('SELECT delivered_at FROM message LIMIT 1').get() as { delivered_at: string | null }
    expect(row.delivered_at).toBe(null)
  })

  // Critical-fix regression: the gate must key on subject PRESENCE, not a kind
  // allow-list. A non-owner must not smuggle a gated subject via a non-command kind.
  it('rejects a subjected non-command kind (presence_update) with 400 — no gate bypass', async () => {
    // alice does NOT own mple2; without the fix this would skip the gate + persist.
    const res = await post({ to: 'bob', kind: 'presence_update', content: 'x', subject: 'mple2.command' })
    expect(res.status).toBe(400)
    expect((db.prepare('SELECT COUNT(*) AS c FROM message').get() as { c: number }).c).toBe(0)
  })

  // Major-fix regression: task_kind is a benign label and MUST survive the strip
  // (only subject/kind are reserved); subject/kind forged in meta must be stripped.
  it('keeps task_kind label, strips forged subject/kind, on a gated dispatch', async () => {
    own('alice', ['mple2']); own('bob', ['mple2'])
    const res = await post({
      to: 'bob', kind: 'task_dispatch', content: 'go', subject: 'mple2.assign',
      meta: { task_kind: 'mple2.assign', correlation_id: '01HRK7Y0000000000000000000', subject: 'evil', kind: 'chat' }
    })
    expect(res.status).toBe(201)
    const row = db.prepare('SELECT meta_json FROM message LIMIT 1').get() as { meta_json: string }
    const meta = JSON.parse(row.meta_json) as Record<string, string>
    expect(meta.task_kind).toBe('mple2.assign')
    expect(meta.correlation_id).toBe('01HRK7Y0000000000000000000')
    expect(meta.subject).toBeUndefined()
    expect(meta.kind).toBeUndefined()
  })
})
