import { basename } from 'node:path'

/**
 * Names that a remote URL's last segment can carry without identifying the
 * project. A local bare repo is conventionally `<project>/origin.git` or
 * `<project>/.git`, so the last segment says "this is a git remote", not
 * "this is which project".
 *
 * This matters because the derived name is a routing key: every host that
 * happens to use a local bare remote would otherwise report the SAME project
 * name and collapse into one bogus group, so a message meant for one project
 * would silently cross into unrelated ones. Observed live on 2026-08-31:
 * `~/projects/fighter/qwen3.8-27b` with remote `~/projects/fighter/origin.git`
 * reported `repo: "origin"`.
 */
const UNINFORMATIVE_REMOTE_NAMES = new Set(['origin', 'git', 'repo', 'repos', 'bare', 'mirror', ''])

export interface RepoNameInput {
  /** `git config --get remote.origin.url`, if any. */
  remoteUrl?: string | undefined
  /** `git rev-parse --show-toplevel`, if this is a work tree. */
  toplevel?: string | undefined
  /** Always required: the last resort when there is no git at all. */
  cwd: string
}

/**
 * One derivation, shared by every sender and by presence, because a project
 * name only works as an address if both ends compute the same string.
 *
 * Order: a meaningful remote segment, else the work tree's own directory name,
 * else the cwd's. The remote comes first so that the same project checked out
 * at different paths on different hosts still agrees; the work tree comes
 * second because it is what a person would call the project when the remote
 * cannot say.
 */
export function deriveRepoName(input: RepoNameInput): string {
  const fromRemote = lastSegment(input.remoteUrl)
  if (fromRemote && !UNINFORMATIVE_REMOTE_NAMES.has(fromRemote.toLowerCase())) return fromRemote
  if (input.toplevel) {
    const fromToplevel = basename(input.toplevel)
    if (fromToplevel) return fromToplevel
  }
  return basename(input.cwd)
}

function lastSegment(remote: string | undefined): string {
  if (!remote) return ''
  // Strip a trailing .git, then split on both path and scp-style separators
  // (`git@host:owner/name.git`), and ignore trailing slashes.
  const trimmed = remote.replace(/\.git$/i, '').replace(/[/\\]+$/, '')
  const parts = trimmed.split(/[:/\\]/).filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1]! : ''
}
