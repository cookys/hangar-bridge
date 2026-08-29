import { join } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'

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
 * Disk-backed SSE resume cursor (P3). Lives beside dispatch-state.json under the
 * SAME config dir, so a project-scoped peer keeps its own cursor — two projects
 * on one box must never share a resume point.
 */
export function defaultCursorStatePath(): string {
  return join(configDir(), 'cursor-state.json')
}

/**
 * First-detected-deaf timestamp (P4'c). deaf-check runs at startup only, so
 * without this every restart would reset deaf_since and a receiver could never
 * tell "deaf for two months" from "deaf for five minutes" — the distinction that
 * decides whether this sender's claims about conversation history are worthless.
 */
export function defaultHealthStatePath(sessionScope: string): string {
  // Several Claude sessions can share one project config directory while having
  // different channel health. Hash the stable Claude session id so one healthy
  // sibling cannot clear another sibling's deaf_since marker, and do not expose
  // the upstream session identifier in a filename. Callers fall back to the
  // process instance id when the harness supplies no stable session id.
  const scope = createHash('sha256').update(sessionScope).digest('hex').slice(0, 24)
  return join(configDir(), `health-state-${scope}.json`)
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
