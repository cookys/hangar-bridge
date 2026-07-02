import { readFileSync, existsSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { z } from 'zod'
import { NAMESPACE_REGEX, INTEREST_REGEX, HANDLE_REGEX } from '@hangar-bridge/shared'
import { readTokenFile } from './cli/token-file.ts'
import { defaultConfigPath, defaultAuditDir } from './paths.ts'

export const ConfigSchema = z.object({
  relay_url: z.string().url(),
  token_path: z.string(),
  // This peer's own handle. Optional/back-compat: only used to exclude self when the
  // outbound-permission ApprovalRouter policy is `ask_specific_peer:<self>`. The relay
  // remains the authority on identity (`from` is server-stamped); this is a local hint.
  self: z.string().regex(HANDLE_REGEX).optional(),
  // Subject routing. `interest` (exact or trailing '>') is sent to the relay as the
  // narrowing filter (x-hangar-subjects header). `owned` is informational on the peer
  // side — the relay DB (human.subjects) is the authoritative ACL. Both default empty.
  subjects: z.object({
    owned: z.array(z.string().regex(NAMESPACE_REGEX)).default([]),
    interest: z.array(z.string().regex(INTEREST_REGEX)).default([]),
  }).default({ owned: [], interest: [] }),
  permission_relay: z.object({
    enabled: z.boolean().default(false),
    routing: z.enum(['never_relay','ask_thread_participants','ask_team'])
      .or(z.string().startsWith('ask_specific_peer:'))
      .default('never_relay')
  }).default({ enabled: false, routing: 'never_relay' }),
  presence: z.object({
    auto_publish_cwd: z.boolean().default(true),
    auto_publish_branch: z.boolean().default(true),
    auto_publish_repo: z.boolean().default(true)
  }).default({ auto_publish_cwd: true, auto_publish_branch: true, auto_publish_repo: true }),
  audit_log: z.string().default(() => defaultAuditDir())
})
export type HangarConfig = z.infer<typeof ConfigSchema>

export { defaultConfigPath } from './paths.ts'

export function loadConfig(path: string = defaultConfigPath()): HangarConfig {
  if (!existsSync(path)) throw new Error(`config file not found: ${path}`)
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  return ConfigSchema.parse(raw)
}

export function loadToken(path: string): string {
  if (!existsSync(path)) throw new Error(`token file not found: ${path}`)
  return readTokenFile(path)
}

/** Walk up from `start` looking for a .git dir. If found, inspect .git/config for any remote.url. */
export function isInsideGitRepoWithRemote(start: string): boolean {
  let dir = resolve(start)
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const gitDir = `${dir}/.git`
    if (existsSync(gitDir) && statSync(gitDir).isDirectory()) {
      const cfg = `${gitDir}/config`
      if (existsSync(cfg)) {
        const text = readFileSync(cfg, 'utf8')
        if (/\[remote\s+"[^"]+"\][^\[]*\burl\s*=\s*\S+/s.test(text)) return true
      }
      return false
    }
    const parent = dirname(dir)
    if (parent === dir) return false
    dir = parent
  }
}

export function assertTokenNotInRepo(tokenPath: string): void {
  const dir = dirname(resolve(tokenPath))
  if (isInsideGitRepoWithRemote(dir)) {
    throw new Error(
      `refusing to start: token file "${tokenPath}" is inside a git worktree with a remote. ` +
      `Move it out of the tree or remove the remote.`
    )
  }
}
