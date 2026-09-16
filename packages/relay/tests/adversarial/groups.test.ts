/**
 * Adversarial harness for relay groups (plan docs/plans/2026-09-16-relay-groups.md, P1-7).
 *
 * DEPTH-0 OWNED. The P1 implementer must not edit this file; it is part of `verify_cmd`.
 * It drives the real app (every route, real SQLite, real bearer auth) under a STRICT roster and
 * asserts the group boundary from the outside: a non-member learns nothing about a group's
 * existence, members, messages, claims, presence or activity, and every refusal is byte-identical
 * to the "truly nonexistent" refusal. RED on the P0 base by design.
 *
 * Roster (strict, peers.json v2 semantics via seedPeers):
 *   cookys  history:all        members a (all caps), b (all caps), x (all caps)
 *   lab     history:since_join members b (all caps), c (caps: chat only)
 *   default_group: a=cookys b=cookys c=lab x=cookys
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, type Db } from '../../src/db/db.ts'
import { MessageStore } from '../../src/messages/store.ts'
import { Fanout } from '../../src/fanout.ts'
import { PresenceRegistry } from '../../src/presence/registry.ts'
import { ClaimStore } from '../../src/claims/store.ts'
import { buildApp } from '../../src/app.ts'
import { generateRawToken, hashToken } from '../../src/auth/hash.ts'
import { seedPeers, type LoadedPeersFile } from '../../src/auth/peers-file.ts'
import { reloadRoster } from '../../src/cli/serve.ts'
import { sharedAudience } from '../../src/groups.ts'
import { newInstanceId, newMessageId, ALL_MEMBER_CAPS } from '@hangar-bridge/shared'

type Handle = 'a' | 'b' | 'c' | 'x'
const HANDLES: Handle[] = ['a', 'b', 'c', 'x']
const METRICS_TOKEN = 'metrics-token-for-tests'

function rosterFile(tokens: Record<Handle, string>, opts: { cInLab?: boolean; cCaps?: string[]; bInLab?: boolean } = {}): LoadedPeersFile {
  const cInLab = opts.cInLab ?? true
  const bInLab = opts.bInLab ?? true
  const cCaps = (opts.cCaps ?? ['chat']) as any
  const peer = (h: Handle, dg: string) => ({
    handle: h, secret_sha256_hex: hashToken(tokens[h]).toString('hex'), display_name: h,
    subjects: { owned: [] as string[], interest: [] as string[] }, default_group: dg,
  })
  const labMembers: Array<{ handle: string; caps: any }> = []
  if (bInLab) labMembers.push({ handle: 'b', caps: ALL_MEMBER_CAPS.slice() })
  if (cInLab) labMembers.push({ handle: 'c', caps: cCaps })
  return {
    mode: 'strict',
    peers: [peer('a', 'cookys'), peer('b', 'cookys'), peer('c', cInLab ? 'lab' : 'cookys'), peer('x', 'cookys')],
    groups: [
      { id: 'cookys', description: 'home', history: 'all', members: [
        { handle: 'a', caps: ALL_MEMBER_CAPS.slice() }, { handle: 'b', caps: ALL_MEMBER_CAPS.slice() }, { handle: 'x', caps: ALL_MEMBER_CAPS.slice() },
        ...(cInLab ? [] : [{ handle: 'c', caps: ALL_MEMBER_CAPS.slice() }]),
      ] },
      { id: 'lab', description: 'guests', history: 'since_join', members: labMembers },
    ],
  }
}

/** Serialise a LoadedPeersFile as a v2 peers.json so reloadRoster can read it back. */
function writeV2(path: string, file: LoadedPeersFile): void {
  const peers: Record<string, unknown> = {}
  for (const p of file.peers) peers[p.handle] = { secret_sha256_hex: p.secret_sha256_hex, display_name: p.display_name, subjects: p.subjects, default_group: p.default_group }
  const groups: Record<string, unknown> = {}
  for (const g of file.groups) {
    const members: Record<string, unknown> = {}
    for (const m of g.members) members[m.handle] = { caps: m.caps }
    groups[g.id] = { description: g.description, history: g.history, members }
  }
  writeFileSync(path, JSON.stringify({ peers, groups }), { mode: 0o600 })
}

