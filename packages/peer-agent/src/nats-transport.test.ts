import { describe, it, expect, vi } from 'vitest'
import { TEAM_BROADCAST_HANDLE, type Envelope } from '@hangar-bridge/shared'
import type { NatsConnection } from '@nats-io/transport-node'
import { NatsTransport } from './nats-transport.ts'

interface PublishCall {
  subject: string
  data: Uint8Array
}

interface NatsMessage {
  subject: string
  data: Uint8Array
}

interface StatusEvent {
  type: 'update' | 'disconnect' | 'reconnect' | 'ldm' | 'error'
  error?: Error
}

class ControlledStatus {
  private queue: StatusEvent[] = []
  private resolvers: Array<(result: IteratorResult<StatusEvent>) => void> = []
  private closed = false

  push(status: StatusEvent): void {
    if (this.closed) return
    const resolve = this.resolvers.shift()
    if (resolve) resolve({ value: status, done: false })
    else this.queue.push(status)
  }

  [Symbol.asyncIterator](): AsyncIterator<StatusEvent> {
    return {
      next: async () => {
        if (this.closed && this.queue.length === 0) return { value: undefined as never, done: true }
        if (this.queue.length > 0) {
          return { value: this.queue.shift()!, done: false }
        }
        return await new Promise<IteratorResult<StatusEvent>>(resolve => {
          this.resolvers.push(resolve)
        })
      },
      return: async () => {
        this.closed = true
        return { value: undefined as never, done: true }
      },
    }
  }
}

class MessagePump {
  private queue: NatsMessage[] = []
  private resolvers: Array<(result: IteratorResult<NatsMessage>) => void> = []
  private closed = false

  constructor() {}

  push(msg: NatsMessage): void {
    if (this.closed) return
    const resolve = this.resolvers.shift()
    if (resolve) resolve({ value: msg, done: false })
    else this.queue.push(msg)
  }

