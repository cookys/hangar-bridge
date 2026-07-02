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

interface JetStreamMessage {
  subject: string
  data: Uint8Array
  ack: () => Promise<void>
  nak: () => Promise<void>
  term: () => Promise<void>
}

interface StatusEvent {
  type: 'update' | 'disconnect' | 'reconnect' | 'ldm' | 'error'
  error?: Error
}

class AsyncPump<T extends Record<string, unknown>> {
  protected closed = false
  private queue: T[] = []
  private resolvers: Array<(result: IteratorResult<T>) => void> = []

  isClosed(): boolean {
    return this.closed
  }

  push(item: T): void {
    if (this.closed) return
    const resolve = this.resolvers.shift()
    if (resolve) resolve({ value: item, done: false })
    else this.queue.push(item)
  }

  close(): void {
    this.closed = true
    while (this.resolvers.length > 0) {
      const resolve = this.resolvers.shift()!
      resolve({ value: undefined as never, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        if (this.closed && this.queue.length === 0) return { value: undefined as never, done: true }
        if (this.queue.length > 0) return { value: this.queue.shift()!, done: false }

        return await new Promise<IteratorResult<T>>(resolve => {
          this.resolvers.push(resolve)
        })
      },
      return: async () => {
        this.close()
        return { value: undefined as never, done: true }
      },
    }
  }
}

class MessagePump extends AsyncPump<NatsMessage> {
  unsubscribe(): void {
    this.close()
  }
}

class FakeNatsConnection {
  readonly published: PublishCall[] = []
  readonly subscriptions = new Map<string, MessagePump>()
  readonly statusSource = new AsyncPump<StatusEvent>()

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

class FakeJetStreamMessagePump extends AsyncPump<JetStreamMessage> {
  pushMessage(overrides: Omit<JetStreamMessage, 'ack' | 'nak' | 'term'>): {
    message: JetStreamMessage
    ack: ReturnType<typeof vi.fn>
    nak: ReturnType<typeof vi.fn>
    term: ReturnType<typeof vi.fn>
  } {
    const ack = vi.fn(async () => {})
    const nak = vi.fn(async () => {})
    const term = vi.fn(async () => {})
    const message: JetStreamMessage = {
      ack,
      nak,
      term,
      ...overrides,
    }
    this.push(message)
    return { message, ack, nak, term }
  }

  close(): void {
    this.closed = true
    super.close()
  }
}

class FakeJetStreamConsumer {
  readonly messages = new FakeJetStreamMessagePump()

  async consume(): Promise<FakeJetStreamMessagePump> {
    return this.messages
  }
}

class FakeJetStreamClient {
  readonly consumers = new Map<string, FakeJetStreamConsumer>()
  readonly published: PublishCall[] = []

  publish(subject: string, data: Uint8Array = new Uint8Array()): Promise<void> {
    this.published.push({ subject, data })
    return Promise.resolve()
  }

  async getConsumer(handle: string): Promise<FakeJetStreamConsumer> {
    let consumer = this.consumers.get(handle)
    if (!consumer) {
      consumer = new FakeJetStreamConsumer()
      this.consumers.set(handle, consumer)
    }
    return consumer
  }

