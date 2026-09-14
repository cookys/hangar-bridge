/**
 * Local inbox spool for harnesses that can only PULL.
 *
 * The relay's durable buffer (GET /v1/messages) holds project-scoped, handle-
 * addressed and @team messages. A reply (reply_to_peer) or an instance-narrowed
 * send is delivered LIVE over SSE and never stored there. A Claude session sees
 * those as channel notifications; an MCP client that renders no notifications
 * (ChatGPT behind the OpenAI tunnel-client) would never see them at all.
 *
 * With `inbox.spool: true` the peer-agent appends every envelope that reaches
 * the final mile to a JSONL file, and poll_inbox merges that file with the
 * relay page. Message ids are `msg_<ULID>`, so plain string order is time order
 * and `since` works the same on both sources.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Envelope } from '@hangar-bridge/shared'

export interface InboxSpoolOpts {
  path: string
  /** Keep at most this many envelopes; the oldest are dropped on compaction. */
  max?: number
}

export class InboxSpool {
  private readonly path: string
  private readonly max: number
  private readonly seen = new Set<string>()
  private count = 0

  constructor(opts: InboxSpoolOpts) {
    this.path = opts.path
    this.max = opts.max ?? 500
    for (const e of this.read()) this.seen.add(e.id)
    this.count = this.seen.size
  }

  /** Append one envelope (idempotent on id). Never throws — the spool is best-effort. */
  append(e: Envelope): boolean {
    if (this.seen.has(e.id)) return false
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
      appendFileSync(this.path, JSON.stringify(e) + '\n', { mode: 0o600 })
      this.seen.add(e.id)
      this.count += 1
      if (this.count > this.max * 2) this.compact()
      return true
    } catch {
      return false
    }
  }

  /** All spooled envelopes, oldest first, deduplicated by id. */
  read(): Envelope[] {
    if (!existsSync(this.path)) return []
    const byId = new Map<string, Envelope>()
    for (const line of readFileSync(this.path, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const e = JSON.parse(line) as Envelope
        if (typeof e?.id === 'string') byId.set(e.id, e)
      } catch { /* skip a torn line */ }
    }
    return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  }

  /** Envelopes with id strictly after `since` (all when since is undefined). */
  after(since?: string): Envelope[] {
    const all = this.read()
    return since ? all.filter(e => e.id > since) : all
  }

  private compact(): void {
    const keep = this.read().slice(-this.max)
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, keep.map(e => JSON.stringify(e)).join('\n') + (keep.length ? '\n' : ''), { mode: 0o600 })
    renameSync(tmp, this.path)
    this.seen.clear()
    for (const e of keep) this.seen.add(e.id)
    this.count = keep.length
  }
}

/**
 * Merge a relay inbox page with spooled envelopes: union by id, sorted by id,
 * limited, with next_cursor = the last id shown (or the relay's cursor when it
 * is further along and nothing was cut).
 */
export function mergeInboxPage<T extends { id: string }>(
  page: { messages: T[]; next_cursor: string | null; pending_after?: number; pending_capped?: boolean },
  spooled: T[],
  opts: { since?: string; limit?: number },
): { messages: T[]; next_cursor: string | null; from_spool: number; pending_after?: number; pending_capped?: boolean } {
  const byId = new Map<string, T>()
  for (const m of page.messages) byId.set(m.id, m)
  let fromSpool = 0
  for (const m of spooled) {
    if (opts.since && !(m.id > opts.since)) continue
    if (!byId.has(m.id)) { byId.set(m.id, m); fromSpool += 1 }
  }
  const merged = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const limit = opts.limit ?? 100
  const cut = merged.length > limit
  const messages = cut ? merged.slice(0, limit) : merged
  const last = messages.length ? messages[messages.length - 1]!.id : null
  let next: string | null = last
  if (!cut && page.next_cursor && (!last || page.next_cursor > last)) next = page.next_cursor
  // Replay butler (§2.5): the relay's "still waiting past this page" count
  // passes through; rows this merge cut off are still waiting too, so they
  // are added. An old relay sends no count — leave it undefined, never NaN.
  const cutCount = merged.length - messages.length
  const pending_after = page.pending_after === undefined ? undefined : page.pending_after + cutCount
  return {
    messages, next_cursor: next, from_spool: fromSpool,
    ...(pending_after !== undefined ? { pending_after } : {}),
    ...(page.pending_capped !== undefined ? { pending_capped: page.pending_capped } : {}),
  }
}
