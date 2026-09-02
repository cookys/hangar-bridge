import { Hono } from 'hono'
import { z } from 'zod'
import { HANGAR_TEAM_ID, TEAM_BROADCAST_HANDLE, isValidInstanceId } from '@hangar-bridge/shared'
import { bearerAuth, type AuthContext } from '../auth/middleware.ts'
import { rateLimit } from '../middleware/rate-limit.ts'
import type { Deps } from '../deps.ts'
import { effectiveLabel } from '../presence/label.ts'

const PresenceBody = z.object({
  summary: z.string().max(200),
  // Per-PROCESS instance id. Absent ⇒ legacy client, keyed on the bare token
  // label exactly as before. Validated here so a client-supplied string can
  // never be composed into a registry key unchecked.
  instance: z.string().refine(isValidInstanceId, 'invalid_instance').optional(),
  cwd: z.string().max(1024).optional(),
  branch: z.string().max(256).optional(),
  repo: z.string().max(256).optional(),
  // A switchboard courier serves every project it holds a local registration
  // for; a project-scoped send matches it on any of these (see registry
  // matchesRepo). Bounded: one box does not have 65 projects open.
  repos: z.array(z.string().min(1).max(256)).max(64).optional(),
  worktree: z.string().max(256).optional(),
  delivery_state: z.enum(['unverified', 'verified', 'deaf']).optional(),
  caps: z.string().max(200).optional(),
})

export function presenceRoute(deps: Deps) {
  const app = new Hono<{ Variables: AuthContext }>()
  app.use('*', bearerAuth(deps.db))
  // P2: one shared per-host secret now backs SEVERAL peer-agent processes, so this
  // bucket is shared by every instance on the box. A 1/s cap made two sessions
  // reconnecting at the same moment drop one another's presence report. The budget
  // is per token, not per instance, because the instance id lives in the body and
  // is not available to middleware.
  app.use('*', rateLimit({ windowMs: 1_000, max: 4, key: c => `pres:${c.get('token').id}` }))
  app.post('/', async c => {
    const parsed = PresenceBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid_body' }, 400)
    const team = HANGAR_TEAM_ID
    const handle = c.get('peer').handle
    // Same resolver the SSE cleanup path uses — the write key and the delete
    // key must be derived identically or a disconnect erases a live row.
    const label = effectiveLabel(c.get('token').label, parsed.data.instance)
    deps.presence.set(team, handle, label, parsed.data)

    const meta: Record<string, string> = { label }
    if (parsed.data.instance !== undefined) meta.instance = parsed.data.instance
    if (parsed.data.cwd !== undefined) meta.cwd = parsed.data.cwd
    if (parsed.data.branch !== undefined) meta.branch = parsed.data.branch
    if (parsed.data.repo !== undefined) meta.repo = parsed.data.repo
    if (parsed.data.repos !== undefined) meta.repos = parsed.data.repos.join(',')
    if (parsed.data.worktree !== undefined) meta.worktree = parsed.data.worktree
    if (parsed.data.delivery_state !== undefined) meta.delivery_state = parsed.data.delivery_state
    if (parsed.data.caps !== undefined) meta.caps = parsed.data.caps

    // A heartbeat is a liveness signal, not a message: build the envelope for live
    // fanout but do NOT persist it. The durable buffer exists so an offline peer
    // misses nothing, and a heartbeat is not in that contract — a peer coming back
    // reads current truth from /v1/peers, and a three-day-old "(connected)" tells it
    // nothing. Persisting them made presence 99.3% of the buffer (measured
    // 2026-08-31: 8301 rows against 59 substantive), which buried real traffic deep
    // enough that poll_inbox could only prove the link was alive — not what it is
    // for. The registry set() above remains the authority for who is online.
    const envelope = deps.store.buildEnvelope(team, handle, {
      to: TEAM_BROADCAST_HANDLE,
      subject: null,
      kind: 'presence_update',
      content: parsed.data.summary,
      meta,
    })
    deps.fanout.deliver(envelope)
    return c.json({ ok: true })
  })
  return app
}
