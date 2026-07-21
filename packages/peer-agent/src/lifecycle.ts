import type { Readable } from 'node:stream'

export interface LifecycleDeps {
  /** stdin stream to watch for EOF/close (parent MCP client death). Default: process.stdin */
  stdin?: Pick<Readable, 'on'> & Partial<Pick<Readable, 'resume'>>
  /** process-like object for signal handlers. Default: process */
  proc?: Pick<NodeJS.Process, 'on'>
  /** best-effort cleanup before exit (clear timers, abort the relay SSE). Must not block. */
  cleanup?: () => void
  /** exit hook. Default: process.exit */
  exit?: (code: number) => void
  /** structured logger hook, called once with the trigger reason. */
  onShutdown?: (reason: string) => void
}

/**
 * Make this stdio MCP server exit when its parent (Claude Code) goes away.
 *
 * The MCP SDK's StdioServerTransport registers only 'data'/'error' listeners on
 * stdin — it never watches for 'end'/'close', so stdin EOF (exactly what a dying
 * parent produces) does NOT trigger transport.close()/onclose. Combined with the
 * long-lived roster setInterval and the relay SSE socket keeping the event loop
 * alive, the process orphans (reparented to PID 1) and lingers forever. Every stale
 * copy keeps its relay connection under the same handle, so the relay flaps presence
 * between them and other peers' monitors see a connect/summary loop. This wires the
 * missing exit path so each session's peer-agent dies with its parent.
 *
 * Idempotent: the first trigger wins; later events are ignored.
 */
export function installLifecycleShutdown(deps: LifecycleDeps = {}): void {
  const stdin = deps.stdin ?? process.stdin
  const proc = deps.proc ?? process
  const exit = deps.exit ?? ((code: number) => process.exit(code))
  let shuttingDown = false
  const shutdown = (reason: string): void => {
    if (shuttingDown) return
    shuttingDown = true
    deps.onShutdown?.(reason)
    try { deps.cleanup?.() } catch { /* best-effort: exit regardless */ }
    exit(0)
  }
  // stdin EOF/close == the MCP stdio parent (Claude Code) exited.
  stdin.on('end', () => shutdown('stdin_end'))
  stdin.on('close', () => shutdown('stdin_close'))
  // 'end'/'close' only fire once stdin is in flowing mode. The SDK's
  // StdioServerTransport attaches a 'data' listener (which flows it), but don't
  // depend on that ordering — resume() here makes EOF detection self-sufficient.
  // The transport's own 'data' listener still receives every message, so no input
  // is lost by flowing stdin ourselves.
  stdin.resume?.()
  // Explicit termination (kill, systemd stop, Ctrl-C).
  proc.on('SIGTERM', () => shutdown('SIGTERM'))
  proc.on('SIGINT', () => shutdown('SIGINT'))
}
