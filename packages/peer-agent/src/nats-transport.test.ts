import { describe, it, expect, vi } from 'vitest'
import { TEAM_BROADCAST_HANDLE, type Envelope } from '@hangar-bridge/shared'
import type { NatsConnection } from '@nats-io/transport-node'
import { NatsTransport } from './nats-transport.ts'
import { InboundDispatcher } from './inbound.ts'
import { SenderGate } from './gate.ts'
import { DispatchTracker } from './correlation.ts'

interface PublishCall {
  subject: string
  data: Uint8Array
  msgID?: string
}

interface NatsMessage {
  subject: string
  data: Uint8Array
}

interface JetStreamMessage {
  subject: string
  data: Uint8Array
  redelivered?: boolean
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

  async flush(): Promise<void> {
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

  publish(subject: string, data: Uint8Array = new Uint8Array(), opts: { msgID?: string } = {}): Promise<void> {
    this.published.push({ subject, data, ...(opts.msgID ? { msgID: opts.msgID } : {}) })
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

const noOpInstanceGuard = () => ({ acquire: vi.fn(), release: vi.fn() })

function memoryDedup() {
  const completed = new Set<string>()
  return {
    seen: vi.fn(async (key: string) => completed.has(key)),
    classify: vi.fn(async (key: string) => completed.has(key) ? 'duplicate' as const : 'new' as const),
    isCompleted: vi.fn(async (key: string) => completed.has(key)),
    markCompleted: vi.fn(async (key: string) => { completed.add(key) }),
  }
}

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
  onEnvelope: (e: Envelope) => void | Promise<void>,
  onAuthError = vi.fn(),
) {
  return new NatsTransport({
    selfHandle: 'alice',
    natsUrl: 'nats://127.0.0.1:4222',
    nkeySeed: 'seed-A',
    roster: mkRoster(),
    onEnvelope: async e => {
      await onEnvelope(e)
      return 'delivered'
    },
    onAuthError,
    instanceGuard: noOpInstanceGuard(),
    auditWriter: vi.fn(),
    dedup: memoryDedup(),
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
    conn.published.length = 0 // ignore the immediate startup heartbeat

    await transport.send({ to: 'bob', kind: 'chat', content: 'hello', subject: null })
    await transport.send({ to: 'bob', kind: 'presence_update', content: 'present', subject: null })
    await transport.send({ to: 'bob', kind: 'permission_request', content: 'ask', subject: null })
    await transport.send({ to: 'bob', kind: 'permission_verdict', content: 'ok', in_reply_to: 'msg_01HRK7Y000000000000000000B' })
    await transport.send({ to: 'bob', kind: 'task_dispatch', content: 'job' })
    await transport.send({ to: 'bob', kind: 'task_result', content: 'done', in_reply_to: 'msg_01HRK7Y000000000000000000C' })

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
      transport.send({ to: TEAM_BROADCAST_HANDLE, kind: 'permission_verdict', content: 'x', in_reply_to: 'msg_01HRK7Y000000000000000000D' }),
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
    const onEnvelope = vi.fn<(e: Envelope) => 'delivered'>(() => 'delivered')

    const transport = new NatsTransport({
      selfHandle: 'alice',
      natsUrl: 'nats://127.0.0.1:4222',
      nkeySeed: 'seed-A',
      roster: mkRoster(),
      onEnvelope,
      onAuthError: vi.fn(),
      instanceGuard: noOpInstanceGuard(),
      auditWriter: vi.fn(),
      dedup: memoryDedup(),
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

  it('delivers subject-scoped @team chat after publisher and receiver ACL checks', async () => {
    const onEnvelope = vi.fn<(e: Envelope) => void>()
    const conn = new FakeNatsConnection()
    const transport = mkTransport(conn, new FakeJetStreamClient(), onEnvelope)
    await transport.start()

    const teamSub = conn.getSubscription('fleet.*.to.team.>')
    expect(teamSub).toBeDefined()
    teamSub!.push({
      subject: 'fleet.bob.to.team.chat',
      data: encoder.encode(JSON.stringify(mkEnvelope({
        from: 'forged',
        to: TEAM_BROADCAST_HANDLE,
        kind: 'chat',
        subject: 'proj.status',
      }))),
    })
    await waitTick()

    expect(onEnvelope).toHaveBeenCalledOnce()
    expect(onEnvelope).toHaveBeenCalledWith(expect.objectContaining({
      from: 'bob',
      to: TEAM_BROADCAST_HANDLE,
      subject: 'proj.status',
    }))
  })

  it('drops and audits a wire-authenticated peer publishing a namespace it does not own', async () => {
    const conn = new FakeNatsConnection()
    const js = new FakeJetStreamClient()
    const consumer = await js.getConsumer('alice')
    const onEnvelope = vi.fn<(e: Envelope) => void>()
    const auditWriter = vi.fn()
    const transport = new NatsTransport({
      selfHandle: 'alice',
      natsUrl: 'nats://127.0.0.1:4222',
      nkeySeed: 'seed-A',
      roster: {
        alice: { owned: ['proj'], interest: ['proj.>'] },
        bob: { owned: ['other'], interest: [] },
      },
      onEnvelope,
      onAuthError: vi.fn(),
      instanceGuard: noOpInstanceGuard(),
      auditWriter,
      dedup: memoryDedup(),
      connector: async () => conn as unknown as NatsConnection,
      jsFactory: () => ({
        publish: js.publish.bind(js),
        consumers: js.consumersApi(),
      }) as any,
    } as any)
    await transport.start()

    conn.getSubscription('fleet.*.to.alice.>')!.push({
      subject: 'fleet.bob.to.alice.chat',
      data: encoder.encode(JSON.stringify(mkEnvelope({ from: 'forged', subject: 'proj.status' }))),
    })
    const durable = consumer.messages.pushMessage({
      subject: 'fleet.bob.to.alice.task_dispatch',
      data: encoder.encode(JSON.stringify(mkEnvelope({
        id: 'msg_01HRK7Y000000000000000000E',
        from: 'forged',
        kind: 'task_dispatch',
        subject: 'proj.command',
      }))),
    })
    await waitTick()

    expect(onEnvelope).not.toHaveBeenCalled()
    expect(durable.term).toHaveBeenCalledOnce()
    expect(durable.nak).not.toHaveBeenCalled()
    expect(auditWriter).toHaveBeenCalledTimes(2)
    expect(auditWriter).toHaveBeenCalledWith(expect.objectContaining({
      sender: 'bob',
      reason: 'forbidden_subject',
    }))
  })

  it('naks an ACL-denied durable task when the denial audit cannot be persisted', async () => {
    const conn = new FakeNatsConnection()
    const js = new FakeJetStreamClient()
    const consumer = await js.getConsumer('alice')
    const transport = new NatsTransport({
      selfHandle: 'alice',
      natsUrl: 'nats://127.0.0.1:4222',
      nkeySeed: 'seed-A',
      roster: {
        alice: { owned: ['proj'], interest: ['proj.>'] },
        bob: { owned: ['other'], interest: [] },
      },
      onEnvelope: vi.fn(),
      onAuthError: vi.fn(),
      instanceGuard: noOpInstanceGuard(),
      auditWriter: () => { throw new Error('disk full') },
      dedup: memoryDedup(),
      connector: async () => conn as unknown as NatsConnection,
      jsFactory: () => ({
        publish: js.publish.bind(js),
        consumers: js.consumersApi(),
      }) as any,
    } as any)
    await transport.start()

    const durable = consumer.messages.pushMessage({
      subject: 'fleet.bob.to.alice.task_dispatch',
      data: encoder.encode(JSON.stringify(mkEnvelope({
        id: 'msg_01HRK7Y000000000000000000H',
        from: 'forged',
        kind: 'task_dispatch',
        subject: 'proj.command',
      }))),
    })
    await waitTick()

    expect(durable.nak).toHaveBeenCalledOnce()
    expect(durable.term).not.toHaveBeenCalled()
  })

  it('marks completion only after delivery, then suppresses a distinct correlation duplicate', async () => {
    const conn = new FakeNatsConnection()
    const js = new FakeJetStreamClient()
    const consumer = await js.getConsumer('alice')
    const onEnvelope = vi.fn<(e: Envelope) => Promise<'delivered'>>()
      .mockRejectedValueOnce(new Error('handler unavailable'))
      .mockResolvedValue('delivered')
    const completed = new Set<string>()
    const dedup = {
      seen: vi.fn(async (key: string) => completed.has(key)),
      classify: vi.fn(async (key: string) => completed.has(key) ? 'duplicate' as const : 'new' as const),
      isCompleted: vi.fn(async (key: string) => completed.has(key)),
      markCompleted: vi.fn(async (key: string) => { completed.add(key) }),
    }
    const transport = new NatsTransport({
      selfHandle: 'alice',
      natsUrl: 'nats://127.0.0.1:4222',
      nkeySeed: 'seed-A',
      roster: mkRoster(),
      onEnvelope,
      onAuthError: vi.fn(),
      instanceGuard: noOpInstanceGuard(),
      auditWriter: vi.fn(),
      dedup,
      connector: async () => conn as unknown as NatsConnection,
      jsFactory: () => ({
        publish: js.publish.bind(js),
        consumers: js.consumersApi(),
      }) as any,
    } as any)
    await transport.start()

    const firstEnvelope = mkEnvelope({
      id: 'msg_01HRK7Y000000000000000000F',
      kind: 'task_dispatch',
      subject: 'proj.command',
      meta: { correlation_id: 'corr-retry' },
    })
    const first = consumer.messages.pushMessage({
      subject: 'fleet.bob.to.alice.task_dispatch',
      data: encoder.encode(JSON.stringify(firstEnvelope)),
      redelivered: false,
    })
    await waitTick()
    expect(first.nak).toHaveBeenCalledOnce()

    const retry = consumer.messages.pushMessage({
      subject: 'fleet.bob.to.alice.task_dispatch',
      data: encoder.encode(JSON.stringify(firstEnvelope)),
      redelivered: true,
    })
    await waitTick()
    expect(retry.ack).toHaveBeenCalledOnce()

    const duplicate = consumer.messages.pushMessage({
      subject: 'fleet.bob.to.alice.task_dispatch',
      data: encoder.encode(JSON.stringify(mkEnvelope({
        id: 'msg_01HRK7Y000000000000000000G',
        kind: 'task_dispatch',
        subject: 'proj.command',
        meta: { correlation_id: 'corr-retry' },
      }))),
      redelivered: false,
    })
    await waitTick()

    expect(onEnvelope).toHaveBeenCalledTimes(2)
    expect(duplicate.ack).toHaveBeenCalledOnce()
    expect(dedup.markCompleted).toHaveBeenCalledOnce()
    expect(dedup.markCompleted).toHaveBeenCalledWith('corr-retry', firstEnvelope.id)
  })

  it('retries a failed completion-marker write without re-emitting the exact envelope', async () => {
    const conn = new FakeNatsConnection()
    const js = new FakeJetStreamClient()
    const consumer = await js.getConsumer('alice')
    const emit = vi.fn()
    const dispatcher = new InboundDispatcher({
      gate: new SenderGate(['alice', 'bob']),
      emit,
      setCursor: vi.fn(),
    })
    const completed = new Set<string>()
    let markerAttempts = 0
    const dedup = {
      seen: vi.fn(async (key: string) => completed.has(key)),
      classify: vi.fn(async (key: string) => completed.has(key) ? 'duplicate' as const : 'new' as const),
      isCompleted: vi.fn(async (key: string) => completed.has(key)),
      markCompleted: vi.fn(async (key: string) => {
        markerAttempts += 1
        if (markerAttempts === 1) throw new Error('KV write unavailable')
        completed.add(key)
      }),
    }
    const transport = new NatsTransport({
      selfHandle: 'alice',
      natsUrl: 'nats://127.0.0.1:4222',
      nkeySeed: 'seed-A',
      roster: mkRoster(),
      onEnvelope: e => dispatcher.handle(e),
      onAuthError: vi.fn(),
      instanceGuard: noOpInstanceGuard(),
      auditWriter: vi.fn(),
      dedup,
      connector: async () => conn as unknown as NatsConnection,
      jsFactory: () => ({
        publish: js.publish.bind(js),
        consumers: js.consumersApi(),
      }) as any,
    })
    await transport.start()

    const task = mkEnvelope({
      id: 'msg_01HRK7Y000000000000000000G',
      kind: 'task_dispatch',
      subject: 'proj.command',
      meta: { correlation_id: 'corr-marker-retry' },
    })
    const first = consumer.messages.pushMessage({
      subject: 'fleet.bob.to.alice.task_dispatch',
      data: encoder.encode(JSON.stringify(task)),
    })
    await waitTick()
    expect(first.nak).toHaveBeenCalledOnce()
    expect(emit).toHaveBeenCalledOnce()

    const retry = consumer.messages.pushMessage({
      subject: 'fleet.bob.to.alice.task_dispatch',
      data: encoder.encode(JSON.stringify(task)),
      redelivered: true,
    })
    await waitTick()

    expect(retry.ack).toHaveBeenCalledOnce()
    expect(emit).toHaveBeenCalledOnce()
    expect(dedup.markCompleted).toHaveBeenCalledTimes(2)
    expect(await dedup.isCompleted('corr-marker-retry')).toBe(true)
    await transport.stop()
  })

  it('terminates a wrong-peer task_result without consuming the legitimate correlation', async () => {
    const conn = new FakeNatsConnection()
    const js = new FakeJetStreamClient()
    const consumer = await js.getConsumer('alice')
    const roster = {
      ...mkRoster(),
      charlie: { owned: ['other'], interest: [] },
    }
    const correlationId = 'corr-expected-bob'
    const dispatchId = 'msg_01HRK7Y000000000000000000D'
    const tracker = new DispatchTracker({ ttlMs: 60_000 })
    tracker.recordOutgoing(correlationId, dispatchId, 'bob')
    const emit = vi.fn()
    const dispatcher = new InboundDispatcher({
      gate: new SenderGate(Object.keys(roster)),
      emit,
      setCursor: vi.fn(),
      dispatchTracker: tracker,
    })
    const dedup = memoryDedup()
    const transport = new NatsTransport({
      selfHandle: 'alice',
      natsUrl: 'nats://127.0.0.1:4222',
      nkeySeed: 'seed-A',
      roster,
      onEnvelope: e => dispatcher.handle(e),
      onAuthError: vi.fn(),
      instanceGuard: noOpInstanceGuard(),
      auditWriter: vi.fn(),
      dedup,
      connector: async () => conn as unknown as NatsConnection,
      jsFactory: () => ({
        publish: js.publish.bind(js),
        consumers: js.consumersApi(),
      }) as any,
    })
    await transport.start()

    // Prime the application-level msg-id cache with an actually delivered but
    // unrelated envelope. Reusing this ID for a wrong-peer result must not turn
    // `already-delivered` into authority to consume the correlation marker.
    await expect(dispatcher.handle(mkEnvelope({
      id: 'msg_01HRK7Y000000000000000000E',
      from: 'charlie',
      kind: 'chat',
      content: 'unrelated delivered message',
    }))).resolves.toBe('delivered')
    emit.mockClear()

    const wrong = consumer.messages.pushMessage({
      subject: 'fleet.charlie.to.alice.task_result',
      data: encoder.encode(JSON.stringify(mkEnvelope({
        id: 'msg_01HRK7Y000000000000000000E',
        kind: 'task_result',
        in_reply_to: dispatchId,
        content: 'forged',
        meta: { correlation_id: correlationId },
      }))),
    })
    await waitTick()

    expect(wrong.term).toHaveBeenCalledOnce()
    expect(wrong.ack).not.toHaveBeenCalled()
    expect(wrong.nak).not.toHaveBeenCalled()
    expect(dedup.markCompleted).not.toHaveBeenCalled()
    expect(await dedup.isCompleted(correlationId)).toBe(false)
    expect(emit).not.toHaveBeenCalled()

    const legitimateEnvelope = mkEnvelope({
      id: 'msg_01HRK7Y000000000000000000F',
      kind: 'task_result',
      in_reply_to: dispatchId,
      content: 'done',
      meta: { correlation_id: correlationId },
    })
    const legitimate = consumer.messages.pushMessage({
      subject: 'fleet.bob.to.alice.task_result',
      data: encoder.encode(JSON.stringify(legitimateEnvelope)),
    })
    await waitTick()

    expect(legitimate.ack).toHaveBeenCalledOnce()
    expect(legitimate.term).not.toHaveBeenCalled()
    expect(emit).toHaveBeenCalledOnce()
    expect(dedup.markCompleted).toHaveBeenCalledOnce()
    expect(dedup.markCompleted).toHaveBeenCalledWith(correlationId, legitimateEnvelope.id)
    await transport.stop()
  })

  it('validates outbound input and forwards the idempotency key as JetStream msgID', async () => {
    const conn = new FakeNatsConnection()
    const js = new FakeJetStreamClient()
    const transport = mkTransport(conn, js, vi.fn())
    await transport.start()

    await expect(transport.send({
      to: 'bob',
      kind: 'task_result',
      content: 'invalid',
      in_reply_to: 'not-a-message-id',
    } as never)).rejects.toThrow()

    await transport.send(
      { to: 'bob', kind: 'task_dispatch', content: 'job' },
      { idempotency_key: 'CORR_01HRK7Y000000000000000000' },
    )
    expect(js.published.at(-1)?.msgID).toBe('corr_01hrk7y000000000000000000')
  })

  it('reuses the original envelope after a lost JetStream PubAck', async () => {
    const conn = new FakeNatsConnection()
    const js = new FakeJetStreamClient()
    let attempts = 0
    vi.spyOn(js, 'publish').mockImplementation(async (subject, data, opts = {}) => {
      js.published.push({ subject, data, ...(opts.msgID ? { msgID: opts.msgID } : {}) })
      attempts += 1
      if (attempts === 1) throw new Error('PubAck lost after server accepted payload')
    })
    const transport = mkTransport(conn, js, vi.fn())
    await transport.start()
    const task = { to: 'bob', kind: 'task_dispatch', content: 'job' } as const
    const opts = { idempotency_key: 'CORR_01HRK7Y000000000000000099' }

    await expect(transport.send(task, opts)).rejects.toThrow(/publish failed/i)
    const retryResult = await transport.send(task, opts)

    const ids = js.published.map(call => JSON.parse(new TextDecoder().decode(call.data)).id as string)
    expect(ids).toHaveLength(2)
    expect(ids[0]).toBe(ids[1])
    expect(retryResult.id).toBe(ids[0])
    await transport.stop()
  })

  it('rejects direct sends to handles absent from the roster', async () => {
    const conn = new FakeNatsConnection()
    const js = new FakeJetStreamClient()
    const transport = mkTransport(conn, js, vi.fn())
    await transport.start()
    await expect(transport.send({ to: 'charlie', kind: 'chat', content: 'lost' }))
      .rejects.toThrow(/unknown roster recipient/)
    expect(conn.published.some(call => call.subject.includes('.charlie.'))).toBe(false)
    await transport.stop()
  })

  it('keeps presence heartbeats in the control plane instead of Claude context', async () => {
    const conn = new FakeNatsConnection()
    const onEnvelope = vi.fn<(e: Envelope) => 'delivered'>(() => 'delivered')
    const transport = mkTransport(conn, new FakeJetStreamClient(), onEnvelope)
    await transport.start()
    conn.getSubscription('fleet.*.to.team.>')!.push({
      subject: 'fleet.bob.to.team.presence_update',
      data: encoder.encode(JSON.stringify(mkEnvelope({
        from: 'forged',
        to: TEAM_BROADCAST_HANDLE,
        kind: 'presence_update',
        content: '',
      }))),
    })
    await waitTick()
    expect(onEnvelope).not.toHaveBeenCalled()
    expect((await transport.listPeers()).find(peer => peer.handle === 'bob')?.online).toBe(true)
    await transport.stop()
  })

  it('does not wedge sends after a recoverable NATS status error', async () => {
    const conn = new FakeNatsConnection()
    const transport = mkTransport(conn, new FakeJetStreamClient(), vi.fn())
    await transport.start()
    conn.published.length = 0
    conn.statusSource.push({ type: 'error', error: new Error('permissions violation on one subject') })
    await waitTick()
    await expect(transport.send({ to: 'bob', kind: 'chat', content: 'still connected' }))
      .resolves.toMatchObject({ kind: 'chat' })
    await transport.stop()
  })

  it('retries dedup open and does not consume durable tasks until it is ready', async () => {
    const conn = new FakeNatsConnection()
    const js = new FakeJetStreamClient()
    const consumer = await js.getConsumer('alice')
    const onEnvelope = vi.fn<(e: Envelope) => 'delivered'>(() => 'delivered')
    const dedup = memoryDedup()
    let opens = 0
    const transport = new NatsTransport({
      selfHandle: 'alice',
      natsUrl: 'nats://127.0.0.1:4222',
      nkeySeed: 'seed-A',
      roster: mkRoster(),
      onEnvelope,
      onAuthError: vi.fn(),
      instanceGuard: noOpInstanceGuard(),
      auditWriter: vi.fn(),
      connector: async () => conn as unknown as NatsConnection,
      jsFactory: () => ({
        publish: js.publish.bind(js),
        consumers: js.consumersApi(),
      }) as any,
      dedupFactory: async () => {
        opens += 1
        if (opens === 1) throw new Error('KV temporarily unavailable')
        return dedup
      },
    })
    await transport.start()
    const message = consumer.messages.pushMessage({
      subject: 'fleet.bob.to.alice.task_dispatch',
      data: encoder.encode(JSON.stringify(mkEnvelope({ kind: 'task_dispatch', subject: 'proj.command' }))),
    })
    await waitMs(100)
    expect(onEnvelope).not.toHaveBeenCalled()
    await waitMs(700)
    expect(opens).toBeGreaterThanOrEqual(2)
    expect(onEnvelope).toHaveBeenCalledOnce()
    expect(message.ack).toHaveBeenCalledOnce()
    await transport.stop()
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

  it('AC4 rejects a disconnected publish instead of reporting volatile outbox success', async () => {
    const transport = new NatsTransport({
      selfHandle: 'alice',
      natsUrl: 'nats://127.0.0.1:4222',
      nkeySeed: 'seed-A',
      roster: mkRoster(),
      onEnvelope: vi.fn(),
      onAuthError: vi.fn(),
      instanceGuard: noOpInstanceGuard(),
      auditWriter: vi.fn(),
    })
    await expect(
      transport.send({ to: 'bob', kind: 'task_dispatch', content: 'must-not-claim-success' }),
    ).rejects.toThrow(/not connected|publish failed/i)
  })

  it('AC4 rejects a core publish when the server-confirming flush fails', async () => {
    const conn = new FakeNatsConnection()
    const transport = mkTransport(conn, new FakeJetStreamClient(), vi.fn())
    await transport.start()
    conn.published.length = 0
    vi.spyOn(conn, 'flush').mockRejectedValue(new Error('connection lost before flush'))

    await expect(transport.send({ to: 'bob', kind: 'chat', content: 'must-confirm' }))
      .rejects.toThrow(/publish failed/i)
  })
})