  close(): void {
    this.closed = true
    while (this.resolvers.length > 0) {
      const resolve = this.resolvers.shift()!
      resolve({ value: undefined as never, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<NatsMessage> {
    return {
      next: async () => {
        if (this.closed && this.queue.length === 0) return { value: undefined as never, done: true }
        if (this.queue.length > 0) {
          return { value: this.queue.shift()!, done: false }
        }
        return await new Promise<IteratorResult<NatsMessage>>(resolve => {
          this.resolvers.push(resolve)
        })
      },
      return: async () => {
        this.close()
        return { value: undefined as never, done: true }
      },
    }
  }

  unsubscribe(): void {
    this.close()
  }
}

class FakeNatsConnection {
  readonly published: PublishCall[] = []
  readonly subscriptions = new Map<string, MessagePump>()
  readonly statusSource = new ControlledStatus()

  subscribe(subject: string): MessagePump {
    const sub = new MessagePump()
    this.subscriptions.set(subject, sub)
    return sub
  }

  publish(subject: string, data: Uint8Array = new Uint8Array()): void {
    this.published.push({ subject, data })
  }

  status(): AsyncIterable<StatusEvent> {
    return this.statusSource
  }

  async drain(): Promise<void> {
  }

  getSubscription(subject: string): MessagePump | undefined {
    return this.subscriptions.get(subject)
  }
}

function mkRoster() {
  return {
    alice: { owned: ['proj'], interest: ['proj.>'] },
    bob: { owned: ['proj'], interest: [] },
  }
}

async function waitTick(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

const encoder = new TextEncoder()

function mkEnvelope(overrides: Partial<Envelope>): Envelope {
  return {
    id: 'msg_01HRK7Y000000000000000000A',
    v: 2,
    team: 'hangar',
    from: 'remote',
    to: 'alice',
    subject: null,
    in_reply_to: null,
    thread_root: null,
    kind: 'chat',
    content: 'hello',
    meta: {},
    sent_at: '2026-01-01T00:00:00.000Z',
    delivered_at: null,
    ...overrides,
  }
}

async function startTransport(natsConn: FakeNatsConnection): Promise<{ transport: NatsTransport; conn: FakeNatsConnection }> {
  const transport = new NatsTransport({
    selfHandle: 'alice',
    natsUrl: 'nats://127.0.0.1:4222',
    nkeySeed: 'seed-A',
    roster: mkRoster(),
    onEnvelope: vi.fn(),
    onAuthError: vi.fn(),
    connector: async () => natsConn as unknown as NatsConnection,
  })
  await transport.start()
  return { transport, conn: natsConn }
}

describe('NatsTransport', () => {
  it('builds wire subjects from outbound envelopes and enforces publish ACLs', async () => {
    const conn = new FakeNatsConnection()
    const { transport } = await startTransport(conn)

    const env = await transport.send({ to: 'bob', kind: 'chat', content: 'hello', subject: null })
    expect(conn.published).toHaveLength(1)
    expect(conn.published[0]!.subject).toBe('fleet.alice.to.bob.chat')
    const parsed = JSON.parse(new TextDecoder().decode(conn.published[0]!.data)) as Envelope
    expect(parsed.from).toBe('alice')
    expect(parsed.kind).toBe('chat')
    expect(env.to).toBe('bob')

    await expect(
      transport.send({ to: TEAM_BROADCAST_HANDLE, kind: 'task_dispatch', content: 'x' }),
    ).rejects.toThrow('publish to @team requires kind chat|presence_update')

    await expect(
      transport.send({ to: 'bob', kind: 'chat', subject: 'other.task', content: 'x' }),
    ).rejects.toThrow('publish denied: forbidden_subject')

    const teamEnv = await transport.send({ to: TEAM_BROADCAST_HANDLE, kind: 'presence_update', content: 'all-here' })
    expect(teamEnv.to).toBe(TEAM_BROADCAST_HANDLE)
    expect(conn.published.at(-1)?.subject).toBe('fleet.alice.to.team.presence_update')
  })

  it('drops own @team broadcasts on inbound fanout', async () => {
    const onEnvelope = vi.fn<(e: Envelope) => void>()
    const conn = new FakeNatsConnection()
    const transport = new NatsTransport({
      selfHandle: 'alice',
      natsUrl: 'nats://127.0.0.1:4222',
      nkeySeed: 'seed-A',
      roster: mkRoster(),
      onEnvelope,
      onAuthError: vi.fn(),
      connector: async () => conn as unknown as NatsConnection,
    })
    await transport.start()

    const teamSub = conn.getSubscription('fleet.*.to.team.>')
    expect(teamSub).toBeDefined()
    teamSub!.push({
      subject: 'fleet.alice.to.team.chat',
      data: encoder.encode(JSON.stringify(mkEnvelope({ kind: 'chat', to: TEAM_BROADCAST_HANDLE }))),
    })
    await waitTick()
    expect(onEnvelope).not.toHaveBeenCalled()
  })

  it('rejects inbound with non-self/team recipient, kind mismatch, and derives sender from wire', async () => {
    const onEnvelope = vi.fn<(e: Envelope) => void>()
    const conn = new FakeNatsConnection()
    const transport = new NatsTransport({
      selfHandle: 'alice',
      natsUrl: 'nats://127.0.0.1:4222',
      nkeySeed: 'seed-A',
      roster: mkRoster(),
      onEnvelope,
      onAuthError: vi.fn(),
      connector: async () => conn as unknown as NatsConnection,
    })
    await transport.start()

    const selfSub = conn.getSubscription('fleet.*.to.alice.>')
    const directSub = conn.getSubscription('fleet.*.to.team.>')
    expect(selfSub).toBeDefined()

    selfSub!.push({
      subject: 'fleet.bob.to.charlie.chat',
      data: encoder.encode(JSON.stringify(mkEnvelope({ kind: 'chat', to: 'charlie' }))),
    })
    await waitTick()

    selfSub!.push({
      subject: 'fleet.bob.to.alice.chat',
      data: encoder.encode(JSON.stringify(mkEnvelope({ kind: 'presence_update', to: 'alice' }))),
    })
    await waitTick()

    selfSub!.push({
      subject: 'fleet.mal.to.alice.chat',
      data: encoder.encode(JSON.stringify(mkEnvelope({ kind: 'chat', from: 'spoofed', to: 'alice' }))),
    })
    await waitTick()

    expect(onEnvelope).toHaveBeenCalledTimes(1)
    expect(onEnvelope).toHaveBeenCalledWith(expect.objectContaining({
      from: 'mal',
      to: 'alice',
      kind: 'chat',
    }))

    directSub?.push({
      subject: 'fleet.alice.to.team.chat',
      data: encoder.encode(JSON.stringify(mkEnvelope({ kind: 'chat', to: TEAM_BROADCAST_HANDLE }))),
    })
    await waitTick()
    expect(onEnvelope).toHaveBeenCalledTimes(1)
  })

  it('rejects malformed subjects and kind mismatches before envelope handling', async () => {
    const onEnvelope = vi.fn<(e: Envelope) => void>()
    const conn = new FakeNatsConnection()
    const transport = new NatsTransport({
      selfHandle: 'alice',
      natsUrl: 'nats://127.0.0.1:4222',
      nkeySeed: 'seed-A',
      roster: mkRoster(),
      onEnvelope,
      onAuthError: vi.fn(),
      connector: async () => conn as unknown as NatsConnection,
    })
    await transport.start()

    const selfSub = conn.getSubscription('fleet.*.to.alice.>')
    expect(selfSub).toBeDefined()
    selfSub!.push({
      subject: 'fleet..to.alice.chat',
      data: encoder.encode(JSON.stringify(mkEnvelope({ kind: 'chat' }))),
    })
    selfSub!.push({
      subject: 'fleet.bob.to.alice.chat.extra',
      data: encoder.encode(JSON.stringify(mkEnvelope({ kind: 'chat' }))),
    })
    selfSub!.push({
      subject: 'fleet.bob.to.alice.permission_request',
      data: encoder.encode(JSON.stringify(mkEnvelope({ kind: 'chat', to: 'alice', from: 'spoofed' }))),
    })
    await waitTick()

    expect(onEnvelope).not.toHaveBeenCalled()
  })

  it('AC4 outbox overflow surfaces error callback', async () => {
    const onOverflow = vi.fn()
    const transport = new NatsTransport({
      selfHandle: 'alice',
      natsUrl: 'nats://127.0.0.1:4222',
      nkeySeed: 'seed-A',
      outboxCap: 2,
      roster: mkRoster(),
      onOverflow,
      onEnvelope: vi.fn(),
      onAuthError: vi.fn(),
    })
    await transport.send({ to: 'bob', kind: 'chat', content: 'a' })
    await transport.send({ to: 'bob', kind: 'chat', content: 'b' })
    await transport.send({ to: 'bob', kind: 'chat', content: 'c' })
    expect(transport.outboxDepth).toBe(2)
    expect(onOverflow).toHaveBeenCalledWith(1)
  })
})
