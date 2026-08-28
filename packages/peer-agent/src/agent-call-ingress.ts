import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { Envelope } from '@hangar-bridge/shared'

export interface AgentCallFinalMileOptions {
  target: string
  bin?: string
}

export interface AgentCallReceipt {
  status: 'channel_accepted' | 'injected_unverified'
  [key: string]: unknown
}

function transportContent(envelope: Envelope): string {
  const metadata = {
    source: 'hangar-bridge',
    remote_msg_id: envelope.id,
    kind: envelope.kind,
    remote_sent_at: envelope.sent_at,
    ...(envelope.subject ? { subject: envelope.subject } : {}),
    ...(envelope.in_reply_to ? { in_reply_to: envelope.in_reply_to } : {}),
    ...(envelope.thread_root ? { thread_root: envelope.thread_root } : {}),
    ...(envelope.meta.correlation_id ? { correlation_id: envelope.meta.correlation_id } : {}),
    ...(envelope.meta.task_kind ? { task_kind: envelope.meta.task_kind } : {}),
  }
  return `${JSON.stringify(metadata)}\n${envelope.content}`
}

export async function deliverViaAgentCall(
  envelope: Envelope,
  options: AgentCallFinalMileOptions,
): Promise<AgentCallReceipt> {
  const message = {
    schema: 'agent-call.message.v1',
    id: `ac_${randomUUID()}`,
    from: envelope.from,
    to: options.target,
    authority: 'peer',
    origin: 'transport',
    reply: 'none',
    content: transportContent(envelope),
    sent_at: new Date().toISOString(),
  }

  return await new Promise<AgentCallReceipt>((resolve, reject) => {
    const child = execFile(
      options.bin ?? 'agent-call',
      ['receive', '--stdin', '--json'],
      { timeout: 5_000, maxBuffer: 64 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.trim() || stdout.trim() || error.message
          reject(new Error(`agent-call final-mile failed: ${detail}`))
          return
        }
        try {
          const receipt = JSON.parse(stdout) as Record<string, unknown>
          if (receipt.status !== 'channel_accepted' && receipt.status !== 'injected_unverified') {
            throw new Error(`unexpected receipt status: ${String(receipt.status)}`)
          }
          resolve(receipt as AgentCallReceipt)
        } catch (parseError) {
          reject(new Error(
            `agent-call final-mile returned an invalid receipt: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
          ))
        }
      },
    )
    if (!child.stdin) {
      child.kill()
      reject(new Error('agent-call final-mile failed: child stdin is unavailable'))
      return
    }
    // A fast fail (missing/offline target) may close stdin before this small envelope
    // is flushed. The execFile callback owns the named failure; suppress a duplicate
    // Writable EPIPE so it cannot become an unhandled process error.
    child.stdin.on('error', () => {})
    child.stdin.end(`${JSON.stringify(message)}\n`)
  })
}
