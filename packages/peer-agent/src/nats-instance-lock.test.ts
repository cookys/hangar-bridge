import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileNatsInstanceGuard } from './nats-instance-lock.ts'

describe('FileNatsInstanceGuard', () => {
  it('allows only one live same-handle process owner and releases cleanly', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-instance-'))
    const path = join(dir, 'alice.lock')
    try {
      const first = new FileNatsInstanceGuard('alice', path)
      const second = new FileNatsInstanceGuard('alice', path)
      first.acquire()
      expect(() => second.acquire()).toThrow(/already running/)
      first.release()
      expect(() => second.acquire()).not.toThrow()
      second.release()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fails closed on a malformed lock instead of deleting an unknown path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-instance-bad-'))
    const path = join(dir, 'alice.lock')
    try {
      mkdirSync(path)
      writeFileSync(join(path, 'owner.json'), '{broken')
      const guard = new FileNatsInstanceGuard('alice', path)
      expect(() => guard.acquire()).toThrow(/malformed/)
      expect(readFileSync(join(path, 'owner.json'), 'utf8')).toBe('{broken')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
