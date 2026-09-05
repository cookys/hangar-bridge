import type { Db } from './db/db.ts'
import { logJson } from './logger.ts'
import { REPLY_LIMITER_DEFAULTS } from './reply-limiter.ts'

export interface PurgeResult {
  handles: string[]
}

export interface ReplyStatePurgeResult {
  limiterRows: number
  routes: number
}

/**
 * REPLY_ROUTING_SPEC.md §9 / §12 — sweeps reply-routing state that has aged
 * out: `reply_limiter` rows older than two fixed windows (a window boundary
 * already resets the count; nothing needs a row past that), and
 * `reply_route` rows whose `expires_at` has passed (ephemeral + legacy
 * routes, §3.4) — their grants cascade via `ON DELETE CASCADE`. A route
 * with `expires_at IS NULL` (a durable message row) is never swept here.
 */
export function purgeReplyState(
  db: Db,
  nowMs: number,
  opts: { windowMs?: number } = {}
): ReplyStatePurgeResult {
  const windowMs = opts.windowMs ?? REPLY_LIMITER_DEFAULTS.windowMs
  const limiterCutoff = new Date(nowMs - 2 * windowMs).toISOString()
  const nowIso = new Date(nowMs).toISOString()
  const limiterInfo = db.prepare('DELETE FROM reply_limiter WHERE window_start < ?').run(limiterCutoff)
  const routeInfo = db.prepare(
    'DELETE FROM reply_route WHERE expires_at IS NOT NULL AND expires_at < ?'
  ).run(nowIso)
  return { limiterRows: limiterInfo.changes, routes: routeInfo.changes }
}

/**
 * Hard-deletes users with last_active_at older than `cutoffIso`.
 *
 * Safety rails:
 * - Users who currently hold an active admin-tier token are NEVER purged,
 *   even if inactive — losing the sole admin would leave the team orphaned.
 * - Single transaction per team so the sweep is atomic.
 * - Audit log gets a `user.purge` event per deleted handle BEFORE the row
 *   vanishes so the FK reference stays valid.
 */
export function purgeInactive(
  db: Db,
  teamId: string,
  cutoffIso: string,
  actorHumanId: string | null,
  nowIso: string,
): PurgeResult {
  // Pick candidates: users inactive past cutoff who don't hold an active
  // admin-tier token. The NOT EXISTS clause keeps team admins safe.
  const candidates = db.prepare(`
    SELECT h.id, h.handle
    FROM human h
    WHERE h.team_id = ?
      AND (h.last_active_at IS NULL OR h.last_active_at < ?)
      AND NOT EXISTS (
        SELECT 1 FROM token t
        WHERE t.human_id = h.id AND t.tier = 'admin' AND t.revoked_at IS NULL
      )
  `).all(teamId, cutoffIso) as Array<{ id: string; handle: string }>

  if (candidates.length === 0) return { handles: [] }

  db.transaction(() => {
    for (const c of candidates) {
      db.prepare(
        "INSERT INTO audit_log(team_id,at,actor_human_id,event,detail_json) VALUES (?,?,?,?,?)"
      ).run(teamId, nowIso, actorHumanId, 'user.purge',
        JSON.stringify({ handle: c.handle, cutoff: cutoffIso, reason: 'inactive' }))
      db.prepare("DELETE FROM token WHERE human_id=?").run(c.id)
      db.prepare("DELETE FROM human WHERE id=?").run(c.id)
    }
  })()

  return { handles: candidates.map(c => c.handle) }
}

/** Runs purgeInactive once per team. Team-scoped by construction — never call this per-tick more than once. */
function sweepInactiveHumans(db: Db, cutoffIso: string, nowIso: string, days: number): void {
  const teams = db.prepare("SELECT id FROM team").all() as Array<{ id: string }>
  for (const t of teams) {
    const r = purgeInactive(db, t.id, cutoffIso, null, nowIso)
    if (r.handles.length > 0) {
      logJson('info', 'purge.sweep', { team_id: t.id, count: r.handles.length, handles: r.handles.join(','), days })
    }
  }
}

/**
 * Starts a recurring background sweep. Returns the interval handle so the
 * caller can clear it at shutdown.
 *
 * Two independent sweeps run per tick: `sweepInactiveHumans` is team-scoped
 * (one purgeInactive call per team, by design — inactivity is a per-team
 * concept). `purgeReplyState` (REPLY_ROUTING_SPEC.md §9/§12) is NOT
 * team-scoped — reply_limiter/reply_route rows are swept relay-wide by
 * `expires_at`/`window_start` alone — so it is called exactly once here,
 * outside and after the per-team loop, never inside it.
 */
export function startInactivitySweeper(
  db: Db,
  opts: { intervalMs: number; days: number; now: () => Date }
): NodeJS.Timeout {
  const tick = (): void => {
    try {
      const nowDate = opts.now()
      const nowIso = nowDate.toISOString()
      const cutoff = new Date(nowDate.getTime() - opts.days * 24 * 60 * 60 * 1000).toISOString()

      sweepInactiveHumans(db, cutoff, nowIso, opts.days)

      const replyResult = purgeReplyState(db, nowDate.getTime())
      if (replyResult.limiterRows > 0 || replyResult.routes > 0) {
        logJson('info', 'purge.reply_state', { limiter_rows: replyResult.limiterRows, routes: replyResult.routes })
      }
    } catch (err) {
      logJson('warn', 'purge.sweep_error', { err: String(err instanceof Error ? err.message : err) })
    }
  }
  return setInterval(tick, opts.intervalMs)
}
