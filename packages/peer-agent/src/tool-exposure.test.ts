import { describe, expect, it } from 'vitest'
import { createToolExposure } from './tool-exposure.ts'

const TOOLS = [
  { name: 'send_to_peer' }, { name: 'list_peers' }, { name: 'poll_inbox' },
  { name: 'respond_to_permission' }, { name: 'dispatch_task' },
]

describe('createToolExposure', () => {
  it('unset allow-list exposes everything and hides nothing', () => {
    const x = createToolExposure(undefined)
    expect(x.list(TOOLS)).toEqual(TOOLS)
    expect(x.hidden(TOOLS)).toEqual([])
    expect(x.unknown(TOOLS)).toEqual([])
    expect(x.allows('respond_to_permission')).toBe(true)
  })

  it('allow-list narrows listing and calling, keeping input order', () => {
    const x = createToolExposure(['poll_inbox', 'send_to_peer'])
    expect(x.list(TOOLS).map(t => t.name)).toEqual(['send_to_peer', 'poll_inbox'])
    expect(x.hidden(TOOLS)).toEqual(['list_peers', 'respond_to_permission', 'dispatch_task'])
    expect(x.allows('respond_to_permission')).toBe(false)
    expect(x.allows('dispatch_task')).toBe(false)
    expect(x.allows('poll_inbox')).toBe(true)
  })

  it('reports allowed names that match no registered tool', () => {
    const x = createToolExposure(['poll_inbox', 'pol_inbox'])
    expect(x.unknown(TOOLS)).toEqual(['pol_inbox'])
  })
})
