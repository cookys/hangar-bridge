import {
  EnvelopeSchema,
  envelopeFromRow,
  newMessageId,
  PROTOCOL_VERSION,
  TEAM_BROADCAST_HANDLE,
  type Envelope,
  type EnvelopeRow,
  type OutboundMessage,
} from '@hangar-bridge/shared'
import type { Db } from '../db/db.ts'

export interface ReplyRoute {
  msg_id: string
  team_id: string
  from_handle: string
  sender_instance: string | null
  return_selector: string | null
  to_handle: string
  to_filter_json: string | null
  thread_root: string
  legacy_width: string | null
  correlation_id: string | null
  created_at: string
  expires_at: string | null
  unaddressable_at: string | null
}

export interface ReplyRouteInput {
  msg_id: string
  team_id: string
  from_handle: string
  sender_instance?: string | null
  return_selector?: string | null
  to_handle: string
  to_filter_json?: string | null
  thread_root: string
  legacy_width?: string | null
  correlation_id?: string | null
  created_at: string
  expires_at?: string | null
  unaddressable_at?: string | null
}

export interface ReplyGrantInput {
  handle: string
  instance: string
  selector?: string
}

/** §8.1 grant finalisation outcome: `null` maps to the caller's `grant_not_found`. */
export type FinalizeGrantResult = 'replaced' | 'exists' | 'inserted' | null

/**
 * Like `envelopeFromRow`, but skips `EnvelopeSchema.parse`: a mailbox row's
 * `to_handle` is `@mailbox:<handle>` (§8.2), a shape `AddressSchema` does not
 * accept yet — that widening is shared-package work, out of this
 * deliverable's allowed paths. The row was already validated once, at
 * whatever chokepoint persisted it; this is a read-only pull.
 */
function envelopeFromMailboxRow(row: EnvelopeRow): Envelope {
  return {
    id: row.id, v: row.v, team: row.team_id,
    from: row.from_handle, to: row.to_handle, subject: row.subject,
    in_reply_to: row.in_reply_to, thread_root: row.thread_root,
    kind: row.kind, content: row.content,
    meta: JSON.parse(row.meta_json) as Record<string, string>,
    to_filter: row.to_filter_json == null ? null : JSON.parse(row.to_filter_json),
    sent_at: row.sent_at, delivered_at: row.delivered_at,
  } as Envelope
}

export class MessageStore {
  constructor(private readonly db: Db) {}

  /**
   * Validate + construct an Envelope WITHOUT writing it. Split out of `insert`
   * so a directed (to_filter) message can be built + presence-gate-delivered and
   * then, per its kind, either persisted (task_dispatch{instance}) or dropped
   * (chat) — while keeping recipient/in_reply_to validation identical to a
   * normal send. `delivered_at` defaults null; a caller may override at persist.
   */
  buildEnvelope(team_id: string, from_handle: string, msg: OutboundMessage): Envelope {
    if (msg.to !== TEAM_BROADCAST_HANDLE) {
      const rcpt = this.db.prepare(
        "SELECT 1 AS x FROM human WHERE team_id=? AND handle=? AND disabled_at IS NULL"
      ).get(team_id, msg.to)
      if (!rcpt) throw new Error(`unknown recipient: ${msg.to}`)
    }

    let thread_root: string | null = null
    if (msg.in_reply_to) {
      const parent = this.db.prepare(
        "SELECT thread_root, id FROM message WHERE id=? AND team_id=?"
      ).get(msg.in_reply_to, team_id) as { thread_root: string | null; id: string } | undefined
      if (!parent) throw new Error(`unknown in_reply_to: ${msg.in_reply_to}`)
      thread_root = parent.thread_root ?? parent.id
    }

    return EnvelopeSchema.parse({
      id: newMessageId(),
      v: PROTOCOL_VERSION,
      team: team_id,
      from: from_handle,
      to: msg.to,
      subject: msg.subject ?? null,
      in_reply_to: msg.in_reply_to ?? null,
      thread_root,
      kind: msg.kind,
      content: msg.content,
      meta: msg.meta ?? {},
      to_filter: msg.to_filter ?? null,
      sent_at: new Date().toISOString(),
      delivered_at: null,
    })
  }