async function readNEvents(stream: ReadableStream<Uint8Array>, n: number, timeoutMs = 1500): Promise<string[]> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const events: string[] = []
  let buf = ''
  const deadline = Date.now() + timeoutMs
  while (events.length < n && Date.now() < deadline) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    const timeoutPromise = new Promise<{ value: undefined; done: true }>(resolve => setTimeout(() => resolve({ value: undefined, done: true }), remaining))
    const { value, done } = await Promise.race([reader.read(), timeoutPromise])
    if (done) break
    buf += decoder.decode(value)
    const parts = buf.split('\n\n')
    buf = parts.pop() ?? ''
    events.push(...parts.filter(p => p.trim().length > 0))
  }
  try { await reader.cancel() } catch { /* ignore */ }
  return events
}
const messageEvents = (evs: string[]) => evs.filter(e => /^event: message/m.test(e))
const eventKinds = (evs: string[]) => messageEvents(evs).map(e => JSON.parse(e.split('\n').find(l => l.startsWith('data: '))!.slice(6)).kind as string)

describe('relay groups — adversarial boundary (strict roster)', () => {
  let db: Db
  let app: ReturnType<typeof buildApp>
  let deps: any
  let tok: Record<Handle, string>
  let dir: string
  let file: LoadedPeersFile
  const inst: Record<Handle, string> = { a: '', b: '', c: '', x: '' }

  beforeEach(() => {
    db = openDatabase(':memory:')
    tok = { a: generateRawToken(), b: generateRawToken(), c: generateRawToken(), x: generateRawToken() }
    file = rosterFile(tok)
    seedPeers(db, file)
    for (const h of HANDLES) inst[h] = newInstanceId()
    const fanout = new Fanout({ sharedAudience: (_team: string, handle: string) => sharedAudience(db, handle) } as any)
    deps = { db, store: new MessageStore(db), fanout, presence: new PresenceRegistry(), claims: new ClaimStore(db), now: () => new Date(), addressRules: 'on', metricsToken: METRICS_TOKEN, groupsMode: 'strict' }
    app = buildApp(deps)
    dir = mkdtempSync(join(tmpdir(), 'groups-adv-'))
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  const req = (h: Handle | null, path: string, init: RequestInit & { instance?: string } = {}) => {
    const headers: Record<string, string> = { 'content-type': 'application/json', ...(init.headers as Record<string, string> ?? {}) }
    if (h) { headers.authorization = `Bearer ${tok[h]}`; headers['x-hangar-instance'] = init.instance ?? inst[h] }
    return app.request(path, { ...init, headers })
  }
  const post = (h: Handle, path: string, body: unknown, extra: Record<string, string> = {}) => req(h, path, { method: 'POST', body: JSON.stringify(body), headers: extra })
  // all_sessions is only legal on a chat to a concrete handle (addressRules §6.3); add it only there.
  const send = (h: Handle, body: Record<string, unknown>, extra: Record<string, string> = {}) => {
    const bare = typeof body.to === 'string' && !body.to.startsWith('@') && (body.kind ?? 'chat') === 'chat' && body.in_reply_to === undefined
    return post(h, '/v1/messages', bare ? { all_sessions: true, ...body } : body, extra)
  }
  const bodyOf = async (r: Response) => ({ status: r.status, text: await r.text() })
  const openStream = (h: Handle, qs = '') => req(h, `/v1/stream${qs}`)
  const audit = (event: string) => db.prepare('SELECT detail_json FROM audit_log WHERE event=?').all(event) as Array<{ detail_json: string }>

  // ---------------------------------------------------------------- whoami / peers
  it('GET /v1/whoami reports only the caller\'s own memberships', async () => {
    const r = await req('c', '/v1/whoami')
    expect(r.status).toBe(200)
    const j = await r.json() as any
    expect(j.handle).toBe('c')
    expect(j.default_group).toBe('lab')
    expect(j.groups.map((g: any) => g.id)).toEqual(['lab'])
    expect(j.groups[0].caps).toEqual(['chat'])
    expect(j.groups[0].history).toBe('since_join')
  })

  it('GET /v1/peers: c sees only lab members with groups[], never a or x; a never sees c; cache is per membership', async () => {
    const ra = await (await req('a', '/v1/peers')).json() as any[]
    expect(ra.map(p => p.handle).sort()).toEqual(['a', 'b', 'x'])
    // within the 2 s cache window, a different membership must not receive a's body
    const rc = await (await req('c', '/v1/peers')).json() as any[]
    expect(rc.map(p => p.handle).sort()).toEqual(['b', 'c'])
    for (const p of rc) expect(p.groups.map((g: any) => g.id)).toEqual(['lab'])
    const rb = await (await req('b', '/v1/peers')).json() as any[]
    expect(rb.map(p => p.handle).sort()).toEqual(['a', 'b', 'c', 'x'])
    expect(rb.find(p => p.handle === 'b').groups.map((g: any) => g.id).sort()).toEqual(['cookys', 'lab'])
    expect(rb.find(p => p.handle === 'c').groups.map((g: any) => g.id)).toEqual(['lab'])
  })

  // ---------------------------------------------------------------- POST /v1/messages
  it('non-member direct send is byte-identical to a nonexistent recipient (404 unknown_recipient) and audited with group_id', async () => {
    const toFleet = await bodyOf(await send('c', { to: 'a', kind: 'chat', content: 'hi' }))
    const toNobody = await bodyOf(await send('c', { to: 'nobody', kind: 'chat', content: 'hi' }))
    expect(toFleet.status).toBe(404)
    expect(toFleet).toEqual(toNobody)
    expect(JSON.parse(toFleet.text).error).toBe('unknown_recipient')
    expect(toFleet.text).not.toContain('live_instances')
    const rows = audit('group.unknown_recipient')
    expect(rows.length).toBeGreaterThanOrEqual(1)
    expect(JSON.parse(rows[0]!.detail_json).group_id).toBe('lab')
  })

  it('addressRules=on: a non-member target without all_sessions is still 404, never handle_needs_all_sessions', async () => {
    const r = await bodyOf(await post('c', '/v1/messages', { to: 'a', kind: 'chat', content: 'hi' }))
    const n = await bodyOf(await post('c', '/v1/messages', { to: 'nobody', kind: 'chat', content: 'hi' }))
    expect(r.status).toBe(404)
    expect(r).toEqual(n)
  })

  it('choosing a group you are not in is 404 unknown_group; a member choosing it is 201', async () => {
    const r = await send('a', { to: 'b', kind: 'chat', content: 'x', group: 'lab' })
    expect(r.status).toBe(404)
    expect((await r.json() as any).error).toBe('unknown_group')
    const ok = await send('b', { to: 'c', kind: 'chat', content: 'x', group: 'lab' })
    expect(ok.status).toBe(201)
    expect((await ok.json() as any).group).toBe('lab')
    expect(JSON.parse(audit('group.unknown_group')[0]!.detail_json).group_id).toBe('lab')
  })

  it('caps: c (chat only) cannot broadcast or dispatch in lab (403 cap_denied), but can chat', async () => {
    const bc = await send('c', { to: '@group', kind: 'chat', content: 'BROADCAST hello' })
    expect(bc.status).toBe(403)
    expect((await bc.json() as any).error).toBe('cap_denied')
    const dp = await send('c', { to: 'b', kind: 'task_dispatch', content: 'run', meta: { correlation_id: 'c1' } })
    expect(dp.status).toBe(403)
    expect((await dp.json() as any).error).toBe('cap_denied')
    const ch = await send('c', { to: 'b', kind: 'chat', content: 'hello' })
    expect(ch.status).toBe(201)
    expect(JSON.parse(audit('group.cap_denied')[0]!.detail_json).group_id).toBe('lab')
  })

  it('default group: a bare send lands in default_group; @team is an alias for @group on default_group and is audited', async () => {
    const e1 = await (await send('b', { to: 'a', kind: 'chat', content: 'x' })).json() as any
    expect(e1.group).toBe('cookys')
    const e2 = await (await send('b', { to: '@team', kind: 'chat', content: 'x' })).json() as any
    expect(e2.group).toBe('cookys')
    expect(e2.to).toBe('@group')
    expect(db.prepare("SELECT to_handle FROM message WHERE id=?").get(e2.id)).toEqual({ to_handle: '@group' })
    expect(audit('deprecated_team_alias').length).toBe(1)
    const e3 = await (await send('b', { to: '@group', kind: 'chat', content: 'x', group: 'lab' })).json() as any
    expect(e3.group).toBe('lab')
  })

  it('in_reply_to across groups is byte-identical to a nonexistent parent; same-group parent is accepted', async () => {
    const parent = await (await send('a', { to: 'b', kind: 'task_dispatch', content: 'run', meta: { correlation_id: 'c1' } })).json() as any
    // b is in both groups: choosing lab for a task_result whose parent lives in cookys must look like "no such parent"
    const cross = await bodyOf(await send('b', { to: 'a', kind: 'task_result', content: 'done', group: 'lab', in_reply_to: parent.id, meta: { correlation_id: 'c1' } }))
    const random = await bodyOf(await send('b', { to: 'a', kind: 'task_result', content: 'done', group: 'lab', in_reply_to: newMessageId(), meta: { correlation_id: 'c1' } }))
    expect(cross).toEqual(random)
    const same = await send('b', { to: 'a', kind: 'task_result', content: 'done', group: 'cookys', in_reply_to: parent.id, meta: { correlation_id: 'c1' } })
    expect(same.status).toBe(201)
    const crossTr = await bodyOf(await send('b', { to: 'c', kind: 'chat', content: 'r', group: 'lab', thread_root: parent.id }))
    const randomTr = await bodyOf(await send('b', { to: 'c', kind: 'chat', content: 'r', group: 'lab', thread_root: newMessageId() }))
    expect(crossTr.status).toBe(403)
    expect(crossTr).toEqual(randomTr)
  })

  it('meta.group is stripped; relay-stamped group wins', async () => {
    const e = await (await send('b', { to: 'c', kind: 'chat', content: 'x', group: 'lab', meta: { group: 'cookys', k: 'v' } })).json() as any
    expect(e.group).toBe('lab')
    expect(e.meta.group).toBeUndefined()
    expect(e.meta.k).toBe('v')
  })

  it('idempotency replay with a different group is 422; replay after being removed from the group is 404', async () => {
    const first = await send('b', { to: 'c', kind: 'chat', content: 'x', group: 'lab' }, { 'idempotency-key': 'k1' })
    expect(first.status).toBe(201)
    const again = await send('b', { to: 'c', kind: 'chat', content: 'x', group: 'lab' }, { 'idempotency-key': 'k1' })
    expect(again.status).toBe(201)
    const other = await send('b', { to: 'c', kind: 'chat', content: 'x', group: 'cookys' }, { 'idempotency-key': 'k1' })
    expect(other.status).toBe(422)
    expect((await other.json() as any).error).toBe('idempotency_mismatch')
    seedPeers(db, rosterFile(tok, { bInLab: false }))
    const removed = await send('b', { to: 'c', kind: 'chat', content: 'x', group: 'lab' }, { 'idempotency-key': 'k1' })
    expect(removed.status).toBe(404)
    expect((await removed.json() as any).error).toBe('unknown_group')
  })

  // ---------------------------------------------------------------- read side
  it('poll: c sees only lab rows sent after joining; b sees both groups', async () => {
    // lab existed before c joined: reseed without c, send, then add c back
    seedPeers(db, rosterFile(tok, { cInLab: false }))
    // c is now in cookys (all caps) — move it back to lab AFTER b's early message
    const early = await (await send('b', { to: '@group', kind: 'chat', content: 'before c', group: 'lab' })).json() as any
    seedPeers(db, rosterFile(tok))
    const late = await (await send('b', { to: '@group', kind: 'chat', content: 'after c', group: 'lab' })).json() as any
    await send('a', { to: '@group', kind: 'chat', content: 'fleet only' })
    const pc = await (await req('c', '/v1/messages')).json() as any
    expect(pc.messages.map((m: any) => m.id)).toEqual([late.id])
    expect(pc.messages.map((m: any) => m.id)).not.toContain(early.id)
    const pb = await (await req('b', '/v1/messages')).json() as any
    const groups = new Set(pb.messages.map((m: any) => m.group))
    expect(groups.has('cookys') && groups.has('lab')).toBe(true)
  })

  it('stream: @group cookys reaches b not c; @group lab reaches c not a; presence heartbeats only cross shared groups', async () => {
    const sb = await openStream('b'); const sc = await openStream('c'); const sa = await openStream('a')
    await send('a', { to: '@group', kind: 'chat', content: 'BROADCAST fleet' })
    await send('b', { to: '@group', kind: 'chat', content: 'BROADCAST lab', group: 'lab' })
    await post('a', '/v1/presence', { instance: inst.a, cwd: '/home/a/secret', repo: 'secret' })
    await post('b', '/v1/presence', { instance: inst.b, cwd: '/home/b', repo: 'shared' })
    const evB = eventKinds(await readNEvents(sb.body!, 6, 1200))
    const evC = eventKinds(await readNEvents(sc.body!, 6, 1200))
    const evA = eventKinds(await readNEvents(sa.body!, 6, 1200))
    expect(evB.filter(k => k === 'chat').length).toBe(2)
    expect(evC.filter(k => k === 'chat').length).toBe(1)
    expect(evA.filter(k => k === 'chat').length).toBe(1)
    // presence: a's heartbeat reaches b (shares cookys) but never c; b's reaches a and c
    expect(evC.filter(k => k === 'presence_update').length).toBe(1)
    expect(evA.filter(k => k === 'presence_update').length).toBe(1)
    expect(evB.filter(k => k === 'presence_update').length).toBe(1)
  })

  it('delivered_at for @group lab is stamped only when a LAB member is online', async () => {
    const sx = await openStream('x') // x is cookys-only and online
    const e = await (await send('b', { to: '@group', kind: 'chat', content: 'BROADCAST lab', group: 'lab' })).json() as any
    expect(e.delivered_at).toBeNull()
    await readNEvents(sx.body!, 1, 200)
    const sc = await openStream('c')
    const got = eventKinds(await readNEvents(sc.body!, 1, 1200))
    expect(got).toEqual(['chat'])
  })

  it('cold-start stream for c never replays cookys rows and reports no cookys backlog', async () => {
    for (let i = 0; i < 12; i++) await send('a', { to: '@group', kind: 'chat', content: `BROADCAST ${i}` })
    const s = await openStream('c', '?since=msg_01HRK7Y0000000000000000000&replay_max=1')
    const evs = await readNEvents(s.body!, 3, 800)
    expect(messageEvents(evs).length).toBe(0)
    const backlog = evs.find(e => /^event: backlog$/m.test(e))
    if (backlog) expect(backlog).toMatch(/"pending":0/)
  })

  // ---------------------------------------------------------------- replies / permission / grants / inbox
  it('replying to a cookys message as c is byte-identical to a nonexistent parent (404 unknown_parent)', async () => {
    const parent = await (await send('a', { to: 'b', kind: 'chat', content: 'root' })).json() as any
    // /v1/replies requires an Idempotency-Key (existing contract); keep it so the group check is what we measure
    const cross = await bodyOf(await post('c', '/v1/replies', { in_reply_to: parent.id, content: 'r' }, { 'idempotency-key': 'k-cross' }))
    const random = await bodyOf(await post('c', '/v1/replies', { in_reply_to: newMessageId(), content: 'r' }, { 'idempotency-key': 'k-random' }))
    expect(cross.status).toBe(404)
    expect(JSON.parse(cross.text).error).toBe('unknown_parent')
    expect(cross).toEqual(random)
    const ok = await (await send('b', { to: 'c', kind: 'chat', content: 'q', group: 'lab' })).json() as any
    const reply = await post('c', '/v1/replies', { in_reply_to: ok.id, content: 'a' }, { 'idempotency-key': 'k-ok' })
    expect(reply.status).toBe(200) // existing /v1/replies status; strict mode must not change it
  })

  it('permission/respond, grants/finalize and inbox never admit another group\'s ids', async () => {
    const pr = await (await send('a', { to: 'b', kind: 'permission_request', content: 'may I?', meta: { request_id: 'abcde' } })).json() as any
    void pr
    const cross = await bodyOf(await post('c', '/v1/permission/respond', { request_id: 'abcde', verdict: 'allow' }))
    const random = await bodyOf(await post('c', '/v1/permission/respond', { request_id: 'zzzzz', verdict: 'allow' }))
    expect(cross).toEqual(random)
    const own = await post('b', '/v1/permission/respond', { request_id: 'abcde', verdict: 'allow' })
    expect(own.status).toBe(200)
    const parent = await (await send('a', { to: 'b', kind: 'chat', content: 'root' })).json() as any
    const g1 = await bodyOf(await post('c', '/v1/grants/finalize', { msg_id: parent.id, selector: `pane@${newInstanceId()}` }))
    const g2 = await bodyOf(await post('c', '/v1/grants/finalize', { msg_id: newMessageId(), selector: `pane@${newInstanceId()}` }))
    expect(g1).toEqual(g2)
    const inbox = await (await req('c', '/v1/inbox')).json() as any
    expect(inbox.messages.every((m: any) => m.group === 'lab')).toBe(true)
  })

  // ---------------------------------------------------------------- claims
  it('claims are per group: same key in two groups coexists; c cannot claim; release needs the right group', async () => {
    const ca = await post('a', '/v1/claim', { key: 'gpu0' })
    expect(ca.status).toBe(201)
    const cb = await post('b', '/v1/claim', { key: 'gpu0', group: 'lab' })
    expect(cb.status).toBe(201)
    const cc = await post('c', '/v1/claim', { key: 'other' })
    expect(cc.status).toBe(403)
    expect((await cc.json() as any).error).toBe('cap_denied')
    const listC = await (await req('c', '/v1/claims')).json() as any[]
    expect(listC.map(x => x.group_id)).toEqual(['lab'])
    const listA = await (await req('a', '/v1/claims')).json() as any[]
    expect(listA.map(x => x.group_id)).toEqual(['cookys'])
    const wrong = await (await post('b', '/v1/claim/release', { key: 'gpu0' })).json() as any // default cookys, owner is a
    expect(wrong.released).toBe(false)
    const right = await (await post('b', '/v1/claim/release', { key: 'gpu0', group: 'lab' })).json() as any
    expect(right.released).toBe(true)
    const foreign = await post('c', '/v1/claim/release', { key: 'gpu0', group: 'cookys' })
    expect(foreign.status).toBe(404)
    expect((await foreign.json() as any).error).toBe('unknown_group')
  })

  // ---------------------------------------------------------------- metrics
  it('/metrics: peer bearers are 401, the metrics token is 200', async () => {
    expect((await req(null, '/metrics')).status).toBe(401)
    expect((await req('a', '/metrics')).status).toBe(401)
    expect((await req('c', '/metrics')).status).toBe(401)
    const ok = await app.request('/metrics', { headers: { authorization: `Bearer ${METRICS_TOKEN}` } })
    expect(ok.status).toBe(200)
  })

  // ---------------------------------------------------------------- SIGHUP shrink / grow / removal
  it('reloadRoster: shrinking b out of lab drops b\'s stream with reauth; growing x into lab needs no reconnect; removing c revokes', async () => {
    const sb = await openStream('b')
    const sx = await openStream('x')
    const path = join(dir, 'peers.json')
    // shrink: b leaves lab; grow: x joins lab
    const next = rosterFile(tok, { bInLab: false })
    next.groups[1]!.members.push({ handle: 'x', caps: ALL_MEMBER_CAPS.slice() })
    writeV2(path, next)
    expect(reloadRoster(deps, path)).toBe(true)
    const evB = await readNEvents(sb.body!, 2, 800)
    expect(evB.some(e => /^event: reauth$/m.test(e))).toBe(true)
    // x's stream was never dropped and receives the next lab broadcast live
    await send('c', { to: 'x', kind: 'chat', content: 'hi x', group: 'lab' })
    const evX = eventKinds(await readNEvents(sx.body!, 1, 1200))
    expect(evX).toEqual(['chat'])
    // b reconnects and no longer receives lab traffic
    const sb2 = await openStream('b')
    await send('c', { to: '@group', kind: 'chat', content: 'BROADCAST lab' }).catch(() => undefined) // c has no broadcast cap → 403, fine
    await send('x', { to: '@group', kind: 'chat', content: 'BROADCAST lab', group: 'lab' })
    const evB2 = eventKinds(await readNEvents(sb2.body!, 1, 600))
    expect(evB2).toEqual([])
    // removal: c vanishes from the file
    const gone = rosterFile(tok, { bInLab: false, cInLab: true })
    gone.peers = gone.peers.filter(p => p.handle !== 'c')
    gone.groups[1]!.members = gone.groups[1]!.members.filter(m => m.handle !== 'c')
    gone.groups[1]!.members.push({ handle: 'x', caps: ALL_MEMBER_CAPS.slice() })
    writeV2(path, gone)
    expect(reloadRoster(deps, path)).toBe(true)
    expect((await req('c', '/v1/whoami')).status).toBe(401)
    expect(db.prepare("SELECT disabled_at FROM human WHERE handle='c'").get()).not.toEqual({ disabled_at: null })
    expect(audit('peer.removed').length).toBe(1)
    // strict → legacy is refused and keeps the roster
    writeFileSync(path, JSON.stringify({ a: { secret_sha256_hex: hashToken(tok.a).toString('hex') } }))
    expect(reloadRoster(deps, path)).toBe(false)
    expect((await req('x', '/v1/whoami')).status).toBe(200)
  })
})
