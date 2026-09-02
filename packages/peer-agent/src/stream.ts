import { fetch } from 'undici'
import { EnvelopeSchema, type Envelope } from '@hangar-bridge/shared'
import { logJson } from './logger.ts'

export interface SseEvent { event: string; data: string }

export function parseSseEvent(block: string): SseEvent | null {
  const lines = block.split('\n')
  let event = 'message'
  const dataParts: string[] = []
  let anyField = false
  for (const line of lines) {
    if (line.startsWith(':')) continue
    if (line.length === 0) continue
    const idx = line.indexOf(':')
    const field = idx === -1 ? line : line.slice(0, idx)
    const value = idx === -1 ? '' : line.slice(idx + 1).replace(/^ /, '')
    anyField = true
    if (field === 'event') event = value
    else if (field === 'data') dataParts.push(value)
  }
  if (!anyField || (dataParts.length === 0 && event === 'message')) return null
  return { event, data: dataParts.join('\n') }
}

export interface StreamClientOpts {
  relayUrl: string
  token: string
  sinceCursor: () => string | undefined
  /**
   * Per-PROCESS instance id, sent as `x-hangar-instance`. The relay derives the
   * presence row key from it on BOTH the presence write and the SSE cleanup, so
   * it must be generated ONCE at startup and stay constant across reconnects —
   * a per-connection value would defeat the relay's connection refcount.
   * Omitted ⇒ legacy behavior (row keyed on the bare token label).
   */
  instanceId?: string
  // Interest patterns (exact or trailing '>') sent as the x-hangar-subjects header
  // so the relay narrows delivery to these. Empty ⇒ all owned + null-subject.
  subjects?: string[]
  onEnvelope: (e: Envelope) => void | Promise<void>
  onAuthError: () => void
  // Fired after each successful stream open (200) and then repeatedly on the heartbeat
  // interval while the stream is up. Used to auto-report presence on connect and keep it
  // fresh under the relay's presence TTL. Failures are swallowed (best-effort liveness).
  onConnect?: () => void | Promise<void>
  // Heartbeat cadence for re-firing onConnect while connected. Omit/0 ⇒ connect-only.
  heartbeatMs?: number
  reconnectBaseMs?: number
  reconnectMaxMs?: number
  stableConnectionMs?: number
  /**
   * How many times ONE envelope may fail delivery (each failure tears the
   * stream down and the reconnect replays it) before the client gives up on
   * it: `onGiveUp` fires, the envelope is skipped, and the stream continues
   * with the next one. Without a cap, a final mile that refuses every message
   * — an agent-call registration pointing at a pid that exited — replays the
   * same envelope forever, at the reconnect backoff, and every layer above
   * keeps reporting the peer as online. Default 3. 0 ⇒ unbounded (old
   * behaviour).
   */
  maxDeliveryAttempts?: number
  /** The envelope this client stopped retrying, with the last error. */
  onGiveUp?: (e: Envelope, err: unknown) => void
  now?: () => number
  // Deterministic test seam. Production uses the interruptible timer below.
  wait?: (ms: number) => Promise<void>
}

export class StreamClient {
  private aborter: AbortController | null = null
  private stopped = false
  private attempt = 0
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private finishReconnectWait: (() => void) | null = null
  /** msg_id → consecutive delivery failures; cleared on success or give-up. */
  private deliveryFailures = new Map<string, number>()

  constructor(private opts: StreamClientOpts) {}

  private fireConnect(): void {
    if (!this.opts.onConnect) return
    void Promise.resolve(this.opts.onConnect()).catch(err =>
      logJson('warn', 'peer.presence.report_error', { err: String(err instanceof Error ? err.message : err) }),
    )
  }

