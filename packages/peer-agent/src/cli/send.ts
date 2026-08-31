import { ulid } from 'ulid'
import { resolveRelayUrl } from './relay-url.ts'
import { readTokenFile } from './token-file.ts'
import { defaultSecretPath } from '../paths.ts'

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined
}

export async function runSend(args: string[]): Promise<void> {
  const to = args[0]
  const content = args[1]
  if (!to || !content || to.startsWith('--')) {
    throw new Error(
      'usage: hangar-bridge send <to> <content> [--relay <url>] [--instance <id>] [--repo <name>]',
    )
  }
  const relayUrl = resolveRelayUrl(args)
  const token = readTokenFile(defaultSecretPath())

  // Optional presence-backed narrowing (v1: instance | repo). Delivered ONLY to
  // matching live sessions; the response's `matched` count says how many.
  const instance = flagValue(args, '--instance')
  const repo = flagValue(args, '--repo')
  const to_filter: Record<string, string> = {}
  if (instance) to_filter.instance = instance
  if (repo) to_filter.repo = repo

  const body: Record<string, unknown> = { to, kind: 'chat', content }
  if (Object.keys(to_filter).length > 0) body.to_filter = to_filter

  const res = await fetch(new URL('/v1/messages', relayUrl), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'idempotency-key': ulid().toLowerCase(),
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
