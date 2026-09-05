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
  /**
   * REPLY_ROUTING_SPEC.md §6 rollout flag. 'off' (default) keeps
   * `/v1/messages` byte-identical to today; 'on' enables the §6.1-6.3
   * address refusals (`use_reply_verb`, `sender_instance_required`,
   * `handle_needs_all_sessions`, `dispatch_needs_instance`). Mirrors
   * `broadcastGate`'s default-preserves-behaviour posture. `reserved_address`
   * / `reserved_instance` (§6.5) and `not_in_thread` (§7) are NOT gated by
   * this flag — they come from the shared schema / are always enforced.
   */
  addressRules?: 'off' | 'on'
}
