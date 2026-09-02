import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { HANGAR_TEAM_ID, isValidMessageId, INTEREST_REGEX, type Envelope } from '@hangar-bridge/shared'
import { bearerAuth, type AuthContext } from '../auth/middleware.ts'
import { loadOwnedSet, ownsNamespace, matchesInterest } from '../acl.ts'
import type { Deps } from '../deps.ts'
import type { Subscriber } from '../fanout.ts'
import { logJson } from '../logger.ts'
import { effectiveLabel, parseInstanceHeader } from '../presence/label.ts'
import { ConnectionRegistry } from '../presence/connections.ts'

const PING_INTERVAL_MS = 25_000
const BACKLOG_PAGE = 1000
// Cap the per-connection backlog/live dedupe set so a long-lived SSE on a busy
// handle cannot grow it without bound (this is the shared multi-tenant relay).
const SEEN_CAP = 8192

export function streamRoute(deps: Deps) {
  const app = new Hono<{ Variables: AuthContext }>()
  app.use('*', bearerAuth(deps.db))

  // One refcount table per relay process. A presence row is removed only when the
  // LAST SSE connection for its (handle, effectiveLabel) closes, which is what makes
  // an overlapping reconnect safe.
  const connections = new ConnectionRegistry()

  app.get('/', c => {
    const since = c.req.query('since')
    if (since !== undefined && !isValidMessageId(since)) {
      return c.json({ error: 'invalid_since' }, 400)
    }
    // Per-process instance id, constant across this process's reconnects. Absent ⇒
    // legacy client keyed on the bare token label (unchanged behavior).
    const parsedInstance = parseInstanceHeader(c.req.header('x-hangar-instance'))
    if (!parsedInstance.ok) return c.json({ error: 'invalid_instance' }, 400)
    const instance = parsedInstance.instance

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
      // Presence label for THIS connection (same resolver POST /v1/presence writes
      // with). Hoisted above `deliverable` so the to_filter{repo} check can read
      // this session's live repo from the presence registry at delivery time.
      const presenceLabel = effectiveLabel(c.get('token').label, instance)

      // The single per-recipient gate, applied to BOTH backlog and live, keyed on
      // the authenticated handle. null-subject ⇒ pass (back-compat). Ownership is
      // the fail-closed authority; interest only narrows within owned.
      const deliverable = (e: Envelope): boolean => {
        // Apply self-exclusion to the durable drain too. Live delivery already
        // excludes this instance in Fanout; without this check a message queued
        // while offline echoes back on the sender process's next cold start.
        if (
          e.from === handle
          && instance !== undefined
          && e.meta['sender_instance'] === instance
        ) return false
        // to_filter: presence-backed audience narrowing (v1 instance|repo). A
        // filtered message reaches ONLY sessions matching every set key. instance
        // is compared to this connection's instance; repo is read live from the
        // registry (single SoT). A legacy connection (no instance) fails an
        // instance filter fail-closed. All to_filter fields are AND-ed.
        if (e.to_filter != null) {
          if (e.to_filter.instance !== undefined && e.to_filter.instance !== instance) return false
          if (e.to_filter.repo !== undefined
            && deps.presence.repoOf(team_id, handle, presenceLabel) !== e.to_filter.repo) return false
        }
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
      // Set when a newer connection from the same instance supersedes this one
      // (Fanout.evictSuperseded). The read loop exits, cleanup runs, and the
      // response ends — the client that still had this socket open sees EOF.
      let superseded = false
      const sub: Subscriber = {
        handle,
        team_id,
        instance,
        accept: deliverable,
        deliver: (e: Envelope) => { queue.push(e); notify?.() },
        close: () => { superseded = true; notify?.() },
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

      // presenceLabel derived above (hoisted for the to_filter{repo} gate). The SAME
      // resolver POST /v1/presence uses to WRITE the row, so acquire and release can
      // never disagree.
      connections.acquire(team_id, handle, presenceLabel)
      // Only now — with this connection's refcount held — end any earlier
      // stream this instance left open, so the presence row never drops to
      // zero in between. One process, one stream (see Fanout.evictSuperseded).
      const evicted = deps.fanout.evictSuperseded(sub)
      if (evicted > 0) {
        logJson('warn', 'relay.stream.superseded', { handle, instance: instance ?? '', evicted })
      }

      // This connection has TWO cleanup paths — the abort listener below and the
      // `finally` of the read loop — and both can fire for one connection. Without
      // this guard the refcount would be decremented twice and a SIBLING
      // connection's presence row would be removed while it is still live.
      let cleanedUp = false
      const cleanup = () => {
        if (cleanedUp) return
        cleanedUp = true
        deps.fanout.unsubscribe(sub)
        clearInterval(pingTimer)
        // Reflect offline immediately on a clean disconnect rather than waiting out the
        // presence TTL — but only once the LAST connection for this instance is gone.
        // TTL remains the backstop for an unclean disconnect (crash) that never reaches
        // this cleanup.
        //
        // ACCEPTED RESIDUAL (plan §P2): a heartbeat POST /v1/presence already in flight
        // when this runs can re-create the row afterwards; it then ages out via the
        // 90s presence TTL. Bounded and self-healing; not worth a write barrier.
        if (connections.release(team_id, handle, presenceLabel)) {
          deps.presence.remove(team_id, handle, presenceLabel)
        }
      }
      c.req.raw.signal?.addEventListener('abort', cleanup)

      try {
        while (!c.req.raw.signal?.aborted && !superseded) {
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
        // A superseded stream must not silently swallow what was queued for it:
        // it was evicted from the fanout set already, so anything still here
        // arrived before the eviction. Hand it to the newer stream.
        if (superseded && queue.length > 0) {
          for (const e of queue.splice(0)) deps.fanout.deliver(e)
        }
      } finally {
        cleanup()
      }
    })
  })
  return app
}
