import { execSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'

export interface WorkingContext {
  cwd?: string
  branch?: string
  repo?: string
  /**
   * Name of the linked git worktree this session runs in, when it runs in one.
   * INSTANCE metadata only — a worktree is deliberately never part of the
   * durable handle (plan §2.2: 32-char handle cap, static roster requiring a
   * relay restart per handle, and same-repo worktrees derive the same name).
   */
  worktree?: string
}

export function detectWorkingContext(cwd: string = process.cwd()): WorkingContext {
  const ctx: WorkingContext = { cwd }
  try {
    if (existsSync(join(cwd, '.git'))) {
      // In a LINKED worktree `.git` is a file ("gitdir: ..."), not a directory.
      // That is the cheap, git-free discriminator; the name is the directory.
      try {
        if (statSync(join(cwd, '.git')).isFile()) ctx.worktree = basename(cwd)
      } catch { /* best-effort */ }
      ctx.branch = execSync('git -C . rev-parse --abbrev-ref HEAD', { cwd, encoding: 'utf8' }).trim()
      const remote = execSync('git -C . config --get remote.origin.url', { cwd, encoding: 'utf8' }).trim()
      ctx.repo = remote.replace(/\.git$/, '').split(/[:/]/).slice(-1)[0] || basename(cwd)
    } else {
      ctx.repo = basename(cwd)
    }
  } catch {
    // git not available or not a repo — best-effort only
  }
  return ctx
}
