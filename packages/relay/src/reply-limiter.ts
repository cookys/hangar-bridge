import type { Db } from './db/db.ts'

/**
 * REPLY_ROUTING_SPEC.md §12 tunables. Kept local because @hangar-bridge/shared
 * does not export a reply-limiter constant yet (D1, in flight in parallel) —
 * same numbers, defined here so this deliverable does not depend on it.
 */
export const REPLY_LIMITER_DEFAULTS = {
  maxPerWindow: 10,
  windowMs: 10 * 60 * 1000,
} as const

export type TryAcquireResult = { ok: true } | { ok: false; retry_after_s: number }

export interface ReplyLimiterOptions {
  maxPerWindow?: number
  windowMs?: number
}

/**
 * REPLY_ROUTING_SPEC.md §9 — relay-side reply limiter. Keyed on
 * (thread_root, replier handle): the handle because it is the only
 * unforgeable dimension, the thread because each reply mints a new route
 * and a per-route limit would never trip on a ping-pong. Fixed window,
 * survives a relay restart because the count is a row, not memory.
 */
export class ReplyLimiter {
  constructor(private readonly db: Db) {}

  /**
   * One statement: `INSERT … ON CONFLICT DO UPDATE SET count = count + 1
   * WHERE count < maxPerWindow`. `changes === 1` iff the insert or the
   * conditional update actually happened — the `WHERE` guard is what makes
   * a concurrent acquisition at the boundary resolve to exactly one winner.
   */
  tryAcquire(
    thread_root: string,
    handle: string,
    nowMs: number,
    opts: ReplyLimiterOptions = {}
  ): TryAcquireResult {
    const maxPerWindow = opts.maxPerWindow ?? REPLY_LIMITER_DEFAULTS.maxPerWindow
    const windowMs = opts.windowMs ?? REPLY_LIMITER_DEFAULTS.windowMs
    const windowStartMs = Math.floor(nowMs / windowMs) * windowMs
    const windowStart = new Date(windowStartMs).toISOString()

    const info = this.db.prepare(`
      INSERT INTO reply_limiter (thread_root, handle, window_start, count)
      VALUES (?, ?, ?, 1)
      ON CONFLICT (thread_root, handle, window_start)
      DO UPDATE SET count = count + 1 WHERE count < ?
    `).run(thread_root, handle, windowStart, maxPerWindow)

    if (info.changes === 1) return { ok: true }
    const retry_after_s = Math.ceil((windowStartMs + windowMs - nowMs) / 1000)
    return { ok: false, retry_after_s }
  }
}