  consumersApi() {
    return {
      get: async (_stream: string, durable: string): Promise<FakeJetStreamConsumer> => {
        return this.getConsumer(durable)
      },
    }
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

async function waitMs(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
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

function mkTransport(
  natsConn: FakeNatsConnection,
  jsClient: FakeJetStreamClient,
  onEnvelope: (e: Envelope) => void,
  onAuthError = vi.fn(),
) {
  return new NatsTransport({
    selfHandle: 'alice',
    natsUrl: 'nats://127.0.0.1:4222',
    nkeySeed: 'seed-A',
    roster: mkRoster(),
    onEnvelope,
    onAuthError,
    connector: async () => natsConn as unknown as NatsConnection,
    jsFactory: () => ({
      publish: jsClient.publish.bind(jsClient),
      consumers: jsClient.consumersApi(),
    }) as any,
  })
}

describe('NatsTransport', () => {
  it('routes all six kinds to exactly one tier', async () => {
    const conn = new FakeNatsConnection()
    const js = new FakeJetStreamClient()
    const transport = mkTransport(conn, js, vi.fn())
    await transport.start()

    await transport.send({ to: 'bob', kind: 'chat', content: 'hello', subject: null })
    await transport.send({ to: 'bob', kind: 'presence_update', content: 'present', subject: null })
    await transport.send({ to: 'bob', kind: 'permission_request', content: 'ask', subject: null })
    await transport.send({ to: 'bob', kind: 'permission_verdict', content: 'ok', in_reply_to: 'msg_prev' })
    await transport.send({ to: 'bob', kind: 'task_dispatch', content: 'job' })
    await transport.send({ to: 'bob', kind: 'task_result', content: 'done', in_reply_to: 'task-prev' })

    expect(conn.published.map(call => call.subject)).toEqual([
      'fleet.alice.to.bob.chat',
      'fleet.alice.to.bob.presence_update',
      'fleet.alice.to.bob.permission_request',
      'fleet.alice.to.bob.permission_verdict',
    ])
    expect(js.published.map(call => call.subject)).toEqual([
      'fleet.alice.to.bob.task_dispatch',
      'fleet.alice.to.bob.task_result',
    ])

    await expect(
      transport.send({ to: TEAM_BROADCAST_HANDLE, kind: 'task_dispatch', content: 'x' }),
    ).rejects.toThrow('publish to @team requires kind chat|presence_update')
    await expect(
      transport.send({ to: TEAM_BROADCAST_HANDLE, kind: 'task_result', content: 'x' }),
    ).rejects.toThrow('publish to @team requires kind chat|presence_update')
    await expect(
      transport.send({ to: TEAM_BROADCAST_HANDLE, kind: 'permission_request', content: 'x' }),
    ).rejects.toThrow('publish to @team requires kind chat|presence_update')
    await expect(
      transport.send({ to: TEAM_BROADCAST_HANDLE, kind: 'permission_verdict', content: 'x', in_reply_to: 'r1' }),
    ).rejects.toThrow('publish to @team requires kind chat|presence_update')
  })

  it('retries JetStream consumer startup when stream/consumer is temporarily unavailable', async () => {
    const conn = new FakeNatsConnection()
    const consumer = new FakeJetStreamConsumer()
    const js = {
      published: [] as PublishCall[],
      consumers: {
        get: vi.fn(async () => {
          getAttempt += 1
          if (getAttempt === 1) {
            throw new Error('temporary unavailable')
          }
          return consumer
        }),
      },
      publish: vi.fn(async (subject: string, data: Uint8Array) => {
        js.published.push({ subject, data })
      }),
    }
    let getAttempt = 0
    const onEnvelope = vi.fn<(e: Envelope) => void>()

    const transport = new NatsTransport({
      selfHandle: 'alice',
      natsUrl: 'nats://127.0.0.1:4222',
      nkeySeed: 'seed-A',
      roster: mkRoster(),
      onEnvelope,
      onAuthError: vi.fn(),
      connector: async () => conn as unknown as NatsConnection,
      jsFactory: () => js as any,
    })

    await transport.start()
    const message = consumer.messages.pushMessage({
      subject: 'fleet.bob.to.alice.task_dispatch',
      data: encoder.encode(JSON.stringify(mkEnvelope({ kind: 'task_dispatch', to: 'alice', subject: 'proj' }))),
    })
    await waitMs(700)

    expect(getAttempt).toBeGreaterThan(1)
    expect(onEnvelope).toHaveBeenCalledTimes(1)
    expect(onEnvelope).toHaveBeenCalledWith(expect.objectContaining({ kind: 'task_dispatch', to: 'alice' }))
    expect(message.ack).toHaveBeenCalledTimes(1)
    expect(message.term).toHaveBeenCalledTimes(0)

    await transport.stop()
  })

  it('drops task kinds in core fanout subscriptions', async () => {
    const conn = new FakeNatsConnection()
    const js = new FakeJetStreamClient()
    const onEnvelope = vi.fn<(e: Envelope) => void>()
    const transport = mkTransport(conn, js, onEnvelope)
    await transport.start()

    const selfSub = conn.getSubscription('fleet.*.to.alice.>')
    expect(selfSub).toBeDefined()

    selfSub!.push({
      subject: 'fleet.bob.to.alice.task_dispatch',
      data: encoder.encode(JSON.stringify(mkEnvelope({ kind: 'task_dispatch', to: 'alice' }))),
    })
    selfSub!.push({
      subject: 'fleet.bob.to.alice.chat',
      data: encoder.encode(JSON.stringify(mkEnvelope({ kind: 'chat', to: 'alice' }))),
    })
    await waitTick()

    expect(onEnvelope).toHaveBeenCalledTimes(1)
    expect(onEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'chat',
        from: 'bob',
        to: 'alice',
      }),
    )
  })

  it('derives from from wire and acks JetStream messages after gate checks', async () => {
    const conn = new FakeNatsConnection()
    const js = new FakeJetStreamClient()
    const consumer = await js.getConsumer('alice')
    const onEnvelope = vi.fn<(e: Envelope) => void>()
    const transport = mkTransport(conn, js, onEnvelope)
    await transport.start()

    const valid = consumer.messages.pushMessage({
      subject: 'fleet.bob.to.alice.task_dispatch',
      data: encoder.encode(JSON.stringify(mkEnvelope({ kind: 'task_dispatch', to: 'alice', from: 'forged', subject: 'proj' }))),
    })
    const invalid = consumer.messages.pushMessage({
      subject: 'fleet.eve.to.alice.task_dispatch',
      data: new TextEncoder().encode('{broken'),
    })

    await waitTick()

    expect(onEnvelope).toHaveBeenCalledTimes(1)
    expect(onEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'bob',
        to: 'alice',
        kind: 'task_dispatch',
        subject: 'proj',
      }),
    )
    expect(valid.ack).toHaveBeenCalledTimes(1)
    expect(invalid.term).toHaveBeenCalledTimes(1)
  })

