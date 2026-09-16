# P2 campaign ledger

Base `37cfdb9`; implementer codex gpt-5.5 (`e0eca2e`, 19 files, +445/−16, all under `packages/peer-agent/src/`);
engine verify PASS in a fresh worktree (`scripts/verify-groups-p2.sh`: 157 + 459 + 545 peer-agent).

- MiniMax r1: FIX-THEN-SHIP, 2 MUST-FIX — both refuted: (a) whoami not called on the NATS branch — NATS lane is out
  of scope by plan §1 and never talks to the relay HTTP surface; (b) reauth/give-up race — the SSE reader awaits each
  envelope before reading the next event, so a `reauth` cannot interleave with an in-flight delivery.
- sol r2: FIX-THEN-SHIP, 3 — (a) `@group` + `fleet_wide` bypasses the BROADCAST content gate: refuted, that gate lives
  on the relay (P1 applies it to `@group` exactly as to `@team`; `fleet_wide:true` is the designed escape hatch) and the
  peer-agent never had a content gate for `@team` either; (b) stream strips `group`: refuted, `EnvelopeSchema` keeps a
  present `group` and the peer-agent only deletes the default when the raw frame lacked it; (c) configured
  `default_group` never applied on outbound: **accepted**, fixed at depth-0 (`tools.ts`: strict mode fills
  `payload.group` from the runtime default when omitted; legacy sends carry no `group` key) + test.
- `bin/fleet` (dotfiles `2f98e2f`) done at depth-0: `send --group`, `@group`, grouped `peers`, `whoami` memberships,
  `inbox group=`; legacy relay byte-identical (whoami 404 tolerated) — verified live against the current relay.
