import { Hono, type Context } from 'hono'
import { z } from 'zod'
import {
  HANGAR_TEAM_ID,
  CLAIM_KEY_REGEX, MAX_CLAIM_KEY_LENGTH, MAX_CLAIM_NOTE_LENGTH,
  CLAIM_TTL_MIN_SECONDS, CLAIM_TTL_MAX_SECONDS, CLAIM_DEFAULT_TTL_SECONDS,
} from '@hangar-bridge/shared'
import { bearerAuth, type AuthContext } from '../auth/middleware.ts'
import { rateLimit } from '../middleware/rate-limit.ts'
import type { Deps } from '../deps.ts'
import { loadDefaultGroup, loadMemberships, requireCap } from '../groups.ts'

const KeySchema = z.string().max(MAX_CLAIM_KEY_LENGTH).regex(CLAIM_KEY_REGEX)

const AcquireBody = z.object({
  key: KeySchema,
	  ttl_seconds: z.number().int().min(CLAIM_TTL_MIN_SECONDS).max(CLAIM_TTL_MAX_SECONDS)
	    .default(CLAIM_DEFAULT_TTL_SECONDS),
	  note: z.string().max(MAX_CLAIM_NOTE_LENGTH).optional(),
	  group: z.string().optional(),
	}).strict()

const ReleaseBody = z.object({ key: KeySchema, group: z.string().optional() }).strict()

function auditEvent(deps: Deps, actorHumanId: string, event: string, detail: Record<string, string>): void {
  deps.db.prepare(
    'INSERT INTO audit_log(team_id,at,actor_human_id,event,detail_json) VALUES (?,?,?,?,?)'
  ).run(HANGAR_TEAM_ID, deps.now().toISOString(), actorHumanId, event, JSON.stringify(detail))
}

export function claimsRoute(deps: Deps) {
  const app = new Hono<{ Variables: AuthContext }>()
  app.use('*', bearerAuth(deps.db))
  app.use('*', rateLimit({ windowMs: 60_000, max: 120, key: c => `claim:${c.get('token').id}` }))

  // Acquire or renew a claim.
  app.post('/', async c => {
    const parsed = AcquireBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400)
	    const peer = c.get('peer')
	    const owner = peer.handle
	    const label = c.get('token').label
	    const { key, ttl_seconds, note } = parsed.data
	    const group = (deps.groupsMode ?? 'legacy') === 'strict'
	      ? (parsed.data.group ?? loadDefaultGroup(deps.db, owner))
	      : 'cookys'
	    const memberships = loadMemberships(deps.db, owner)
	    const cap = (deps.groupsMode ?? 'legacy') === 'strict' ? requireCap(memberships, group, 'claim') : 'ok'
	    if (cap === 'unknown_group') {
	      auditEvent(deps, peer.id, 'group.unknown_group', { group_id: group, handle: owner })
	      return c.json({ error: 'unknown_group' }, 404)
	    }
	    if (cap === 'cap_denied') {
	      auditEvent(deps, peer.id, 'group.cap_denied', { group_id: group, handle: owner, cap: 'claim' })
	      return c.json({ error: 'cap_denied' }, 403)
	    }
	    const r = deps.claims.acquire(HANGAR_TEAM_ID, group, key, owner, label, ttl_seconds, note ?? null)
    if (!r.ok) {
      return c.json({
        error: 'claim_conflict',
        owner: r.conflict.owner_handle,
        expires_at: r.conflict.expires_at,
      }, 409)
    }
    return c.json({ claim: r.claim, renewed: r.renewed }, 201)
  })

	  // List all live claims.
	  app.get('/', c => {
	    if ((deps.groupsMode ?? 'legacy') !== 'strict') return c.json(deps.claims.list(HANGAR_TEAM_ID))
	    const memberships = loadMemberships(deps.db, c.get('peer').handle)
	    return c.json(deps.claims.list(HANGAR_TEAM_ID, [...memberships.keys()]))
	  })

  // Release a claim (owner-only). Two shapes, same handler:
  //   POST /v1/claim/release  (CANONICAL — a request body on POST is universally sent/parsed)
  //   DELETE /v1/claim         (compat — some clients/proxies drop DELETE bodies, so the POST
  //                             form above is what the peer-agent uses; DELETE stays for callers
  //                             that prefer REST verbs and can send a DELETE body reliably)
  const release = async (c: Context<{ Variables: AuthContext }>) => {
    const parsed = ReleaseBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400)
	    const peer = c.get('peer')
	    const owner = peer.handle
	    const group = (deps.groupsMode ?? 'legacy') === 'strict'
	      ? (parsed.data.group ?? loadDefaultGroup(deps.db, owner))
	      : 'cookys'
	    const memberships = loadMemberships(deps.db, owner)
	    const cap = (deps.groupsMode ?? 'legacy') === 'strict' ? requireCap(memberships, group, 'claim') : 'ok'
	    if (cap === 'unknown_group') {
	      auditEvent(deps, peer.id, 'group.unknown_group', { group_id: group, handle: owner })
	      return c.json({ error: 'unknown_group' }, 404)
	    }
	    if (cap === 'cap_denied') {
	      auditEvent(deps, peer.id, 'group.cap_denied', { group_id: group, handle: owner, cap: 'claim' })
	      return c.json({ error: 'cap_denied' }, 403)
	    }
	    const r = deps.claims.release(HANGAR_TEAM_ID, group, parsed.data.key, owner)
	    if (!r.ok) {
	      if ((deps.groupsMode ?? 'legacy') === 'strict') return c.json({ released: false })
	      return c.json({
        error: 'claim_conflict',
        owner: r.conflict.owner_handle,
        expires_at: r.conflict.expires_at,
      }, 409)
    }
    return c.json({ released: r.released })
  }
  app.post('/release', release)
  app.delete('/', release)

  return app
}
