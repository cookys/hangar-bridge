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

  fetchSince(team_id: string, to_handle: string, since_id: string): Envelope[] {
    const rows = this.db.prepare(`
      SELECT id, v, team_id, from_handle, to_handle, subject, in_reply_to, thread_root,
             kind, content, meta_json, to_filter_json, sent_at, delivered_at
      FROM message
      WHERE team_id=? AND id > ?
        AND (to_handle=? OR (to_handle='@team' AND from_handle != ?))
      ORDER BY id ASC LIMIT 1000
    `).all(team_id, since_id, to_handle, to_handle) as EnvelopeRow[]
    return rows.map(envelopeFromRow)
  }

  // Cold-start pending drain, CURSORED so the caller can page through with a
  // monotonic id cursor (start since_id='') and never get stuck on a full page of
  // non-deliverable (interest-narrowed, delivered_at=NULL) rows at the front of the
  // window — the single-shot variant could permanently starve deliverable rows past
  // position 1000 (B3 black hole).
  fetchPendingSince(team_id: string, to_handle: string, since_id: string): Envelope[] {
    const rows = this.db.prepare(`
      SELECT id, v, team_id, from_handle, to_handle, subject, in_reply_to, thread_root,
             kind, content, meta_json, to_filter_json, sent_at, delivered_at
      FROM message
      WHERE team_id=? AND id > ? AND delivered_at IS NULL
        AND (to_handle=? OR (to_handle='@team' AND from_handle != ?))
      ORDER BY id ASC LIMIT 1000
    `).all(team_id, since_id, to_handle, to_handle) as EnvelopeRow[]
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
  fetchInboxSince(team_id: string, to_handle: string, since_id: string, limit: number): Envelope[] {
    const rows = this.db.prepare(`
      SELECT id, v, team_id, from_handle, to_handle, subject, in_reply_to, thread_root,
             kind, content, meta_json, to_filter_json, sent_at, delivered_at
      FROM message
      WHERE team_id=? AND id > ?
        AND (to_handle=? OR (to_handle='@team' AND from_handle != ?))
      ORDER BY id ASC LIMIT ?
    `).all(team_id, since_id, to_handle, to_handle, limit) as EnvelopeRow[]
    return rows.map(envelopeFromRow)
  }

  markDelivered(id: string): void {
    this.db.prepare(
      "UPDATE message SET delivered_at=COALESCE(delivered_at,?) WHERE id=?"
    ).run(new Date().toISOString(), id)
  }
}
