import { ulid } from 'ulid'
import { resolveRelayUrl } from './relay-url.ts'
import { readTokenFile } from './token-file.ts'
import { defaultSecretPath } from '../paths.ts'

export async function runSend(args: string[]): Promise<void> {
  const to = args[0]
  const content = args[1]
  if (!to || !content) {
    throw new Error('usage: hangar-bridge send <to> <content> [--relay <url>]')
  }
  const relayUrl = resolveRelayUrl(args)
  const token = readTokenFile(defaultSecretPath())
  const res = await fetch(new URL('/v1/messages', relayUrl), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'idempotency-key': ulid().toLowerCase(),
    },
    body: JSON.stringify({ to, kind: 'chat', content }),
  })
  const text = await res.text()
  if (res.status !== 201) throw new Error(`send failed: ${res.status} ${text}`)
  process.stdout.write(text + '\n')
}
