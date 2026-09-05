import { readFileSync, existsSync } from 'node:fs'
import { ulid } from 'ulid'
import { RESERVED_CLI_INSTANCE, newInstanceId, isValidInstanceId } from '@hangar-bridge/shared'
import { resolveRelayUrl } from './relay-url.ts'
import { readTokenFile } from './token-file.ts'
import { defaultSecretPath, defaultConfigPath } from '../paths.ts'
import { findPaneRegistration as findPaneRegistrationDefault } from '../switchboard.ts'

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined
}

/**
 * Tolerant raw read of config.json's persisted `instance` (§8.1) — mirrors
 * relay-url.ts's readConfigRelayUrl: a missing/unparseable/older config file
 * (no `instance` key) is "absent", not an error, since this CLI must keep
 * working against a config that predates the field.
 *
 * Repair round item 5b: also validated against the same ULID grammar
 * saveConfig() enforces on write. The file on disk can drift from what
 * saveConfig last wrote (a hand edit, an older schema, partial corruption
 * from a stray process) — accepting an unvalidated string here would send
 * a malformed x-hangar-instance and 400 the whole send at the relay
 * chokepoint. Treated as absent instead, exactly like a missing key.
 */
function readConfigInstance(): string | undefined {
  const p = defaultConfigPath()
  if (!existsSync(p)) return undefined
  try {
    const cfg = JSON.parse(readFileSync(p, 'utf8')) as { instance?: unknown }
    return typeof cfg.instance === 'string' && isValidInstanceId(cfg.instance) ? cfg.instance : undefined
  } catch {
    return undefined
  }
}

export interface SendDeps {
  fetchImpl?: typeof fetch
  /** Persisted courier instance id from config.json, or undefined if absent. */
  readInstance?: () => string | undefined
  /** §8.1: the same registry read the switchboard/reply_to_peer use. */
  findPaneRegistration?: (pane: string) => Promise<{ name: string; generation?: string } | undefined>
  /** Fallback identity when inside a pane with no persisted courier instance yet. */
  mintInstanceId?: () => string
}

/**
 * §8.1: always send BOTH identity headers.
 *
 * `x-hangar-instance` — inside a pane ($TMUX_PANE set), the persisted
 * courier instance if config.json has one; a pane with no courier running
 * yet has no persisted identity to report, so mint one for this one call
 * rather than claiming the outside-a-pane identity (~cli) while actually
 * inside a pane. Outside any pane, the literal ~cli (§8.2).
 *
 * `x-hangar-return-selector` — `<name>@<generation>` when the local
 * registry has a registration for THIS pane; the literal ~none otherwise
 * (no pane, or a pane the registry doesn't know yet) — always sent, never
 * omitted, so the relay always has an explicit answer to store on the route.
 */
async function resolveIdentityHeaders(deps: SendDeps): Promise<{ instance: string; returnSelector: string }> {
  const pane = process.env.TMUX_PANE
  if (!pane) return { instance: RESERVED_CLI_INSTANCE, returnSelector: '~none' }

  const readInstance = deps.readInstance ?? readConfigInstance
  const mint = deps.mintInstanceId ?? newInstanceId
  const instance = readInstance() ?? mint()

  const findReg = deps.findPaneRegistration ?? findPaneRegistrationDefault
  const reg = await findReg(pane)
  const returnSelector = reg?.generation ? `${reg.name}@${reg.generation}` : '~none'
  return { instance, returnSelector }
}

export async function runSend(args: string[], deps: SendDeps = {}): Promise<void> {
  const to = args[0]
  const content = args[1]
  if (!to || !content || to.startsWith('--')) {
    throw new Error(
      'usage: hangar-bridge send <to> <content> [--relay <url>] [--instance <id>] [--repo <name>]',
    )
  }
  const relayUrl = resolveRelayUrl(args)
  const token = readTokenFile(defaultSecretPath())
  const fetchImpl = deps.fetchImpl ?? fetch

  // Optional presence-backed narrowing (v1: instance | repo). Delivered ONLY to
  // matching live sessions; the response's `matched` count says how many.
  const instance = flagValue(args, '--instance')
  const repo = flagValue(args, '--repo')
  const to_filter: Record<string, string> = {}
  if (instance) to_filter.instance = instance
  if (repo) to_filter.repo = repo

  const body: Record<string, unknown> = { to, kind: 'chat', content }
  if (Object.keys(to_filter).length > 0) body.to_filter = to_filter

  const identity = await resolveIdentityHeaders(deps)

  const res = await fetchImpl(new URL('/v1/messages', relayUrl), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'idempotency-key': ulid().toLowerCase(),
      'x-hangar-instance': identity.instance,
      'x-hangar-return-selector': identity.returnSelector,
    },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  if (res.status !== 201) throw new Error(`send failed: ${res.status} ${text}`)
  process.stdout.write(text + '\n')
  // Surface a directed send that reached nobody so a script/agent can react.
  if (Object.keys(to_filter).length > 0) {
    try {
      const parsed = JSON.parse(text) as { matched?: number }
      if (parsed.matched === 0) {
        process.stderr.write('warning: to_filter matched 0 live sessions; nothing was delivered\n')
      }
    } catch { /* non-JSON body: leave the raw output as the signal */ }
  }
}
