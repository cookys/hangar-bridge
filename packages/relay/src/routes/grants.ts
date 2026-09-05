import { Hono } from 'hono'
import { z } from 'zod'
import {
  HANGAR_TEAM_ID,
  REPLY_ERROR_RETRYABLE,
  isValidMessageId, isValidInstanceId,
  type ReplyErrorCode,
} from '@hangar-bridge/shared'
import { bearerAuth, type AuthContext } from '../auth/middleware.ts'
import { rateLimit } from '../middleware/rate-limit.ts'
import { parseInstanceHeader } from '../presence/label.ts'
import type { Deps } from '../deps.ts'

/**
 * §8.1 return-selector grammar for a FINALISE body: exactly `<name>@<ULID>`
 * (never `~none`, never blank — those are header-only concepts on the
 * ORIGINAL send/reply, not a finalise target).
 */
const SELECTOR_NAME_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

function isValidFinaliseSelector(raw: string): boolean {
  const at = raw.indexOf('@')
  if (at <= 0) return false
  const name = raw.slice(0, at)
  const ulid = raw.slice(at + 1)
  return SELECTOR_NAME_REGEX.test(name) && isValidInstanceId(ulid)
}

const FinalizeBody = z.object({
  msg_id: z.string().refine(isValidMessageId, 'must be a valid message id'),
  selector: z.string().refine(isValidFinaliseSelector, "must be '<name>@<ULID>'"),
}).strict()

function errorBody(code: ReplyErrorCode, message: string): { error: string; message: string; retryable: boolean } {
  return { error: code, message, retryable: REPLY_ERROR_RETRYABLE[code] }
}

/**
 * REPLY_ROUTING_SPEC.md §8.1 "Grant finalisation": the courier calls this
 * under its OWN bearer + instance header, right before pasting a paragraph
 * into a pane, to replace the blank grant the send transaction gave it with
 * a selector-bearing one (or widen it to a further pane). See D2's
 * `MessageStore.finalizeGrant` for the full state machine (blank → replaced;
 * a further selector → inserted; exact selector already present → exists;
 * neither → null, mapped here to 404 `grant_not_found`).
 */
export function grantsRoute(deps: Deps) {
  const app = new Hono<{ Variables: AuthContext }>()
  app.use('*', bearerAuth(deps.db))
  app.use('*', rateLimit({ windowMs: 60_000, max: 120, key: c => `grants:${c.get('token').id}` }))

  app.post('/finalize', async c => {
    const parsedInstance = parseInstanceHeader(c.req.header('x-hangar-instance'))
    if (!parsedInstance.ok || parsedInstance.instance === undefined) {
      return c.json(errorBody(
        'instance_required',
        'x-hangar-instance is required to identify the courier instance finalising this grant'
      ), 400)
    }

    const raw = await c.req.json().catch(() => null)
    const parsed = FinalizeBody.safeParse(raw)
    if (!parsed.success) {
      return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400)
    }
    const { msg_id, selector } = parsed.data
    const handle = c.get('peer').handle
    const instance = parsedInstance.instance

    const outcome = deps.store.finalizeGrant(msg_id, handle, instance, selector)
    if (outcome === null) {
      return c.json(errorBody(
        'grant_not_found',
        'neither a blank nor any non-blank grant exists for (msg_id, handle, courier instance)'
      ), 404)
    }
    return c.json({ msg_id, selector, outcome }, 200)
  })

  return app
}
