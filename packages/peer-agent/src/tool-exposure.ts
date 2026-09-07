/**
 * Tool exposure allow-list.
 *
 * A peer-agent normally lists every MCP tool it can serve. Some MCP clients
 * must see less: a non-Claude harness reached through a third-party tunnel
 * (e.g. ChatGPT) must not be able to answer another session's permission
 * request or dispatch tasks. `tools.allow` in config.json narrows both the
 * ListTools response and CallTool acceptance to the named tools; unset means
 * every tool, which keeps every existing deployment unchanged.
 */
export interface ToolExposure {
  /** true when the tool may be listed and called. */
  allows(name: string): boolean
  /** Descriptors that survive the allow-list (input order preserved). */
  list<T extends { name: string }>(tools: readonly T[]): T[]
  /** Names present in `tools` but hidden by the allow-list. */
  hidden<T extends { name: string }>(tools: readonly T[]): string[]
  /** Allowed names that match no registered tool (config typo / stale name). */
  unknown<T extends { name: string }>(tools: readonly T[]): string[]
}

export function createToolExposure(allow?: readonly string[]): ToolExposure {
  const set = allow ? new Set(allow) : undefined
  return {
    allows: name => !set || set.has(name),
    list: tools => (set ? tools.filter(t => set.has(t.name)) : [...tools]),
    hidden: tools => (set ? tools.filter(t => !set.has(t.name)).map(t => t.name) : []),
    unknown: tools => {
      if (!set) return []
      const known = new Set(tools.map(t => t.name))
      return [...set].filter(n => !known.has(n))
    },
  }
}