  private startHeartbeat(): void {
    const ms = this.opts.heartbeatMs ?? 0
    if (!this.opts.onConnect || ms <= 0) return
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => this.fireConnect(), ms)
    // Do not keep the event loop alive solely for the heartbeat.
    this.heartbeatTimer.unref?.()
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null }
  }

  async start(): Promise<void> {
    while (!this.stopped) {
      this.aborter = new AbortController()
      let openedAt: number | null = null
      try {
        const since = this.opts.sinceCursor()
        const url = new URL('/v1/stream', this.opts.relayUrl)
        if (since) url.searchParams.set('since', since)
        const headers: Record<string, string> = {
          authorization: `Bearer ${this.opts.token}`, accept: 'text/event-stream',
        }
        if (this.opts.instanceId) headers['x-hangar-instance'] = this.opts.instanceId
        if (this.opts.subjects && this.opts.subjects.length > 0) {
          headers['x-hangar-subjects'] = this.opts.subjects.join(',')
        }
        const res = await fetch(url, { headers, signal: this.aborter.signal })
        if (res.status === 401) { this.opts.onAuthError(); return }
        if (res.status !== 200 || !res.body) throw new Error(`stream http ${res.status}`)
        openedAt = (this.opts.now ?? Date.now)()
        logJson('info', 'peer.stream.open', { since: since ?? '' })
        this.fireConnect()
        this.startHeartbeat()
        await this.readStream(res.body as unknown as ReadableStream<Uint8Array>)
      } catch (err) {
        logJson('warn', 'peer.stream.disconnect', { err: String(err instanceof Error ? err.message : err) })
      } finally {
        // A stream can end either through an error or a clean EOF. Both prove
        // connection stability when they lasted long enough, so clear stale
        // failure history on the shared exit path.
        if (openedAt !== null
            && (this.opts.now ?? Date.now)() - openedAt >= (this.opts.stableConnectionMs ?? 30_000)) {
          this.attempt = 0
        }
        this.stopHeartbeat()
        // Close THIS connection before opening the next one. A delivery error
        // throws out of readStream with the response body still open; without
        // this abort the socket stayed established, the relay kept its
        // subscriber, and the next message fanned out to every generation of
        // this process's stream at once — watched climbing 6 → 10 copies of one
        // message on twgs-revival, 2026-09-02. One process, one stream.
        this.aborter?.abort()
      }
      if (this.stopped) break
      const delay = Math.min(
        this.opts.reconnectMaxMs ?? 30_000,
        (this.opts.reconnectBaseMs ?? 500) * 2 ** Math.min(this.attempt++, 6)
      )
      await (this.opts.wait ? this.opts.wait(delay) : this.waitForReconnect(delay))
    }
  }

  private waitForReconnect(ms: number): Promise<void> {
    return new Promise(resolve => {
      const finish = () => {
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
        this.reconnectTimer = null
        this.finishReconnectWait = null
        resolve()
      }
      this.finishReconnectWait = finish
      this.reconnectTimer = setTimeout(finish, ms)
      this.reconnectTimer.unref?.()
    })
  }

  stop(): void {
    this.stopped = true
    this.stopHeartbeat()
    this.aborter?.abort()
    this.finishReconnectWait?.()
  }

  private async readStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder()
    let buf = ''
    const reader = body.getReader()
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      buf = await this.consume(buf)
    }
  }

  private async consume(buf: string): Promise<string> {
    const parts = buf.split('\n\n')
    const rest = parts.pop() ?? ''
    for (const block of parts) {
      const ev = parseSseEvent(block)
      if (!ev) continue
      logJson('info', 'peer.stream.event', { event: ev.event })
      if (ev.event === 'ping') continue
      if (ev.event !== 'message') continue
      let envelope: Envelope
      try {
        const raw = JSON.parse(ev.data)
        envelope = EnvelopeSchema.parse(raw)
      } catch (err) {
        logJson('warn', 'peer.stream.decode_error', { err: String(err instanceof Error ? err.message : err) })
        continue
      }
      try {
        await this.opts.onEnvelope(envelope)
        // A successful transport/final-mile acceptance resets retry backoff; it
        // does not claim model observation. Merely opening
        // the SSE socket does not: a poison/offline-target envelope may be
        // replayed immediately, and resetting there creates a 500 ms hot loop.
        this.attempt = 0
        this.deliveryFailures.delete(envelope.id)
      } catch (err) {
        const failures = (this.deliveryFailures.get(envelope.id) ?? 0) + 1
        const cap = this.opts.maxDeliveryAttempts ?? 3
        logJson('warn', 'peer.stream.delivery_error', {
          msg_id: envelope.id,
          attempt: failures,
          err: String(err instanceof Error ? err.message : err),
        })
        if (cap > 0 && failures >= cap) {
          // Stop replaying this one. It stays in the relay's durable buffer and
          // poll_inbox / GET /v1/messages still return it; what ends here is the
          // reconnect-and-replay of a message the final mile has now refused
          // `cap` times, which was blocking every message behind it.
          this.deliveryFailures.delete(envelope.id)
          logJson('error', 'peer.stream.delivery_gave_up', { msg_id: envelope.id, attempts: failures })
          try { this.opts.onGiveUp?.(envelope, err) } catch { /* observer must not break the stream */ }
          continue
        }
        this.deliveryFailures.set(envelope.id, failures)
        // Abort this stream read. Since InboundDispatcher did not advance its cursor,
        // the reconnect requests this envelope again instead of losing it.
        throw err
      }
    }
    return rest
  }
}