  it('stops JetStream consumer loop and cancels delivery', async () => {
    const conn = new FakeNatsConnection()
    const js = new FakeJetStreamClient()
    const consumer = await js.getConsumer('alice')
    const onEnvelope = vi.fn<(e: Envelope) => void>()
    const transport = mkTransport(conn, js, onEnvelope)
    await transport.start()
    await transport.stop()
    expect(consumer.messages.isClosed()).toBe(true)

    const message = consumer.messages.pushMessage({
      subject: 'fleet.bob.to.alice.task_dispatch',
      data: encoder.encode(JSON.stringify(mkEnvelope({ kind: 'task_dispatch', to: 'alice' }))),
    })
    await waitTick()

    expect(onEnvelope).not.toHaveBeenCalled()
    expect(message.ack).not.toHaveBeenCalled()
    expect(message.nak).not.toHaveBeenCalled()
    expect(message.term).not.toHaveBeenCalled()
  })

  it('drops own @team broadcasts on inbound fanout', async () => {
    const onEnvelope = vi.fn<(e: Envelope) => void>()
    const conn = new FakeNatsConnection()
    const transport = mkTransport(conn, new FakeJetStreamClient(), onEnvelope)
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

  it('rejects malformed subjects and kind mismatches before envelope handling', async () => {
    const onEnvelope = vi.fn<(e: Envelope) => void>()
    const conn = new FakeNatsConnection()
    const transport = mkTransport(conn, new FakeJetStreamClient(), onEnvelope)
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
