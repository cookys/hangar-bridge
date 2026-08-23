import { monotonicFactory } from 'ulid'

const MESSAGE_ID_REGEX = /^msg_[0-9A-HJKMNP-TV-Z]{26}$/

const monotonicUlid = monotonicFactory()

export type MessageId = `msg_${string}`

export function newMessageId(): MessageId {
  return `msg_${monotonicUlid()}` as MessageId
}

export function isValidMessageId(id: string): id is MessageId {
  return MESSAGE_ID_REGEX.test(id)
}

export function compareMessageIds(a: MessageId, b: MessageId): number {
  return a < b ? -1 : a > b ? 1 : 0
}

const INSTANCE_ID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/

export type InstanceId = string

/**
 * Per-PROCESS instance id (P2 presence uniqueness).
 *
 * Generated ONCE at peer-agent startup and held constant across SSE
 * reconnects, so the relay's per-(label, instance) connection refcount can
 * aggregate every connection of one process. It is an observability /
 * presence-key value only — it is deliberately NOT an addressing unit
 * (no `to_instance`; see plan §2.1). Shares the monotonic factory with
 * message ids so two processes started in the same millisecond still differ.
 */
export function newInstanceId(): InstanceId {
  return monotonicUlid()
}

export function isValidInstanceId(id: string): boolean {
  return INSTANCE_ID_REGEX.test(id)
}
