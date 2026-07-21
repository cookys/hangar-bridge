import { join } from 'node:path'
import { homedir } from 'node:os'

/**
 * Where hangar-bridge stores per-peer config + secret on the local box.
 *
 * Standard XDG path resolution: `$XDG_CONFIG_HOME/hangar-bridge` if set, else
 * `~/.config/hangar-bridge`. Override via `HANGAR_CONFIG_DIR` for tests or
 * non-standard deployments. All three of `config.json`, `secret`, and
 * `audit/` live under this directory.
 */
export function configDir(): string {
  if (process.env.HANGAR_CONFIG_DIR) return process.env.HANGAR_CONFIG_DIR
  if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, 'hangar-bridge')
  return join(homedir(), '.config', 'hangar-bridge')
}

export function defaultConfigPath(): string {
  return join(configDir(), 'config.json')
}

export function defaultSecretPath(): string {
  return join(configDir(), 'secret')
}

export function defaultAuditDir(): string {
  return join(configDir(), 'audit')
}

/**
 * Disk-backed store for the DispatchTracker's in-flight {correlation_id → dispatch}
 * correlations, so a peer-agent restart doesn't orphan a late task_result.
 */
export function defaultDispatchStatePath(): string {
  return join(configDir(), 'dispatch-state.json')
}

/**
 * Host-global (not project-config-local) lock path for a NATS fleet handle.
 * Different Claude projects may set different HANGAR_CONFIG_DIR values, but a
 * handle-level durable consumer still permits only one local live process.
 */
export function defaultNatsInstanceLockPath(handle: string): string {
  const base = process.env.XDG_RUNTIME_DIR
    ? join(process.env.XDG_RUNTIME_DIR, 'hangar-bridge')
    : join(homedir(), '.cache', 'hangar-bridge', 'locks')
  return join(base, `nats-${handle}.lock`)
}
