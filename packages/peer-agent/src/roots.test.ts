import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { detectWorkingContext } from './roots.ts'

/**
 * P2 §2.2 — worktree stays INSTANCE metadata. It is deliberately not part of
 * the durable handle (32-char cap, static roster, same-name derivation), so
 * the only place it may appear is the presence row of a live process.
 */
describe('detectWorkingContext — worktree metadata', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hb-roots-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('reports a worktree name when .git is a FILE (a linked worktree)', () => {
    writeFileSync(join(dir, '.git'), 'gitdir: /nonexistent/.git/worktrees/agent-1\n')
    expect(detectWorkingContext(dir).worktree).toBe(basename(dir))
  })

  it('reports no worktree in a normal checkout where .git is a directory', () => {
    mkdirSync(join(dir, '.git'))
    expect(detectWorkingContext(dir).worktree).toBeUndefined()
  })

  it('reports no worktree outside a git repo', () => {
    expect(detectWorkingContext(dir).worktree).toBeUndefined()
    expect(detectWorkingContext(dir).cwd).toBe(dir)
  })
})
