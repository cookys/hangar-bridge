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
 *   1. `meta.local_target` = `<name>@<generation>` (§8.1) — a reply's
 *      relay-stamped return selector. Resolved against the LIVE registry
 *      (same name, same generation, live pid, same harness) and, only on a
 *      successful `POST /v1/grants/finalize`, pasted into exactly that one
 *      pane. Any failure is `return_target_gone` / `finalize_failed` — never
 *      a fallback to another pane or to the project.
 *   2. `meta.local_target` = a bare name (no generation) — an ordinary
 *      send_to_peer `--local` address (§8.1: "no more privileged than
 *      to_filter.instance"); matched by name alone, as before D5.
 *   3. `to_filter.repo`      — every registration in that project
 *   4. otherwise             — the configured default target if any, else all
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
  /**
   * ULID minted by `agent-call` at attach (§8.1). Undefined only when the
   * local `agent-call` predates this field — treated as "cannot verify",
   * which makes every selector-bearing lookup against that entry fail
   * closed (not_registered/generation_stale, never a false match).
   */
  generation?: string
  /** The pane id (`agent-call`'s own `$TMUX_PANE` value) this registration was attached from. */
  tmuxPane?: string
}

export interface SwitchboardOpts {
  bin?: string
  defaultTarget?: string | undefined
  /** test seams */
  list?: () => Promise<Registration[]>
  deliver?: (e: Envelope, target: string) => Promise<AgentCallReceipt>
  isAlive?: (pid: number) => boolean
  /**
   * §8.1 grant finalisation: `POST /v1/grants/finalize {msg_id, selector}`
   * under the courier's own bearer + instance header. Resolves `true` only
   * on a 200 (the courier may paste); anything else, including the
   * dependency being absent entirely, is `finalize_failed` — pasting an
   * un-finalised reply would let a pane check bypass §5.2's grant narrowing.
   */
  finalizeGrant?: (msgId: string, selector: string) => Promise<boolean>
}

interface RawRegistration {
  name?: unknown
  harness?: unknown
  ingress?: unknown
  pid?: unknown
  cwd?: unknown
  generation?: unknown
  tmux_pane?: unknown
}

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
          out.push({
            name: r.name, harness: typeof r.harness === 'string' ? r.harness : '?', pid: r.pid, cwd: r.cwd,
            repo: repoOfCwd(r.cwd),
            ...(typeof r.generation === 'string' ? { generation: r.generation } : {}),
            ...(typeof r.tmux_pane === 'string' ? { tmuxPane: r.tmux_pane } : {}),
          })
        }
        resolve(out)
      } catch (e) {
        logJson('warn', 'peer.switchboard.list_error', { err: String(e instanceof Error ? e.message : e) })
        resolve([])
      }
    })
  })
}

/**
 * §8.1: "the peer-agent reads the pane's current registration (name@generation)
 * from the local registry at call time" — the same read used by reply_to_peer
 * (item 1) and `hangar-bridge send` (item 5) to find THIS pane's own address.
 * A fresh read every call (no caching) since a pane's registration can change
 * underneath a long-lived process (restart, harness change, lazy re-attach).
 */
