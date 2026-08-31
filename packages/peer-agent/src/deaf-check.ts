import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * P0 deaf-immunity flag self-check.
 *
 * A Claude Code session started without a channels flag naming THIS server's
 * mcp config key silently drops every notifications/claude/channel — MCP
 * connects, tools work, outbound sends, but the model never sees inbound.
 * This box ran that way for two months. The peer-agent is a child of the
 * harness process, so on Linux we can walk the /proc ancestor chain, find
 * the `claude` process, and check its argv before the first message is lost.
 *
 * Fail-open discipline (the check must never create its own false DEAF):
 *  - no readable /proc            → skip
 *  - no `claude` in the ancestry  → skip (non-Claude harness or exotic shim)
 *  - mcp key unknown (env absent) → skip
 * Only a positively identified claude ancestor whose argv lacks a channels
 * flag for our key yields 'deaf'.
 */

export interface DeafCheckResult {
  state: 'verified' | 'deaf' | 'skip'
  reason: string
}

export interface DeafCheckOpts {
  procRoot?: string          // test seam; defaults to /proc
  selfPid?: number           // test seam; defaults to process.pid
  mcpKey: string | undefined // from HANGAR_MCP_KEY (plumbed by every registration path)
}

// Both the research-preview flag and the expected post-preview form. Each
// takes exactly one `server:<key>` as its value; Claude Code 2.1.251 treats the
// whole value as a single channel name, so several channels require REPEATING
// the flag. A comma- or space-joined value admits nothing and the session is
// deaf, so this parser must not split a single value or it reports a false
// `verified` for a deaf session.
const CHANNEL_FLAGS = ['--dangerously-load-development-channels', '--channels']
const MAX_ANCESTORS = 32

function readProc(procRoot: string, pid: number, file: string): string | null {
  try {
    return readFileSync(join(procRoot, String(pid), file), 'utf8')
  } catch {
    return null
  }
}

function parentPid(procRoot: string, pid: number): number | null {
  const status = readProc(procRoot, pid, 'status')
  if (status === null) return null
  const m = /^PPid:\s*(\d+)/m.exec(status)
  return m ? Number(m[1]) : null
}

function argvOf(procRoot: string, pid: number): string[] | null {
  const raw = readProc(procRoot, pid, 'cmdline')
  if (raw === null) return null
  return raw.split('\0').filter(Boolean)
}

function isClaude(argv: string[]): boolean {
  const exe = argv[0] ?? ''
  const base = exe.slice(exe.lastIndexOf('/') + 1)
  // `claude` itself, or `node .../claude` wrapper invocations.
  if (base === 'claude') return true
  return (base === 'node' || base === 'bun') && argv.some(a => a.endsWith('/claude') || a === 'claude')
}

/** Extract every server key named by any channels flag in this argv. */
function channelServerKeys(argv: string[]): string[] | null {
  let sawFlag = false
  const keys: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    let value: string | undefined
    for (const flag of CHANNEL_FLAGS) {
      if (arg === flag) { value = argv[i + 1]; sawFlag = true }
      else if (arg.startsWith(flag + '=')) { value = arg.slice(flag.length + 1); sawFlag = true }
    }
    if (value === undefined) continue
    // One channel per flag occurrence — do NOT split the value; Claude does not.
    if (value.startsWith('server:')) keys.push(value.slice('server:'.length))
  }
  return sawFlag ? keys : null
}

export function checkChannelsFlag(opts: DeafCheckOpts): DeafCheckResult {
  const procRoot = opts.procRoot ?? '/proc'
  const selfPid = opts.selfPid ?? process.pid
  if (!opts.mcpKey) {
    return { state: 'skip', reason: 'mcp key unknown (HANGAR_MCP_KEY not set); cannot compare' }
  }

  let pid: number | null = selfPid
  const seen = new Set<number>()
  for (let hops = 0; hops < MAX_ANCESTORS && pid !== null && pid > 1 && !seen.has(pid); hops++) {
    seen.add(pid)
    const parent = parentPid(procRoot, pid)
    if (parent === null) return { state: 'skip', reason: `/proc unreadable at pid ${pid}` }
    const argv = argvOf(procRoot, parent)
    if (argv !== null && isClaude(argv)) {
      const keys = channelServerKeys(argv)
      if (keys === null) {
        return { state: 'deaf', reason: 'claude ancestor has no channels flag — every inbound notification will be silently dropped' }
      }
      if (!keys.includes(opts.mcpKey)) {
        return {
          state: 'deaf',
          reason: `channels flag names [${keys.join(', ')}] but this server is registered as '${opts.mcpKey}' — key mismatch drops inbound silently`,
        }
      }
      return { state: 'verified', reason: `claude ancestor (pid ${parent}) loads channels for '${opts.mcpKey}'` }
    }
    pid = parent
  }
  return { state: 'skip', reason: 'no claude ancestor found (non-Claude harness or shim boundary); flag check not applicable' }
}

/**
 * Deafness mode 2 — the capability handshake (P0 gap, gen-3 F1).
 *
 * Claude Code drops a server's channel notifications for two independent
 * reasons, and the MCP log distinguishes them:
 *
 *   'not in --channels list for this session'          ← the launch flag; mode 1
 *   'server did not declare claude/channel capability' ← this handshake; mode 2
 *
 * checkChannelsFlag walks the process ancestry and answers mode 1 only. Mode 2
 * is not about traffic or flags at all: it is what THIS server declared about
 * itself during initialize, so it is decidable at startup by looking, with no
 * false positives — unlike a "have we received anything lately" heuristic, which
 * indicts every healthy-but-quiet fleet and contradicts the rule that a
 * successful emit never proves the client rendered anything.
 */
export function checkChannelCapability(
  capabilities: { experimental?: Record<string, unknown> | undefined } | undefined,
): DeafCheckResult {
  const experimental = capabilities?.experimental
  if (experimental && Object.prototype.hasOwnProperty.call(experimental, 'claude/channel')) {
    return { state: 'verified', reason: "server declares experimental 'claude/channel'" }
  }
  return {
    state: 'deaf',
    reason: "server did not declare the 'claude/channel' capability — the client will "
      + 'drop every inbound notification regardless of launch flags',
  }
}
