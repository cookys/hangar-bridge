import { PRESENCE_TTL_MS } from '@hangar-bridge/shared'

export interface PresenceSession {
  label: string
  cwd?: string
  branch?: string
  repo?: string
}

export interface PresenceSnapshot {
  handle: string
  summary: string
  last_seen: string
  sessions: PresenceSession[]
}

interface SessionState {
  label: string
  summary: string
  cwd?: string
  branch?: string
  repo?: string
  last_seen: string
}

export interface PresenceInput {
  summary: string
  cwd?: string | undefined
  branch?: string | undefined
  repo?: string | undefined
}

function copyOptional(src: PresenceInput): Omit<SessionState, 'label' | 'summary' | 'last_seen'> {
  const out: Omit<SessionState, 'label' | 'summary' | 'last_seen'> = {}
  if (src.cwd !== undefined) out.cwd = src.cwd
  if (src.branch !== undefined) out.branch = src.branch
  if (src.repo !== undefined) out.repo = src.repo
  return out
}

function toSession(s: SessionState): PresenceSession {
  const out: PresenceSession = { label: s.label }
  if (s.cwd !== undefined) out.cwd = s.cwd
  if (s.branch !== undefined) out.branch = s.branch
  if (s.repo !== undefined) out.repo = s.repo
  return out
}

export class PresenceRegistry {
  private state = new Map<string, Map<string, Map<string, SessionState>>>()

  // ttlMs: a session whose last_seen is older than (now - ttlMs) is treated as gone
  // and lazily evicted on the next read. This is what makes list_peers.online truthful
  // without a background timer — the peer-agent heartbeat refreshes last_seen while its
  // SSE stream is up, and an unclean disconnect (crash) ages out after ttlMs.
  constructor(
    private now: () => Date = () => new Date(),
    private ttlMs: number = PRESENCE_TTL_MS,
  ) {}

  /**
   * Drop sessions in `byLabel` whose last_seen is older than the TTL. Returns the
   * number of live sessions remaining. Called on every read so a stale/crashed
   * session never counts as online and memory does not accumulate dead sessions.
   */
  private prune(byLabel: Map<string, SessionState>): number {
    const cutoff = this.now().getTime() - this.ttlMs
    for (const [label, s] of byLabel) {
      if (new Date(s.last_seen).getTime() < cutoff) byLabel.delete(label)
    }
    return byLabel.size
  }

  set(team: string, handle: string, label: string, s: PresenceInput): void {
    let byHandle = this.state.get(team)
    if (!byHandle) {
      byHandle = new Map()
      this.state.set(team, byHandle)
    }
    let byLabel = byHandle.get(handle)
    if (!byLabel) {
      byLabel = new Map()
      byHandle.set(handle, byLabel)
    }
    byLabel.set(label, {
      label,
      summary: s.summary,
      ...copyOptional(s),
      last_seen: this.now().toISOString(),
    })
  }

  remove(team: string, handle: string, label: string): void {
    const byLabel = this.state.get(team)?.get(handle)
    if (!byLabel) return
    byLabel.delete(label)
    if (byLabel.size === 0) this.state.get(team)?.delete(handle)
  }

  get(team: string, handle: string): PresenceSnapshot | undefined {
    const byLabel = this.state.get(team)?.get(handle)
    if (!byLabel || byLabel.size === 0) return undefined
    if (this.prune(byLabel) === 0) {
      this.state.get(team)?.delete(handle)
      return undefined
    }
    const sessions = Array.from(byLabel.values())
    const first = sessions[0]!
    const last_seen = sessions.reduce(
      (max, s) => (s.last_seen > max ? s.last_seen : max),
      first.last_seen
    )
    return {
      handle,
      summary: first.summary,
      last_seen,
      sessions: sessions.map(toSession),
    }
  }

  listTeam(team: string): PresenceSnapshot[] {
    const byHandle = this.state.get(team)
    if (!byHandle) return []
    const out: PresenceSnapshot[] = []
    // Snapshot keys first: get() lazily evicts (deletes) fully-expired handles, so we
    // must not mutate `byHandle` while iterating its live key view.
    for (const handle of Array.from(byHandle.keys())) {
      const snap = this.get(team, handle)
      if (snap) out.push(snap)
    }
    return out
  }
}