export async function findPaneRegistration(pane: string, bin = 'agent-call'): Promise<Registration | undefined> {
  const regs = await listRegistrations(bin)
  return regs.find(r => r.tmuxPane === pane)
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

/**
 * §8.1 naming: a registration's name is `AGENT_CALL_NAME` (opaque, no
 * inferrable harness) or `<basename of cwd>--<pane current command>`. For
 * the latter shape the trailing `--<harness>` segment IS the harness this
 * registration was attached under — comparing it against the registry's
 * CURRENT `harness` field detects a harness swap that, per spec, should
 * already have minted a new generation; this is the fail-closed backstop
 * for the case where it didn't. Returns undefined (cannot verify, assumed
 * fine) for a custom name with no such suffix.
 */
function expectedHarnessFromName(name: string): string | undefined {
  const idx = name.lastIndexOf('--')
  if (idx <= 0 || idx + 2 >= name.length) return undefined
  return name.slice(idx + 2)
}

export type ReturnTargetGoneReason =
  | 'not_registered' | 'generation_stale' | 'harness_changed' | 'pid_dead' | 'none_selector'

export type SelectorResolution =
  | { ok: true; registration: Registration }
  | { ok: false; reason: ReturnTargetGoneReason }

export class Switchboard {
  private regs: Registration[] = []
  /** Unfiltered (includes dead-pid entries) — needed to tell not_registered from pid_dead. */
  private allRegs: Registration[] = []
  private readonly list: () => Promise<Registration[]>
  private readonly deliverTo: (e: Envelope, target: string) => Promise<AgentCallReceipt>
  private readonly isAlive: (pid: number) => boolean
  private readonly finalizeGrantFn: ((msgId: string, selector: string) => Promise<boolean>) | undefined

  constructor(private readonly opts: SwitchboardOpts = {}) {
    this.list = opts.list ?? (() => listRegistrations(opts.bin))
    this.deliverTo = opts.deliver ?? ((e, target) => deliverViaAgentCall(e, { target, ...(opts.bin ? { bin: opts.bin } : {}) }))
    this.isAlive = opts.isAlive ?? pidAlive
    this.finalizeGrantFn = opts.finalizeGrant
  }

  /** Re-read the local registry; a registration whose pid is gone is not an extension. */
  async refresh(): Promise<Registration[]> {
    const all = await this.list()
    this.allRegs = all
    this.regs = all.filter(r => this.isAlive(r.pid))
    return this.regs
  }

  registrations(): Registration[] { return this.regs }

  /** Projects this courier can deliver into — published as presence `repos`. */
  repos(): string[] {
    return Array.from(new Set(this.regs.map(r => r.repo))).sort()
  }

  /** Which extensions a NON-selector envelope rings. Empty ⇒ nobody here can take it. */
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
   * §5.4/§8.1 hardened resolution for a `<name>@<generation>` selector: the
   * registration must exist, with that exact generation, a live pid, and
   * (best-effort, §8.1 naming) the harness it was attached under. Reads
   * `allRegs` (unfiltered) so a dead-pid entry is diagnosed as `pid_dead`
   * rather than indistinguishable from `not_registered`.
   */
  resolveSelector(raw: string): SelectorResolution {
    if (!raw || raw === '~none') return { ok: false, reason: 'none_selector' }
    const at = raw.lastIndexOf('@')
    if (at <= 0) return { ok: false, reason: 'not_registered' }
    const name = raw.slice(0, at)
    const generation = raw.slice(at + 1)
    const reg = this.allRegs.find(r => r.name === name)
    if (!reg) return { ok: false, reason: 'not_registered' }
    if (reg.generation !== generation) return { ok: false, reason: 'generation_stale' }
    if (!this.isAlive(reg.pid)) return { ok: false, reason: 'pid_dead' }
    const expected = expectedHarnessFromName(reg.name)
    if (expected !== undefined && expected !== reg.harness) return { ok: false, reason: 'harness_changed' }
    return { ok: true, registration: reg }
  }

  /**
   * §8.1: resolve → finalize the grant → paste, in that order (a resolution
   * failure is local and free; skip the network round trip for it). NEVER
   * falls back to another pane, the project, or "all extensions" — a
   * selector-bearing message without a valid target is a reported failure.
   */
  private async deliverSelector(e: Envelope, raw: string): Promise<{ accepted: string[]; failed: Record<string, string> }> {
    let resolved = this.resolveSelector(raw)
    if (!resolved.ok && resolved.reason === 'not_registered') {
      // A just-attached pane may not be in this tick's cached registry yet —
      // the same one-miss-one-refresh grace the bare-name/repo paths get.
      await this.refresh()
      resolved = this.resolveSelector(raw)
    }
    if (!resolved.ok) {
      throw new Error(`switchboard: return_target_gone reason=${resolved.reason} selector=${raw} msg=${e.id}`)
    }
    const target = resolved.registration

    // A transport-level failure (timeout, connection refused, an aborted
    // fetch) here is classified EXACTLY like an explicit non-200: the paste
    // never happens. Without this catch a rejected finalizeGrantFn promise
    // would escape as whatever the transport happened to throw (ETIMEDOUT,
    // AbortError, ...) — not in the §13 vocabulary, and no reason for the
    // caller to know the paste was suppressed rather than attempted.
    let finalized: boolean
    try {
      finalized = this.finalizeGrantFn ? await this.finalizeGrantFn(e.id, raw) : false
    } catch (err) {
      const message = String(err instanceof Error ? err.message : err)
      throw new Error(`switchboard: finalize_failed selector=${raw} msg=${e.id}: finalize call threw: ${message}`)
    }
    if (!finalized) {
      throw new Error(`switchboard: finalize_failed selector=${raw} msg=${e.id}`)
    }

    try {
      const receipt = await this.deliverTo(e, target.name)
      logJson('info', 'peer.inbound.agent_call_accepted', { msg_id: e.id, target: target.name, receipt_status: receipt.status })
      return { accepted: [target.name], failed: {} }
    } catch (err) {
      const message = String(err instanceof Error ? err.message : err)
      logJson('warn', 'peer.switchboard.extension_refused', { msg_id: e.id, target: target.name, err: message })
      throw new Error(`switchboard: every extension refused msg ${e.id}: ${message}`)
    }
  }

  /**
   * Deliver to every routed extension. Succeeds if at least one accepted;
   * throws (so the stream's retry/give-up path applies) only when nobody did.
   * A miss triggers one refresh, because a harness launched since the last
   * timer tick is exactly the one a fresh message is most likely for.
   */
  async deliver(e: Envelope): Promise<{ accepted: string[]; failed: Record<string, string> }> {
    const rawLocal = e.meta['local_target']
    if (rawLocal !== undefined && (rawLocal.includes('@') || rawLocal === '~none')) {
      return this.deliverSelector(e, rawLocal)
    }
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
