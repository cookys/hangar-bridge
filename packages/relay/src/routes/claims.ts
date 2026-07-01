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

const KeySchema = z.string().max(MAX_CLAIM_KEY_LENGTH).regex(CLAIM_KEY_REGEX)

const AcquireBody = z.object({
  key: KeySchema,
  ttl_seconds: z.number().int().min(CLAIM_TTL_MIN_SECONDS).max(CLAIM_TTL_MAX_SECONDS)
    .default(CLAIM_DEFAULT_TTL_SECONDS),
  note: z.string().max(MAX_CLAIM_NOTE_LENGTH).optional(),
}).strict()

const ReleaseBody = z.object({ key: KeySchema }).strict()

export function claimsRoute(deps: Deps) {
  const app = new Hono<{ Variables: AuthContext }>()
  app.use('*', bearerAuth(deps.db))
  app.use('*', rateLimit({ windowMs: 60_000, max: 120, key: c => `claim:${c.get('token').id}` }))

  // Acquire or renew a claim.
  app.post('/', async c => {
    const parsed = AcquireBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400)
    const owner = c.get('peer').handle
    const label = c.get('token').label
    const { key, ttl_seconds, note } = parsed.data
    const r = deps.claims.acquire(HANGAR_TEAM_ID, key, owner, label, ttl_seconds, note ?? null)
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
    return c.json(deps.claims.list(HANGAR_TEAM_ID))
  })

  // Release a claim (owner-only). Two shapes, same handler:
  //   POST /v1/claim/release  (CANONICAL — a request body on POST is universally sent/parsed)
  //   DELETE /v1/claim         (compat — some clients/proxies drop DELETE bodies, so the POST
  //                             form above is what the peer-agent uses; DELETE stays for callers
  //                             that prefer REST verbs and can send a DELETE body reliably)
  const release = async (c: Context<{ Variables: AuthContext }>) => {
    const parsed = ReleaseBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400)
    const owner = c.get('peer').handle
    const r = deps.claims.release(HANGAR_TEAM_ID, parsed.data.key, owner)
    if (!r.ok) {
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
