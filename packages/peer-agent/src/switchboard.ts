import { execFile } from 'node:child_process'
import { basename } from 'node:path'
import type { Envelope } from '@hangar-bridge/shared'
import { deliverViaAgentCall, type AgentCallReceipt } from './agent-call-ingress.ts'
import { detectWorkingContext } from './roots.ts'
import { logJson } from './logger.ts'

/**
 * Switchboard: one courier per Unix user that delivers into EVERY locally
 * registered harness, instead of one courier hard-wired to one target.
 *
 * The single-target courier was built for one kimi session and could not
 * follow the fleet's real shape — several harnesses in one project, several
 * projects on one box. Worse, it advertised no project at all, so the default
 * project-scoped send never matched it (crosshair8-hero, 2026-09-03).
 *
 * The switchboard reads `agent-call list` — the same registry `crew` writes
 * into — and derives, per registration, the project it sits in (the same
 * derivation a Claude peer uses for its own presence, so a project name means
 * the same thing on both sides). It publishes the union as `repos` so the
 * relay's `to_filter.repo` matches this courier for any project it can reach,
 * and on delivery picks the extension(s):
 *
 *   1. `meta.local_target`   — an explicit registration name; only that one
 *   2. `to_filter.repo`      — every registration in that project
 *   3. otherwise             — the configured default target if any, else all
 *
 * Only tmux-ingress registrations are extensions: a claude-channel registration
 * belongs to a Claude session that already has its own peer-agent.
 */

export interface Registration {
  name: string
  harness: string
  pid: number
  cwd: string
  repo: string
}

export interface SwitchboardOpts {
  bin?: string
  defaultTarget?: string | undefined
  /** test seams */
  list?: () => Promise<Registration[]>
  deliver?: (e: Envelope, target: string) => Promise<AgentCallReceipt>
  isAlive?: (pid: number) => boolean
}

interface RawRegistration { name?: unknown; harness?: unknown; ingress?: unknown; pid?: unknown; cwd?: unknown }

/** Project name for a registration's cwd — git-derived like a Claude peer's own presence, basename otherwise. */
export function repoOfCwd(cwd: string): string {
  try {
    const ctx = detectWorkingContext(cwd)
    if (ctx.repo) return ctx.repo
  } catch { /* fall through */ }
  return basename(cwd)
}

export function listRegistrations(bin = 'agent-call'): Promise<Registration[]> {
  return new Promise(resolve => {
    execFile(bin, ['list', '--json'], { timeout: 5_000, maxBuffer: 256 * 1024, encoding: 'utf8' }, (err, stdout) => {
      if (err) { logJson('warn', 'peer.switchboard.list_error', { err: err.message }); resolve([]); return }
      try {
        const raw = JSON.parse(stdout) as RawRegistration[]
        const out: Registration[] = []
        for (const r of raw) {
          if (r.ingress !== 'tmux') continue
          if (typeof r.name !== 'string' || typeof r.cwd !== 'string' || typeof r.pid !== 'number') continue
          out.push({ name: r.name, harness: typeof r.harness === 'string' ? r.harness : '?', pid: r.pid, cwd: r.cwd, repo: repoOfCwd(r.cwd) })
        }
        resolve(out)
      } catch (e) {
        logJson('warn', 'peer.switchboard.list_error', { err: String(e instanceof Error ? e.message : e) })
        resolve([])
      }
    })
  })
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

export class Switchboard {
  private regs: Registration[] = []
  private readonly list: () => Promise<Registration[]>
  private readonly deliverTo: (e: Envelope, target: string) => Promise<AgentCallReceipt>
  private readonly isAlive: (pid: number) => boolean

  constructor(private readonly opts: SwitchboardOpts = {}) {
    this.list = opts.list ?? (() => listRegistrations(opts.bin))
    this.deliverTo = opts.deliver ?? ((e, target) => deliverViaAgentCall(e, { target, ...(opts.bin ? { bin: opts.bin } : {}) }))
    this.isAlive = opts.isAlive ?? pidAlive
  }

  /** Re-read the local registry; a registration whose pid is gone is not an extension. */
  async refresh(): Promise<Registration[]> {
    const all = await this.list()
    this.regs = all.filter(r => this.isAlive(r.pid))
    return this.regs
  }

  registrations(): Registration[] { return this.regs }

  /** Projects this courier can deliver into — published as presence `repos`. */
  repos(): string[] {
    return Array.from(new Set(this.regs.map(r => r.repo))).sort()
  }

  /** Which extensions an envelope rings. Empty ⇒ nobody here can take it. */
  route(e: Envelope): Registration[] {
    const local = e.meta['local_target']
    if (local) return this.regs.filter(r => r.name === local)
    const repo = e.to_filter?.repo
    if (repo) return this.regs.filter(r => r.repo === repo)
    if (this.opts.defaultTarget) {
      const d = this.regs.filter(r => r.name === this.opts.defaultTarget)
      if (d.length > 0) return d
    }
    return this.regs
  }

  /**
   * Deliver to every routed extension. Succeeds if at least one accepted;
   * throws (so the stream's retry/give-up path applies) only when nobody did.
   * A miss triggers one refresh, because a harness launched since the last
   * timer tick is exactly the one a fresh message is most likely for.
   */
  async deliver(e: Envelope): Promise<{ accepted: string[]; failed: Record<string, string> }> {
    let targets = this.route(e)
    if (targets.length === 0) { await this.refresh(); targets = this.route(e) }
    if (targets.length === 0) {
      throw new Error(`switchboard: no local extension for msg ${e.id} (local_target=${e.meta['local_target'] ?? '-'}, repo=${e.to_filter?.repo ?? '-'}, registrations=${this.regs.length})`)
    }
    const accepted: string[] = []
    const failed: Record<string, string> = {}
    for (const t of targets) {
      try {
        const receipt = await this.deliverTo(e, t.name)
        accepted.push(t.name)
        logJson('info', 'peer.inbound.agent_call_accepted', { msg_id: e.id, target: t.name, receipt_status: receipt.status })
      } catch (err) {
        failed[t.name] = String(err instanceof Error ? err.message : err)
        logJson('warn', 'peer.switchboard.extension_refused', { msg_id: e.id, target: t.name, err: failed[t.name] })
      }
    }
    if (accepted.length === 0) {
      const first = Object.values(failed)[0] ?? 'unknown'
      throw new Error(`switchboard: every extension refused msg ${e.id}: ${first}`)
    }
    return { accepted, failed }
  }
}
