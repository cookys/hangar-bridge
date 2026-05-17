import { readFileSync, existsSync } from 'node:fs'
import { defaultConfigPath } from '../paths.ts'

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined
}

function readConfigRelayUrl(): string | undefined {
  const p = defaultConfigPath()
  if (!existsSync(p)) return undefined
  try {
    const cfg = JSON.parse(readFileSync(p, 'utf8')) as { relay_url?: unknown }
    return typeof cfg.relay_url === 'string' ? cfg.relay_url : undefined
  } catch {
    return undefined
  }
}

export function resolveRelayUrl(args: string[]): string {
  const url = argValue(args, '--relay') ?? process.env.HANGAR_RELAY ?? readConfigRelayUrl()
  if (!url) {
    throw new Error(
      'missing relay URL. Provide one of: --relay <url>, HANGAR_RELAY env var, ' +
      'or write { "relay_url": "..." } into ~/.config/hangar-bridge/config.json.'
    )
  }
  return url
}
