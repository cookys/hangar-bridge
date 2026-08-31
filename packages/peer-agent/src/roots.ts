import { execSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { deriveRepoName } from '@hangar-bridge/shared'

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
    // Ask git where the work tree starts rather than looking for .git in cwd:
    // a session started in a subdirectory is still in the same project, and
    // checking only cwd made it report the SUBDIRECTORY as its project name.
    // Harmless while this was a display label; fatal once it is the address —
    // two sessions in one repo would each name a different project and never
    // reach each other.
    let toplevel = ''
    try {
      toplevel = execSync('git rev-parse --show-toplevel', { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    } catch { /* not a work tree */ }
    // A linked worktree marks itself with a .git FILE rather than a directory.
    // Detect it from cwd too, so a checkout git cannot resolve (a stale gitdir
    // pointer) is still reported as a worktree rather than as nothing at all.
    if (!toplevel) {
      try {
        if (existsSync(join(cwd, '.git')) && statSync(join(cwd, '.git')).isFile()) {
          ctx.worktree = basename(cwd)
        }
      } catch { /* best-effort */ }
    }
    if (toplevel) {
      // In a LINKED worktree `.git` is a file ("gitdir: ..."), not a directory.
      // That is the cheap, git-free discriminator; the name is the directory.
      try {
        if (statSync(join(toplevel, '.git')).isFile()) ctx.worktree = basename(toplevel)
      } catch { /* best-effort */ }
      ctx.branch = execSync('git -C . rev-parse --abbrev-ref HEAD', { cwd, encoding: 'utf8' }).trim()
      // The remote alone is not enough: a local bare remote (`<project>/origin.git`)
      // makes every such host report the same name, so unrelated projects collapse
      // into one routing group. deriveRepoName is shared so a sender and the
      // presence record it is matched against compute the identical string.
      let remote = ''
      try {
        remote = execSync('git -C . config --get remote.origin.url', { cwd, encoding: 'utf8' }).trim()
      } catch { /* no remote configured — toplevel still names the project */ }
      ctx.repo = deriveRepoName({ remoteUrl: remote, toplevel, cwd })
    } else {
      ctx.repo = basename(cwd)
    }
  } catch {
    // git not available or not a repo — best-effort only
  }
  return ctx
}
