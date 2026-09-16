import type { Envelope } from '@hangar-bridge/shared'

export type WireEnvelope = Omit<Envelope, 'group'> | Envelope

export function envelopeForWire(envelope: Envelope, strictGroups: boolean): WireEnvelope {
  if (strictGroups) return envelope
  const { group: _group, ...legacy } = envelope
  return legacy
}
