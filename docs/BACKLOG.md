# Backlog — hangar-bridge

Deferred work, ideas, and known gaps. autopilot:next scans this file. Promote an item to a
`docs/projects/<date>-<name>/` when it grows to L-size.

## Format
`- [ ] <one-line item> — <why / context>  (size: S/L/Fix)`

## Open
- [ ] Complete the remaining real-host SSE self-loopback + cross-host (openclaw↔cookys-gentoo) operator smoke — source/in-process paths are green, but production host access is outside this closeout.  (size: L)
- [ ] NATS P5 real-fleet cutover + soak — needs fleet host/access inputs, NATS location, and an operator-approved soak window; follow the Board-gated runbook.  (size: L)
- [ ] Port or explicitly retire relay-backed cooperative claims before NATS P6 — deleting the relay currently removes `claim_asset` / `list_claims` / `release_claim` and SQLite schema-v6 claim state.  (size: L)
- [ ] Add an SSE↔NATS bridge only if seamless mixed-mode cutover is required — current cohorts are intentionally isolated; whole-fleet cutover is the supported P5 path.  (size: L)
- [ ] Complete real-fleet subject-ACL rollout — update muyan `peers.json` ownership, restart/re-seed relay, and set each peer's interest filters; requires operator/fleet access.  (size: S)
- [ ] CLAUDE.md "Windows-specific notes" section may be stale — dev now on Linux (zsh); audit & trim.  (size: S)
- [ ] Live-peer e2e for outbound permission relay — two real Claude sessions under `CLAUDE_DRIVER=cli` (CC v2.1.81+) confirming CC emits `notifications/claude/channel/permission_request` and applies the returned verdict; current coverage is unit-level only (P2.3).  (size: S)
- [ ] DispatchTracker: clear a matched correlation on task_result instead of leaving it to TTL (`inbound.ts` dispatch-matched branch) — tightens the correlation window; today a matched entry lingers until DISPATCH_REQUEST_TIMEOUT_MS.  (size: S)
- [ ] DispatchTracker persistence is a synchronous `writeFileSync` on the dispatch hot path — fine at current volume; revisit (async/batched) if dispatch throughput grows.  (size: S)
- [ ] Startup validation: when `permission_relay.enabled=true` but `self` is missing from config, the outbound relay silently fails-closed (relays to nobody). Consider a loud startup error / validation so a misconfigured relay is caught at boot instead of silently no-op'ing. (size: S)
- [ ] Define a versioned claim-key taxonomy only if consumers need enforced `repo:` / `file:` / `config:` kinds — today all valid keys are one generic asset kind and prefixes are conventions.  (size: S)
- [ ] Retain NATS presence summary/session metadata if parity requires it — current NATS `list_peers` intentionally exposes roster + TTL `online`/`last_seen` only and returns empty `summary`/`sessions`; SSE remains the full-metadata path.  (size: S)
- [ ] Add a production MCP response tool for structured `task_result` plus a two-real-Claude round-trip smoke — the wire kind/receive path exists, but receivers currently report completion through `send_to_peer` chat.  (size: L)
- [ ] Design session-addressed NATS task/result routing with transactional shared correlation state — current handle-scoped WorkQueue semantics are protected by a host-global one-process-per-handle lock.  (size: L)

## Done
- [x] 2026-08-30 — Repaired legacy relay Docker packaging in the
  [exact-SHA deployment-hardening project](./projects/2026-08-30-exact-sha-deployment-hardening/README.md):
  current workspace names/runtime env, exact build revision, and explicit read-only peers roster.
