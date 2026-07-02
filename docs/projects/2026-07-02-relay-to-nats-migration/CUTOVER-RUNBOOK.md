# Cutover Runbook — P5 fleet cutover + P6 relay deletion

> **Status:** Board-gated. P0–P4 shipped to `develop` (`01b7f91`) — NATS substrate is present
> behind `transport: 'nats'`, **SSE remains the default and the relay is untouched**, so nothing
> has changed operationally yet. This runbook is the step-by-step for when the Board authorises
> the cutover. Spec: [../../plans/2026-07-02-relay-to-nats-migration.md](../../plans/2026-07-02-relay-to-nats-migration.md) §4 Phase 5/6.

## Prerequisites (before ANY host is cut over)

1. **A NATS server per fleet** (or one central, mirroring the current single-relay topology), running
   `packages/operations/nats/nats-server.conf` — R1, `sync_interval: always`, static NKey users,
   isolated `$SYS`, no leafnodes. Install `nats-server` v2.14.3 (P0 pins it; runbook in
   `packages/operations/nats/README.md`).
2. **Provisioned JetStream/KV state**: run `packages/operations/nats/provision-jetstream.sh` as the
   in-account `hangar-admin` credential → `HANGAR_TASKS` WorkQueue (per-handle subjects/consumers) +
   `HANGAR_DEDUP` KV bucket. Re-run is idempotent.
3. **NKey seeds distributed**: one private seed per host at `~/.config/hangar-bridge/nats/<handle>.nk`
   (mode 0600), public keys already in `nats-server.conf`. Generate with `genkeys.sh` (seeds never
   committed; handle mode writes the 0600 file, never stdout).
4. **`fleet-roster.json`** distributed to every host (roster ⇔ conf NKey users must be the exact
   same set — the P0 `nats-config.test.ts` equality gate).
5. **Transport / firewall**: NATS client port reachable host↔server over the private overlay
   (Tailscale / mTLS — the plan's §6 residual; do NOT expose plain).

## P5 — cutover + soak (REVERSIBLE)

The cutover is a **config flip**, one host at a time, with the relay kept running the whole time.

1. On host H, set the peer-agent config `transport: 'nats'` + the `nats` block
   (`url`, `nkey_seed_path`, `roster_path`, optional `inbox_prefix`). Leave the relay config in place.
2. Restart H's peer-agent (or let its stdio parent respawn it). It now connects to NATS; the lifecycle
   shutdown (`lifecycle.ts`) makes it exit with its stdio parent so no orphan flaps presence.
3. Verify on H: `list_peers` shows other online hosts (heartbeat presence), a `dispatch_task` round-trips,
   a `@team` chat broadcasts. Watch for `peer.nats.dedup_unavailable` warns (bucket/grant issue).
4. Repeat per host. **Mixed mode is NOT cross-compatible** — SSE peers talk via the relay, NATS peers
   via NATS; they do not bridge. So cut over **all peers of a given fleet together**, or accept that
   SSE and NATS cohorts are isolated during the transition. (If seamless mixed-mode is required, that
   is a bridge component — out of scope, BACKLOG.)
5. **Soak window** (operator-defined, e.g. 24–72 h) with NATS primary. Watch: presence stability,
   task dispatch/result completeness, no JetStream loss (single-node R1 + `sync_interval: always`
   is the Jepsen mitigation — confirm `sync_interval: always` is actually in the running conf), KV
   dedup working across restarts.

**Rollback (any time during soak, config-only, fully credible):** set `transport: 'sse'` back on the
affected host(s) and restart. The relay is still running and the relay code + its 85 % coverage gate
are still in the tree, so this is a flip, not a code resurrection.

## P6 — relay deletion (IRREVERSIBLE — 鐵律 destructive-op procedure)

Do this ONLY after the Phase-5 soak succeeds and the Board explicitly confirms. This deletes the entire
`@hangar-bridge/relay` package and retires its coverage gate — reverting means resurrecting from git
history as a fresh change.

**Before deleting (mandatory):**
1. **Snapshot**: `git tag pre-relay-deletion` (and note the SHA) so the last relay-present state is
   trivially recoverable.
2. **State the blast radius** to the Board: the whole `packages/relay/` tree (~all `src/**`), the relay
   systemd unit, the relay 85 % coverage gate, and the `install-relay.sh` relay path.
3. **Explicit Board confirmation** for the irreversible step.

**Execute:**
4. Delete `packages/relay/` (the §3 file map is representative — remove the ENTIRE package incl. the
   files not individually listed: `acl.ts`, `presence/registry.ts`, `purge.ts`, `routes/*`, `cli/*`,
   `db/*`, `deps.ts`, `index.ts`, `logger.ts`, `middleware/*`, `auth/*`).
5. Remove the relay 85 % gate from the active test set (drop `packages/relay/vitest.config.ts` /
   the workspace test wiring). Keep shared 95 % / peer-agent 80 % enforced and green.
6. Retire the relay systemd unit; make `install-relay.sh` NATS-only.
7. **Doc reconciliation** (plan §3 pins this to Phase 6): update `docs/architecture.md`,
   `SUBJECT_ROUTING_SPEC.md`, and `README.md` to the NATS topology (subjected reactive-kind rejection,
   the `fleet.<sender>.to.<recipient>.<kind>` subject scheme, the two-tier delivery + KV dedup +
   heartbeat presence model). Fold the retired SSE/relay protocol sections into a "historical (v1
   relay)" note.
8. Full-repo `pnpm -r build && pnpm -r typecheck && pnpm -r test:ci` green; then merge to `develop`.

**Rollback after P6:** none by design — this is the point of no return. If any doubt remains at the
soak, stay in Phase 5 (relay-runnable) longer.

## Open inputs the Board must supply for P5

- Which fleet hosts + how to reach them (SSH / Tailscale), and the central NATS server location.
- Soak-window duration.
- Whether mixed SSE/NATS interop during transition is required (→ pulls the deferred bridge into scope)
  or whether a whole-fleet cutover is acceptable.
