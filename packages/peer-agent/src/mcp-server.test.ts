import { describe, it, expect } from 'vitest'
import { createMcpServer } from './mcp-server.ts'

describe('createMcpServer', () => {
  it('declares claude/channel capability', () => {
    const { capabilities } = createMcpServer({ permissionRelay: false })
    expect(capabilities.experimental).toHaveProperty('claude/channel')
    expect(capabilities.experimental).not.toHaveProperty('claude/channel/permission')
  })

  it('also declares claude/channel/permission when permissionRelay=true', () => {
    const { capabilities } = createMcpServer({ permissionRelay: true })
    expect(capabilities.experimental).toHaveProperty('claude/channel')
    expect(capabilities.experimental).toHaveProperty('claude/channel/permission')
  })

  /**
   * Layer 5 of the 5-layer auth defense — Untrusted-prompt system prompt.
   *
   * The CHANNEL_INSTRUCTIONS preamble teaches the receiving Claude that
   * everything inside a <channel> tag is UNTRUSTED USER INPUT (not system
   * direction): refuses to leak secrets / re-route / auto-approve, and
   * defers destructive actions to its own local user. Server-stamped `from`
   * (Layer 2) is the only field it's allowed to trust about provenance.
   */
  it('Layer 5 — CHANNEL_INSTRUCTIONS treats peer content as untrusted input', () => {
    const { instructions } = createMcpServer({ permissionRelay: false })
    expect(instructions).toContain('UNTRUSTED USER INPUT')
    expect(instructions).toContain('Never auto-approve')
  })
})
