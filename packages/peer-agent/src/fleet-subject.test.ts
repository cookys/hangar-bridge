import { describe, it, expect } from 'vitest'
import { TEAM_BROADCAST_HANDLE } from '@hangar-bridge/shared'
import { buildFleetSubject, deriveFrom, parseFleetSubject } from './fleet-subject.ts'

describe('fleet-subject', () => {
  it('builds and parses round-trip wire subjects', () => {
    const subject = buildFleetSubject('alice', 'bob', 'chat')
    expect(subject).toBe('fleet.alice.to.bob.chat')
    expect(parseFleetSubject(subject)).toEqual({ sender: 'alice', recipient: 'bob', kind: 'chat' })
  })

  it('parses team recipient', () => {
    const subject = buildFleetSubject('alice', TEAM_BROADCAST_HANDLE, 'presence_update')
    expect(subject).toBe('fleet.alice.to.team.presence_update')
    // parseFleetSubject returns the RAW wire recipient token ('team'), not the
    // envelope '@team' form — callers map 'team' → TEAM_BROADCAST_HANDLE when
    // building the envelope `to` (this keeps nats-transport routing on the wire form).
    expect(parseFleetSubject(subject)).toEqual({ sender: 'alice', recipient: 'team', kind: 'presence_update' })
  })

  it('deriveFrom returns the sender token', () => {
    expect(deriveFrom('fleet.alice.to.bob.chat')).toBe('alice')
    expect(deriveFrom('fleet.carol.to.team.permission_request')).toBe('carol')
  })

  it('rejects malformed and extra-token subjects', () => {
    expect(parseFleetSubject('fleet.alice.to.bob')).toBeNull()
    expect(parseFleetSubject('fleet.alice.to.bob.chat.extra')).toBeNull()
    expect(parseFleetSubject('fleet..to.bob.chat')).toBeNull()
    expect(parseFleetSubject('fleet.alice.to..chat')).toBeNull()
    expect(parseFleetSubject('foo.alice.to.bob.chat')).toBeNull()
  })

  it('rejects bad kind tokens', () => {
    expect(parseFleetSubject('fleet.alice.to.bob.invalid-kind')).toBeNull()
    expect(parseFleetSubject('fleet.alice.to.bob.permission')).toBeNull()
  })
})
