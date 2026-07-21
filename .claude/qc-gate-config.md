# qc-gate-config — per-project qc-gate forcing-function strength (hangar-bridge)
# Resolved by autopilot scripts/resolve-qc-gate.sh; consulted by .githooks/pre-push and finish-flow.

## Settings (one key: value per line; first match wins)
- mode: warn
- protected_paths: packages/shared/src/,packages/relay/src/,packages/peer-agent/src/
- evidence: either

# Rationale: solo-operator homelab fork → `warn` (surface un-reviewed security-surface commits at push,
# don't hard-block). Protected paths are the three source trees that carry the wire-format / security
# invariants; pure docs / e2e / operations changes don't trip the gate. Tighten to `block` if a regression
# ever slips through an un-reviewed push.
