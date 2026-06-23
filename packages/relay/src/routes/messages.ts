import { Hono } from 'hono'
import {
  HANGAR_TEAM_ID,
  OutboundMessageSchema,
  RESERVED_META_KEYS,
  TEAM_BROADCAST_HANDLE,
  type Envelope,
} from '@hangar-bridge/shared'
import { loadOwnedSet, ownsNamespace } from '../acl.ts'
import { bearerAuth, type AuthContext } from '../auth/middleware.ts'
import { hashToken } from '../auth/hash.ts'
import { rateLimit } from '../middleware/rate-limit.ts'
import type { Deps } from '../deps.ts'

export function messagesRoute(deps: Deps) {
  const app = new Hono<{ Variables: AuthContext }>()
  app.use('*', bearerAuth(deps.db))
  app.use('*', rateLimit({ windowMs: 60_000, max: 120, key: c => `msg:${c.get('token').id}` }))

  app.post('/', async c => {
    const idemKey = c.req.header('idempotency-key')
    const tokenId = c.get('token').id
    if (idemKey) {
      const row = deps.db.prepare(
        "SELECT response_json FROM idempotency_key WHERE key_hash=? AND token_id=?"
      ).get(hashToken(`${tokenId}:${idemKey}`), tokenId) as { response_json: string } | undefined
      if (row) return c.body(row.response_json, 201, { 'content-type': 'application/json' })
    }

    const raw = await c.req.json().catch(() => null)
    const parsed = OutboundMessageSchema.safeParse(raw)
    if (!parsed.success) {
      return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400)
    }
    const data = parsed.data
    const peer = c.get('peer')

    // B1: strip reserved meta keys (subject, kind) so a sender can NEVER forge a
    // relay signal into a channel notification. The only subject a receiver sees is
    // the relay-stamped envelope field (surfaced as `gated_subject`), never sender
    // meta. (task_kind is intentionally NOT reserved — a benign display label.)
    if (data.meta) {
      for (const k of RESERVED_META_KEYS) delete (data.meta as Record<string, string>)[k]
    }

    // Fail-closed namespace ACL — gate on SUBJECT PRESENCE, not a kind allow-list.
    // A non-null subject is only meaningful on a command-carrying kind; a subjected
    // reactive/system kind (presence_update/permission_*/task_result) is rejected
    // outright, else a non-owner could smuggle a gated_subject via e.g. a subjected
    // presence_update and bypass the ownership check entirely. subject!=null ⇒ `to`
    // is a concrete handle (schema direct-only refine), so the cast below is safe.
    if (data.subject != null) {
      if (data.kind !== 'chat' && data.kind !== 'task_dispatch') {
        return c.json({ error: 'invalid_message', message: 'subject_not_allowed_for_kind' }, 400)
      }
      const ownedPub = loadOwnedSet(deps.db, HANGAR_TEAM_ID, peer.handle)
      if (!ownsNamespace(data.subject, ownedPub)) {
        auditSubjectDenied(deps, peer.id, 'subject.publish_denied', { subject: data.subject, handle: peer.handle })
        return c.json({ error: 'forbidden_subject' }, 403)
      }
      const ownedRcpt = loadOwnedSet(deps.db, HANGAR_TEAM_ID, data.to as string)
      if (!ownsNamespace(data.subject, ownedRcpt)) {
        auditSubjectDenied(deps, peer.id, 'subject.recipient_denied', { subject: data.subject, to: data.to as string })
        return c.json({ error: 'recipient_not_owner' }, 409)
      }
    }

    // Layer 2 (sender-stamp anti-spoof): `from` is the bearer-authenticated
    // peer handle from middleware. Client-supplied `from` (if any) is ignored.
    let envelope: Envelope
    try {
      envelope = deps.store.insert(HANGAR_TEAM_ID, peer.handle, data)
    } catch (err) {
      const message = err instanceof Error ? err.message : ''
      return c.json({ error: 'invalid_message', message }, 400)
    }

    deps.fanout.deliver(envelope)
    // Delivered-tracking (B4/R4): for SUBJECTED messages the stream write loop is
    // the sole authority (marks delivered_at only AFTER a successful writeSSE), so
    // do NOT stamp on enqueue here — else a stream abort between enqueue and write
    // silently loses a single-copy message. null-subject keeps the online optimisation.
    if (envelope.subject === null) {
      const isDelivered = envelope.to === TEAM_BROADCAST_HANDLE
        ? deps.fanout.onlineHandles(envelope.team).some(h => h !== envelope.from)
        : deps.fanout.isOnline(envelope.team, envelope.to)
      if (isDelivered) {
        deps.store.markDelivered(envelope.id)
        envelope = { ...envelope, delivered_at: deps.now().toISOString() }
      }
    }

    const responseJson = JSON.stringify(envelope)
    if (idemKey) {
      deps.db.prepare(`
        INSERT OR IGNORE INTO idempotency_key(key_hash, token_id, response_json, created_at)
        VALUES (?, ?, ?, ?)
      `).run(hashToken(`${tokenId}:${idemKey}`), tokenId, responseJson, deps.now().toISOString())
    }
    return c.body(responseJson, 201, { 'content-type': 'application/json' })
  })

  return app
}

/** Record a subject-ACL denial (not silent — the authoritative denial trail). */
function auditSubjectDenied(
  deps: Deps, actorHumanId: string, event: string, detail: Record<string, string>
): void {
  deps.db.prepare(
    'INSERT INTO audit_log(team_id,at,actor_human_id,event,detail_json) VALUES (?,?,?,?,?)'
  ).run(HANGAR_TEAM_ID, deps.now().toISOString(), actorHumanId, event, JSON.stringify(detail))
}