  /** Write a pre-built envelope. `deliveredAt` overrides envelope.delivered_at. */
  persist(envelope: Envelope, deliveredAt?: string | null): void {
    this.db.prepare(`
      INSERT INTO message(id,v,team_id,from_handle,to_handle,subject,in_reply_to,thread_root,kind,content,meta_json,to_filter_json,sent_at,delivered_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      envelope.id, envelope.v, envelope.team, envelope.from, envelope.to, envelope.subject,
      envelope.in_reply_to, envelope.thread_root, envelope.kind, envelope.content,
      JSON.stringify(envelope.meta),
      envelope.to_filter == null ? null : JSON.stringify(envelope.to_filter),
      envelope.sent_at, deliveredAt !== undefined ? deliveredAt : envelope.delivered_at
    )
  }

  insert(team_id: string, from_handle: string, msg: OutboundMessage): Envelope {
    const envelope = this.buildEnvelope(team_id, from_handle, msg)
    this.persist(envelope)
    return envelope
  }

  /**
   * §4 drain self-exclusion: when `pollerInstance` is given, a direct row
   * additionally requires the sending instance to be absent or different —
   * a durable bare-handle self-send no longer replays into the sending
   * session's own next cold start. Omitted, behaviour is byte-identical to
   * today (existing callers unaffected).
   */
  fetchSince(team_id: string, to_handle: string, since_id: string, pollerInstance?: string): Envelope[] {
    const directClause = pollerInstance === undefined
      ? 'to_handle=?'
      : `(to_handle=? AND (json_extract(meta_json,'$.sender_instance') IS NULL OR json_extract(meta_json,'$.sender_instance') != ?))`
    const params = pollerInstance === undefined
      ? [team_id, since_id, to_handle, to_handle]
      : [team_id, since_id, to_handle, pollerInstance, to_handle]
    const rows = this.db.prepare(`
      SELECT id, v, team_id, from_handle, to_handle, subject, in_reply_to, thread_root,
             kind, content, meta_json, to_filter_json, sent_at, delivered_at
      FROM message
      WHERE team_id=? AND id > ?
        AND to_handle NOT LIKE '@mailbox:%'
        AND (${directClause} OR (to_handle='@team' AND from_handle != ?))
      ORDER BY id ASC LIMIT 1000
    `).all(...params) as EnvelopeRow[]
    return rows.map(envelopeFromRow)
  }

  // Cold-start pending drain, CURSORED so the caller can page through with a
  // monotonic id cursor (start since_id='') and never get stuck on a full page of
  // non-deliverable (interest-narrowed, delivered_at=NULL) rows at the front of the
  // window — the single-shot variant could permanently starve deliverable rows past
  // position 1000 (B3 black hole).
  // Same §4 self-exclusion as fetchSince (pollerInstance optional, back-compat when omitted).
  fetchPendingSince(team_id: string, to_handle: string, since_id: string, pollerInstance?: string): Envelope[] {
    const directClause = pollerInstance === undefined
      ? 'to_handle=?'
      : `(to_handle=? AND (json_extract(meta_json,'$.sender_instance') IS NULL OR json_extract(meta_json,'$.sender_instance') != ?))`
    const params = pollerInstance === undefined
      ? [team_id, since_id, to_handle, to_handle]
      : [team_id, since_id, to_handle, pollerInstance, to_handle]
    const rows = this.db.prepare(`
      SELECT id, v, team_id, from_handle, to_handle, subject, in_reply_to, thread_root,
             kind, content, meta_json, to_filter_json, sent_at, delivered_at
      FROM message
      WHERE team_id=? AND id > ? AND delivered_at IS NULL
        AND to_handle NOT LIKE '@mailbox:%'
        AND (${directClause} OR (to_handle='@team' AND from_handle != ?))
      ORDER BY id ASC LIMIT 1000
    `).all(...params) as EnvelopeRow[]
    return rows.map(envelopeFromRow)
  }

  /**
   * READ-ONLY cursored peek at the caller's durable inbox (poll_inbox, P2 §2.4).
   *
   * Deliberately NOT delivered_at-filtered and deliberately never stamping it:
   * a peek must not consume the cold-start backlog that a later SSE connect
   * relies on, and it must be idempotent so a harness can poll on a timer.
   * Same recipient predicate as fetchSince (direct rows plus @team from others).
   */
  // Same §4 self-exclusion as fetchSince (pollerInstance optional, back-compat when omitted).
  fetchInboxSince(team_id: string, to_handle: string, since_id: string, limit: number, pollerInstance?: string): Envelope[] {
    const directClause = pollerInstance === undefined
      ? 'to_handle=?'
      : `(to_handle=? AND (json_extract(meta_json,'$.sender_instance') IS NULL OR json_extract(meta_json,'$.sender_instance') != ?))`
    const params = pollerInstance === undefined
      ? [team_id, since_id, to_handle, to_handle, limit]
      : [team_id, since_id, to_handle, pollerInstance, to_handle, limit]
    const rows = this.db.prepare(`
      SELECT id, v, team_id, from_handle, to_handle, subject, in_reply_to, thread_root,
             kind, content, meta_json, to_filter_json, sent_at, delivered_at
      FROM message
      WHERE team_id=? AND id > ?
        AND to_handle NOT LIKE '@mailbox:%'
        AND (${directClause} OR (to_handle='@team' AND from_handle != ?))
      ORDER BY id ASC LIMIT ?
    `).all(...params) as EnvelopeRow[]
    return rows.map(envelopeFromRow)
  }

  markDelivered(id: string): void {
    this.db.prepare(
      "UPDATE message SET delivered_at=COALESCE(delivered_at,?) WHERE id=?"
    ).run(new Date().toISOString(), id)
  }

  // ---------------------------------------------------------------------
  // Reply routing (REPLY_ROUTING_SPEC.md §3.1, §8.1, §8.2). Route + grant
  // writes are synchronous, better-sqlite3-style methods so a caller (the
  // §3.2 send transaction, a later deliverable) can compose them inside one
  // db.transaction() alongside the message insert.
  // ---------------------------------------------------------------------

  insertRoute(route: ReplyRouteInput): void {
    this.db.prepare(`
      INSERT INTO reply_route(
        msg_id, team_id, from_handle, sender_instance, return_selector, to_handle,
        to_filter_json, thread_root, legacy_width, correlation_id, created_at, expires_at, unaddressable_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      route.msg_id, route.team_id, route.from_handle,
      route.sender_instance ?? null, route.return_selector ?? null,
      route.to_handle, route.to_filter_json ?? null, route.thread_root,
      route.legacy_width ?? null, route.correlation_id ?? null,
      route.created_at, route.expires_at ?? null, route.unaddressable_at ?? null
    )
  }

  /** One grant per snapshot entry (§3.2 step 3). Duplicate keys are ignored. */
  insertGrants(msg_id: string, grants: ReplyGrantInput[]): void {
    const stmt = this.db.prepare(
      'INSERT OR IGNORE INTO reply_grant(msg_id,handle,instance,selector) VALUES (?,?,?,?)'
    )
    for (const g of grants) stmt.run(msg_id, g.handle, g.instance, g.selector ?? '')
  }

  getRoute(msg_id: string): ReplyRoute | null {
    const row = this.db.prepare('SELECT * FROM reply_route WHERE msg_id=?').get(msg_id) as ReplyRoute | undefined
    return row ?? null
  }

  getRouteByCorrelation(correlation_id: string): ReplyRoute | null {
    const row = this.db.prepare(
      'SELECT * FROM reply_route WHERE correlation_id=?'
    ).get(correlation_id) as ReplyRoute | undefined
    return row ?? null
  }

  /** §3.4: a route with `expires_at` in the past is not live — unknown_parent. */
  getLiveRoute(msg_id: string, now: string): ReplyRoute | null {
    const route = this.getRoute(msg_id)
    if (!route) return null
    if (route.expires_at != null && route.expires_at < now) return null
    return route
  }

  /** §5.4 tombstone: set, never delete, so a later grant can still insert. */
  tombstoneRoute(msg_id: string, at: string): void {
    this.db.prepare('UPDATE reply_route SET unaddressable_at=? WHERE msg_id=?').run(at, msg_id)
  }

  hasGrant(msg_id: string, handle: string, instance: string, selector = ''): boolean {
    const row = this.db.prepare(
      'SELECT 1 AS x FROM reply_grant WHERE msg_id=? AND handle=? AND instance=? AND selector=?'
    ).get(msg_id, handle, instance, selector)
    return row != null
  }

  /**
   * §8.1 grant finalisation state machine. Runs in its own transaction so the
   * blank-grant replace (delete + insert) is atomic against a concurrent
   * finalise call: exact selector already granted → no-op ('exists'), and if
   * a stray blank grant also happens to be present beside it (e.g. a racing
   * finalise that never got cleaned up), the blank is deleted here too — it
   * must never survive once the target selector is confirmed granted, and
   * checking this FIRST (before the blank-replace branch below) avoids a
   * duplicate INSERT on reply_grant's PRIMARY KEY when both rows already
   * exist. Otherwise: blank exists → replace with the selector ('replaced');
   * a different non-blank grant for this (msg_id,handle,instance) already
   * exists → widen alongside it ('inserted'); otherwise → null (caller maps
   * to `grant_not_found`).
   */
  finalizeGrant(msg_id: string, handle: string, instance: string, selector: string): FinalizeGrantResult {
    return this.db.transaction((): FinalizeGrantResult => {
      const hasExact = (sel: string): boolean => this.db.prepare(
        'SELECT 1 AS x FROM reply_grant WHERE msg_id=? AND handle=? AND instance=? AND selector=?'
      ).get(msg_id, handle, instance, sel) != null
      const deleteBlank = (): void => {
        this.db.prepare(
          'DELETE FROM reply_grant WHERE msg_id=? AND handle=? AND instance=? AND selector=?'
        ).run(msg_id, handle, instance, '')
      }

      if (hasExact(selector)) {
        if (selector !== '' && hasExact('')) deleteBlank()
        return 'exists'
      }
      if (hasExact('')) {
        deleteBlank()
        this.db.prepare(
          'INSERT INTO reply_grant(msg_id,handle,instance,selector) VALUES (?,?,?,?)'
        ).run(msg_id, handle, instance, selector)
        return 'replaced'
      }
      const otherNonBlank = this.db.prepare(
        "SELECT 1 AS x FROM reply_grant WHERE msg_id=? AND handle=? AND instance=? AND selector != ''"
      ).get(msg_id, handle, instance)
      if (otherNonBlank != null) {
        this.db.prepare(
          'INSERT INTO reply_grant(msg_id,handle,instance,selector) VALUES (?,?,?,?)'
        ).run(msg_id, handle, instance, selector)
        return 'inserted'
      }
      return null
    })()
  }

  /**
   * §8.2 operator mailbox: pull-only, never fanned out, never stamps
   * `delivered_at`. Recipient predicate is exact `@mailbox:<handle>`, so this
   * intentionally never overlaps `fetchSince` / `fetchPendingSince` /
   * `fetchInboxSince`, which only ever match a bare handle or `@team`.
   */
  fetchMailboxSince(handle: string, since_id: string, limit: number): Envelope[] {
    const rows = this.db.prepare(`
      SELECT id, v, team_id, from_handle, to_handle, subject, in_reply_to, thread_root,
             kind, content, meta_json, to_filter_json, sent_at, delivered_at
      FROM message
      WHERE to_handle = ? AND id > ?
      ORDER BY id ASC LIMIT ?
    `).all(`@mailbox:${handle}`, since_id, limit) as EnvelopeRow[]
    return rows.map(envelopeFromMailboxRow)
  }
}
