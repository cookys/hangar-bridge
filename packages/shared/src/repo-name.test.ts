import { describe, it, expect } from 'vitest'
import { deriveRepoName } from './repo-name.ts'

describe('deriveRepoName', () => {
  it('uses the remote segment when it identifies the project', () => {
    expect(deriveRepoName({
      remoteUrl: 'git@github.com:cookys/revival.3d.git',
      toplevel: '/home/u/projects/revival.3d', cwd: '/home/u/projects/revival.3d',
    })).toBe('revival.3d')
  })

  it('falls back to the work tree when the remote is a local bare repo', () => {
    // The live failure: several unrelated projects all reported "origin" and
    // collapsed into one routing group.
    expect(deriveRepoName({
      remoteUrl: '/home/u/projects/fighter/origin.git',
      toplevel: '/home/u/projects/fighter/qwen3.8-27b',
      cwd: '/home/u/projects/fighter/qwen3.8-27b',
    })).toBe('qwen3.8-27b')
  })

  it('agrees across hosts that check the same project out at different paths', () => {
    const a = deriveRepoName({ remoteUrl: 'git@github.com:cookys/hangar.git', toplevel: '/home/a/projects/hangar', cwd: '/home/a/projects/hangar' })
    const b = deriveRepoName({ remoteUrl: 'https://github.com/cookys/hangar.git', toplevel: '/srv/work/hangar-clone', cwd: '/srv/work/hangar-clone/sub' })
    expect(a).toBe('hangar')
    expect(b).toBe('hangar')
  })

  it('handles scp-style, https, trailing slash, and no .git suffix', () => {
    const cwd = '/tmp/x'
    expect(deriveRepoName({ remoteUrl: 'git@github.com:owner/name.git', cwd })).toBe('name')
    expect(deriveRepoName({ remoteUrl: 'https://host/owner/name', cwd })).toBe('name')
    expect(deriveRepoName({ remoteUrl: 'https://host/owner/name/', cwd })).toBe('name')
    expect(deriveRepoName({ remoteUrl: 'ssh://git@host:22/owner/name.git', cwd })).toBe('name')
  })

  it('treats every uninformative remote name the same way', () => {
    for (const bare of ['origin', 'ORIGIN', 'git', 'repo', 'bare', 'mirror']) {
      expect(deriveRepoName({
        remoteUrl: `/home/u/projects/proj/${bare}.git`,
        toplevel: '/home/u/projects/proj/work', cwd: '/home/u/projects/proj/work',
      })).toBe('work')
    }
  })

  it('falls back to cwd when there is no git at all', () => {
    expect(deriveRepoName({ cwd: '/home/u/notes' })).toBe('notes')
  })

  it('never returns the empty string for a usable cwd', () => {
    expect(deriveRepoName({ remoteUrl: '', toplevel: '', cwd: '/home/u/x' })).toBe('x')
  })
})
