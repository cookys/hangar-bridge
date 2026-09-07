import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { InboxSpool, mergeInboxPage } from './inbox-spool.ts'

const env = (id: string, content = 'x') => ({
  id, v: 2, team: 't', from: 'a', to: 'b', subject: null, in_reply_to: null, thread_root: null,
  kind: 'chat', content, meta: {}, sent_at: '2026-01-01T00:00:00.000Z', delivered_at: null,
}) as any

describe('InboxSpool', () => {
  let dir: string
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

  it('appends idempotently, reads sorted, survives reopen, filters by since', () => {
    dir = mkdtempSync(join(tmpdir(), 'spool-'))
    const p = join(dir, 'nested', 'inbox-spool.jsonl')
    const s = new InboxSpool({ path: p })
    expect(s.append(env('msg_02'))).toBe(true)
    expect(s.append(env('msg_01'))).toBe(true)
    expect(s.append(env('msg_02'))).toBe(false)
    expect(s.read().map(e => e.id)).toEqual(['msg_01', 'msg_02'])
    const again = new InboxSpool({ path: p })
    expect(again.append(env('msg_01'))).toBe(false)
    expect(again.after('msg_01').map(e => e.id)).toEqual(['msg_02'])
    expect(again.after(undefined).length).toBe(2)
  })

  it('compacts to max when it grows past 2×max', () => {
    dir = mkdtempSync(join(tmpdir(), 'spool-'))
    const s = new InboxSpool({ path: join(dir, 'spool.jsonl'), max: 3 })
    for (let i = 1; i <= 7; i++) s.append(env(`msg_0${i}`))
    expect(s.read().map(e => e.id)).toEqual(['msg_05', 'msg_06', 'msg_07'])
  })
})

describe('mergeInboxPage', () => {
  it('unions by id, sorts, honours since and limit, advances next_cursor', () => {
    const page = { messages: [env('msg_02'), env('msg_04')], next_cursor: 'msg_04' }
    const spooled = [env('msg_01'), env('msg_03'), env('msg_04'), env('msg_05')]
    const r = mergeInboxPage(page, spooled, { since: 'msg_01' })
    expect(r.messages.map(m => m.id)).toEqual(['msg_02', 'msg_03', 'msg_04', 'msg_05'])
    expect(r.from_spool).toBe(2)
    expect(r.next_cursor).toBe('msg_05')
    const cut = mergeInboxPage(page, spooled, { limit: 2 })
    expect(cut.messages.map(m => m.id)).toEqual(['msg_01', 'msg_02'])
    expect(cut.next_cursor).toBe('msg_02')
  })

  it('keeps the relay cursor when it is ahead of everything shown', () => {
    const r = mergeInboxPage({ messages: [], next_cursor: 'msg_09' }, [env('msg_01')], { since: 'msg_05' })
    expect(r.messages).toEqual([])
    expect(r.next_cursor).toBe('msg_09')
  })
})
