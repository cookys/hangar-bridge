import { appendFileSync, chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { NatsAuditRecord } from './nats-transport.ts'

const AUDIT_FILE = 'nats-denials.jsonl'

/**
 * Synchronous append is intentional: a durable JetStream rejection is not `term`ed
 * until its denial record has reached the local filesystem API successfully.
 */
export function createNatsAuditWriter(directory: string): (record: NatsAuditRecord) => void {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  chmodSync(directory, 0o700)
  const path = join(directory, AUDIT_FILE)
  return record => {
    appendFileSync(path, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 })
    chmodSync(path, 0o600)
  }
}
