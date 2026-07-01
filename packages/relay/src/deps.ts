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
}
