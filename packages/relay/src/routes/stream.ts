import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { HANGAR_TEAM_ID, isValidMessageId, INTEREST_REGEX, type Envelope } from '@hangar-bridge/shared'
import { bearerAuth, type AuthContext } from '../auth/middleware.ts'
import { loadOwnedSet, ownsNamespace, matchesInterest } from '../acl.ts'
import type { Deps } from '../deps.ts'
import type { Subscriber } from '../fanout.ts'

const PING_INTERVAL_MS = 25_000
const BACKLOG_PAGE = 1000
// Cap the per-connection backlog/live dedupe set so a long-lived SSE on a busy
// handle cannot grow it without bound (this is the shared multi-tenant relay).
const SEEN_CAP = 8192

export function streamRoute(deps: Deps) {
  const app = new Hono<{ Variables: AuthContext }>()
  app.use('*', bearerAuth(deps.db))

  app.get('/', c => {
    const since = c.req.query('since')
    if (since !== undefined && !isValidMessageId(since)) {
      return c.json({ error: 'invalid_since' }, 400)
    }
    // Optional interest narrowing. Header (set by undici fetch) takes precedence
    // over query param. Comma-separated. Interest can only NARROW within owned
    // namespaces; it is NOT the authority gate (ownership is — see below).
    const rawInterest = c.req.header('x-hangar-subjects') ?? c.req.query('subjects')
    let interest: string[] = []
    if (rawInterest) {
      interest = rawInterest.split(',').map(s => s.trim()).filter(Boolean)
      if (!interest.every(s => INTEREST_REGEX.test(s))) {
        return c.json({ error: 'invalid_subjects' }, 400)
      }
    }

    return streamSSE(c, async stream => {
      const team_id = HANGAR_TEAM_ID
      const handle = c.get('peer').handle
      // Owned-set read ONCE per connection (M1): re-seed only happens at relay
      // startup, which drops all SSE streams, so a live mid-stream ownership change
      // cannot occur — no per-delivery re-read / generation counter needed.
      const owned = loadOwnedSet(deps.db, team_id, handle)

      // The single per-recipient gate, applied to BOTH backlog and live, keyed on
      // the authenticated handle. null-subject ⇒ pass (back-compat). Ownership is
      // the fail-closed authority; interest only narrows within owned.
      const deliverable = (e: Envelope): boolean => {
        if (e.subject === null) return true
        if (!ownsNamespace(e.subject, owned)) return false
        if (interest.length > 0) return matchesInterest(e.subject, interest)
        return true
      }

      const seen = new Set<string>()
      // Bounded FIFO eviction: dedupe only needs the connect-window (backlog vs live);
      // once drained, live ids are strictly newer, so evicting the oldest is safe.
      const markSeen = (id: string) => {
        if (seen.size >= SEEN_CAP) {
          const oldest = seen.values().next().value
          if (oldest !== undefined) seen.delete(oldest)
        }
        seen.add(id)
      }
      const queue: Envelope[] = []
      let notify: (() => void) | null = null
      const sub: Subscriber = {
        handle,
        team_id,
        accept: deliverable,
        deliver: (e: Envelope) => { queue.push(e); notify?.() }
      }
      // Subscribe BEFORE backlog drain so a message landing in the connect window
      // is buffered (not lost); dedupe-by-id prevents a backlog+live double-send.
      deps.fanout.subscribe(sub)

      const writeAndMark = async (e: Envelope) => {
        await stream.writeSSE({ event: 'message', data: JSON.stringify(e) })
        deps.store.markDelivered(e.id)
        markSeen(e.id)
      }

      // Backlog. since-resume uses the id cursor only (no delivered_at filter — B3,
      // preserves @team multi-recipient redelivery), draining pages until < BACKLOG_PAGE
      // so a JS-filtered page can't strand the recipient below the live edge.
      // Both branches drain in a monotonic id-cursor loop, advancing the cursor on
      // EVERY page (deliverable or not) so a full page of non-deliverable rows can
      // never starve deliverable rows behind it (B3). since-resume = id>cursor only
      // (client cursor is the dedup authority, preserves @team redelivery); cold-start
      // = id>cursor AND delivered_at IS NULL (pending-only).
      const drain = since
        ? (cur: string) => deps.store.fetchSince(team_id, handle, cur)
        : (cur: string) => deps.store.fetchPendingSince(team_id, handle, cur)
      let cursor: string = since ?? ''
      for (;;) {
        const page = drain(cursor)
        if (page.length === 0) break
        for (const e of page) if (deliverable(e) && !seen.has(e.id)) await writeAndMark(e)
        cursor = page[page.length - 1]!.id
        if (page.length < BACKLOG_PAGE) break
      }

      const pingTimer = setInterval(() => {
        stream.writeSSE({ event: 'ping', data: String(Date.now()) }).catch(() => { /* client gone */ })
      }, PING_INTERVAL_MS)

      const cleanup = () => {
        deps.fanout.unsubscribe(sub)
        clearInterval(pingTimer)
        // Reflect offline immediately on a clean disconnect rather than waiting out the
        // presence TTL. Keyed on the same (team, handle, label) tuple presence.set uses;
        // label is this SSE connection's token label. TTL remains the backstop for an
        // unclean disconnect (crash) that never reaches this cleanup.
        deps.presence.remove(team_id, handle, c.get('token').label)
      }
      c.req.raw.signal?.addEventListener('abort', cleanup)

      try {
        while (!c.req.raw.signal?.aborted) {
          if (queue.length === 0) {
            await new Promise<void>(resolve => {
              notify = () => { notify = null; resolve() }
            })
            continue
          }
          const e = queue.shift()!
          if (seen.has(e.id)) continue
          await stream.writeSSE({ event: 'message', data: JSON.stringify(e) })
          deps.store.markDelivered(e.id)
          markSeen(e.id)
        }
      } finally {
        cleanup()
      }
    })
  })
  return app
}
