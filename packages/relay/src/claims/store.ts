import type { Db } from '../db/db.ts'

export interface Claim {
  team_id: string
  claim_key: string
  owner_handle: string
  owner_label: string | null
  note: string | null
  created_at: string
  expires_at: string
}

export type AcquireResult =
  | { ok: true; claim: Claim; renewed: boolean }
  | { ok: false; conflict: Claim }

export type ReleaseResult =
  | { ok: true; released: boolean }
  | { ok: false; conflict: Claim }

/**
 * Cooperative advisory asset lock (P4). Single live owner per (team, claim_key).
 * `expires_at` gives TTL-based auto-release: an expired row is treated as unclaimed
 * and can be re-acquired by anyone (same philosophy as presence TTL). `now` is
 * injected for deterministic tests (mirrors MessageStore / PresenceRegistry).
 */
export class ClaimStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private live(team_id: string, claim_key: string, nowIso: string): Claim | undefined {
    const row = this.db.prepare(
      'SELECT * FROM claim WHERE team_id=? AND claim_key=?'
    ).get(team_id, claim_key) as Claim | undefined
    if (!row) return undefined
    return row.expires_at > nowIso ? row : undefined // expired ⇒ treated as absent
  }

  /**
   * Acquire (or renew/extend if the caller already owns it). Succeeds when the key is
   * unclaimed, expired, or already owned by `owner_handle`. Fails (conflict) when a
   * DIFFERENT handle holds a live claim.
   */
  acquire(
    team_id: string, claim_key: string, owner_handle: string,
    owner_label: string | null, ttlSec: number, note: string | null,
  ): AcquireResult {
    const now = this.now()
    const nowIso = now.toISOString()
    const current = this.live(team_id, claim_key, nowIso)
    if (current && current.owner_handle !== owner_handle) {
      return { ok: false, conflict: current }
    }
    const renewed = current !== undefined // same-owner live row ⇒ renew/extend
    const expires_at = new Date(now.getTime() + ttlSec * 1000).toISOString()
    // Preserve created_at on renew; reset it when (re)claiming a free/expired key.
    const created_at = renewed ? current!.created_at : nowIso
    this.db.prepare(`
      INSERT INTO claim(team_id, claim_key, owner_handle, owner_label, note, created_at, expires_at)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(team_id, claim_key) DO UPDATE SET
        owner_handle=excluded.owner_handle,
        owner_label=excluded.owner_label,
        note=excluded.note,
        created_at=excluded.created_at,
        expires_at=excluded.expires_at
    `).run(team_id, claim_key, owner_handle, owner_label, note, created_at, expires_at)
    return {
      ok: true, renewed,
      claim: { team_id, claim_key, owner_handle, owner_label, note, created_at, expires_at },
    }
  }

  /** List live (non-expired) claims for a team, ordered by key. */
  list(team_id: string): Claim[] {
    const nowIso = this.now().toISOString()
    return this.db.prepare(
      'SELECT * FROM claim WHERE team_id=? AND expires_at > ? ORDER BY claim_key ASC'
    ).all(team_id, nowIso) as Claim[]
  }

  /**
   * Release a claim. Only the current live owner may release; an expired claim is
   * considered already released (idempotent delete). A live claim held by a different
   * handle is refused (conflict) so one peer cannot steal another's lock.
   */
  release(team_id: string, claim_key: string, owner_handle: string): ReleaseResult {
    const nowIso = this.now().toISOString()
    const current = this.live(team_id, claim_key, nowIso)
    if (current && current.owner_handle !== owner_handle) {
      return { ok: false, conflict: current }
    }
    const res = this.db.prepare(
      'DELETE FROM claim WHERE team_id=? AND claim_key=?'
    ).run(team_id, claim_key)
    return { ok: true, released: res.changes > 0 }
  }
}
