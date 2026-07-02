# Backlog — hangar-bridge

Deferred work, ideas, and known gaps. autopilot:next scans this file. Promote an item to a
`docs/projects/<date>-<name>/` when it grows to L-size.

## Format
`- [ ] <one-line item> — <why / context>  (size: S/L/Fix)`

## Open
- [ ] Phase-A self-loopback + Phase-B cross-host (openclaw↔cookys-gentoo) — finish bring-up per README status.  (size: L)
- [ ] CLAUDE.md "Windows-specific notes" section may be stale — dev now on Linux (zsh); audit & trim.  (size: S)
- [ ] Live-peer e2e for outbound permission relay — two real Claude sessions under `CLAUDE_DRIVER=cli` (CC v2.1.81+) confirming CC emits `notifications/claude/channel/permission_request` and applies the returned verdict; current coverage is unit-level only (P2.3).  (size: S)
- [ ] DispatchTracker: clear a matched correlation on task_result instead of leaving it to TTL (`inbound.ts` dispatch-matched branch) — tightens the correlation window; today a matched entry lingers until DISPATCH_REQUEST_TIMEOUT_MS.  (size: S)
- [ ] DispatchTracker persistence is a synchronous `writeFileSync` on the dispatch hot path — fine at current volume; revisit (async/batched) if dispatch throughput grows.  (size: S)
- [ ] Startup validation: when `permission_relay.enabled=true` but `self` is missing from config, the outbound relay silently fails-closed (relays to nobody). Consider a loud startup error / validation so a misconfigured relay is caught at boot instead of silently no-op'ing. (size: S)

## Done
_(move completed items here with the commit/date)_
