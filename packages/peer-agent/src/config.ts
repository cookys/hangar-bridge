import { readFileSync, existsSync, statSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { z } from 'zod'
import { NAMESPACE_REGEX, INTEREST_REGEX, HANDLE_REGEX } from '@hangar-bridge/shared'
import { readTokenFile } from './cli/token-file.ts'
import { defaultConfigPath, defaultAuditDir } from './paths.ts'

export const ConfigSchema = z.object({
  transport: z.enum(['sse', 'nats']).default('sse'),
  nats: z.object({
    url: z.string(),
    nkey_seed_path: z.string(),
    roster_path: z.string(),
    inbox_prefix: z.string().optional(),
  }).optional(),
  relay_url: z.string().url(),
  token_path: z.string(),
  final_mile: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('claude-channel') }).strict(),
    z.object({
      kind: z.literal('agent-call'),
      target: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
      bin: z.string().min(1).max(4096).refine(value => !/[\u0000-\u001F\u007F]/.test(value)).default('agent-call'),
    }).strict(),
  ]).default({ kind: 'claude-channel' }),
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
}).superRefine((value, ctx) => {
  if (value.transport === 'nats' && !value.nats) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['nats'],
      message: "nats block is required when transport is 'nats'",
    })
  }
  if (value.transport === 'nats' && value.permission_relay.routing === 'ask_team') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['permission_relay', 'routing'],
      message: "ask_team is unavailable on NATS; choose a direct peer routing policy",
    })
  }
  if (value.final_mile.kind === 'agent-call' && value.permission_relay.enabled) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['permission_relay', 'enabled'],
      message: 'permission relay is unavailable with Agent Call final-mile; peer authority cannot approve permissions',
    })
  }
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
  const configHasRemote = (gitDir: string): boolean => {
    let configDir = gitDir
    const commonDirPath = `${gitDir}/commondir`
    if (existsSync(commonDirPath)) {
      const common = readFileSync(commonDirPath, 'utf8').trim()
      configDir = isAbsolute(common) ? common : resolve(gitDir, common)
    }
    const config = `${configDir}/config`
    if (!existsSync(config)) return false
    const text = readFileSync(config, 'utf8')
    return /\[remote\s+"[^"]+"\][^\[]*\burl\s*=\s*\S+/s.test(text)
  }

  let dir = resolve(start)
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const gitDir = `${dir}/.git`
    if (existsSync(gitDir)) {
      if (statSync(gitDir).isDirectory()) return configHasRemote(gitDir)
      const pointer = readFileSync(gitDir, 'utf8').trim().match(/^gitdir:\s*(.+)$/i)?.[1]
      if (!pointer) return false
      const linkedGitDir = isAbsolute(pointer) ? pointer : resolve(dir, pointer)
      return configHasRemote(linkedGitDir)
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

/** Refuse group/world-readable long-lived credentials on POSIX hosts. */
export function assertSecretFilePrivate(secretPath: string, label = 'secret'): void {
  const stat = statSync(resolve(secretPath))
  if (!stat.isFile()) throw new Error(`${label} path is not a regular file: ${secretPath}`)
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new Error(
      `refusing to start: ${label} file "${secretPath}" must not be readable or writable by group/other ` +
      '(expected mode 0600)',
    )
  }
}
