import { mkdirSync, writeFileSync, chmodSync, existsSync } from 'node:fs'
import { randomBytes, createHash } from 'node:crypto'
import { configDir, defaultConfigPath, defaultSecretPath, defaultAuditDir } from '../paths.ts'

export interface InitOpts {
  relayUrl: string
  handle: string
  force?: boolean
  rand?: () => Buffer
  out?: (s: string) => void
}

/**
 * Bootstraps the local peer config + secret in one shot. After this runs:
 *   - `~/.config/hangar-bridge/secret`     (0600, raw 43-char URL-safe base64)
 *   - `~/.config/hangar-bridge/config.json` (relay_url, token_path, presence)
 *   - `~/.config/hangar-bridge/audit/`     (empty dir for audit logs)
 *
 * Prints the SHA-256 hex of the new secret so the operator can paste it into
 * the relay's peers.json under this handle.
 */
export function runInit(opts: InitOpts): { handle: string; secret_sha256_hex: string } {
  const out = opts.out ?? ((s: string) => process.stdout.write(s + '\n'))
  const rand = opts.rand ?? (() => randomBytes(32))
  const dir = configDir()
  mkdirSync(dir, { recursive: true })
  mkdirSync(defaultAuditDir(), { recursive: true })

  const secretPath = defaultSecretPath()
  if (existsSync(secretPath) && !opts.force) {
    throw new Error(
      `secret already exists at ${secretPath}. Re-run with --force to rotate.`
    )
  }
  const raw = rand().toString('base64url')
  writeFileSync(secretPath, raw, { mode: 0o600 })
  try { chmodSync(secretPath, 0o600) } catch { /* Windows */ }

  const cfgPath = defaultConfigPath()
  const cfg = {
    relay_url: opts.relayUrl,
    token_path: secretPath,
    permission_relay: { enabled: false, routing: 'never_relay' },
    presence: { auto_publish_cwd: true, auto_publish_branch: true, auto_publish_repo: true },
    audit_log: defaultAuditDir(),
  }
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))

  const sha = createHash('sha256').update(raw, 'utf8').digest('hex')
  out(`OK secret written to ${secretPath} (chmod 600, ${raw.length} chars)`)
  out(`OK config written to ${cfgPath}`)
  out(``)
  out(`>> add this entry to the relay's peers.json (mode 0600) and restart hangar-bridge-relay:`)
  out(`   "${opts.handle}": { "secret_sha256_hex": "${sha}" }`)
  return { handle: opts.handle, secret_sha256_hex: sha }
}
