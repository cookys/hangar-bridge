import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Envelope } from '@hangar-bridge/shared'
import { deliverViaAgentCall } from './agent-call-ingress.ts'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function envelope(overrides: Partial<Envelope> = {}): Envelope {
  return {
    id: 'msg_01KWH8XGC78TM94AB8DRVW9NWX',
    v: 1,
    team: 'hangar',
    from: 'remote-peer',
    to: 'local-peer',
    subject: null,
    in_reply_to: null,
    thread_root: null,
    kind: 'task_dispatch',
    content: 'inspect commit 920ce87',
    meta: { correlation_id: '01KWH8XGB9W51SBCJST9NTJNB9', task_kind: 'review' },
    sent_at: '2026-08-28T00:00:00.000Z',
    delivered_at: null,
    ...overrides,
  }
}

function fakeAgentCall(body: string, exitCode = 0): { bin: string; input: string; args: string } {
  const dir = mkdtempSync(join(tmpdir(), 'hangar-agent-call-'))
  dirs.push(dir)
  const input = join(dir, 'input.json')
  const args = join(dir, 'args.txt')
  const bin = join(dir, 'agent-call')
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$*" > "${args}"\ncat > "${input}"\nprintf '%s\\n' '${body}'\nexit ${exitCode}\n`)
  chmodSync(bin, 0o700)
  return { bin, input, args }
}

describe('Agent Call final-mile ingress', () => {
  it('hands a transport-origin peer envelope to agent-call receive without raising its authority', async () => {
    const fake = fakeAgentCall('{"status":"injected_unverified"}')

    await deliverViaAgentCall(envelope({
      meta: {
        correlation_id: '01KWH8XGB9W51SBCJST9NTJNB9',
        task_kind: 'review',
        instance: '01HRK7Y0000000000000000000',
        peer_session_claim: 'session-display-only',
        attribution_status: 'stamped',
        sender_health: 'deaf',
        deaf_since: '2026-08-01T00:00:00.000Z',
      },
    }), { target: 'local-codex', bin: fake.bin })

    const delivered = JSON.parse(readFileSync(fake.input, 'utf8'))
    expect(readFileSync(fake.args, 'utf8').trim()).toBe('receive --stdin --json')
    expect(delivered).toMatchObject({
      schema: 'agent-call.message.v1',
      from: 'remote-peer',
      to: 'local-codex',
      authority: 'peer',
      origin: 'transport',
      reply: 'none',
    })
    expect(delivered.id).toMatch(/^ac_[0-9a-f-]{36}$/)
    expect(delivered.content).toContain('"source":"hangar-bridge"')
    expect(delivered.content).toContain('"remote_msg_id":"msg_01KWH8XGC78TM94AB8DRVW9NWX"')
    expect(delivered.content).toContain('"kind":"task_dispatch"')
    expect(delivered.content).toContain('"instance":"01HRK7Y0000000000000000000"')
    expect(delivered.content).toContain('"peer_session_claim":"session-display-only"')
    expect(delivered.content).toContain('"attribution_status":"stamped"')
    expect(delivered.content).toContain('"sender_health":"deaf"')
    expect(delivered.content).toContain('"deaf_since":"2026-08-01T00:00:00.000Z"')
    expect(delivered.content).toContain('inspect commit 920ce87')
  })

  it('propagates an offline/refused final-mile failure and does not claim delivery', async () => {
    const fake = fakeAgentCall('target offline', 7)

    await expect(deliverViaAgentCall(envelope(), { target: 'missing-target', bin: fake.bin }))
      .rejects.toThrow(/agent-call final-mile failed.*target offline/i)
  })

  it('rejects a successful process with a receipt above Agent Call transport ceilings', async () => {
    const fake = fakeAgentCall('{"status":"delivered"}')

    await expect(deliverViaAgentCall(envelope(), { target: 'local-codex', bin: fake.bin }))
      .rejects.toThrow(/unexpected receipt status: delivered/i)
  })

  it('fails explicitly when the Agent Call binary is unavailable', async () => {
    await expect(deliverViaAgentCall(envelope(), {
      target: 'local-codex',
      bin: join(tmpdir(), `missing-agent-call-${Date.now()}`),
    })).rejects.toThrow(/agent-call final-mile failed/i)
  })
})
