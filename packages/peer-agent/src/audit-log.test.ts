import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNatsAuditWriter } from './audit-log.ts'

describe('createNatsAuditWriter', () => {
  it('appends a mode-0600 JSONL denial record in a mode-0700 directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'hb-audit-'))
    const directory = join(root, 'audit')
    try {
      const write = createNatsAuditWriter(directory)
      write({
        at: '2026-07-21T00:00:00.000Z',
        sender: 'bob',
        subject: 'proj.command',
        reason: 'forbidden_subject',
        envelope_id: 'msg_01HRK7Y000000000000000000A',
        kind: 'task_dispatch',
        disposition: 'term',
      })
      const path = join(directory, 'nats-denials.jsonl')
      expect(JSON.parse(readFileSync(path, 'utf8').trim())).toMatchObject({ sender: 'bob', disposition: 'term' })
      expect(statSync(directory).mode & 0o777).toBe(0o700)
      expect(statSync(path).mode & 0o777).toBe(0o600)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
