import type { Db } from './db/db.ts'
import type { MessageStore } from './messages/store.ts'
import type { Fanout } from './fanout.ts'
import type { PresenceRegistry } from './presence/registry.ts'
import type { ClaimStore } from './claims/store.ts'

export interface Deps {
  db: Db
  store: MessageStore
  fanout: Fanout
  presence: PresenceRegistry
  claims: ClaimStore
  now: () => Date
  /**
   * How to treat an unqualified fleet-wide broadcast. 'warn' records it and
   * delivers (the migration window, while senders still speak the old
   * vocabulary); 'enforce' refuses with a message naming the alternatives.
   * Defaults to 'warn' when unset so an existing deployment does not change
   * behaviour on upgrade.
   */
  broadcastGate?: 'warn' | 'enforce'
}
