# Cutover Runbook — P5 fleet cutover + P6 relay deletion

> **Status:** Board-gated. The 2026-07-21 closeout is not considered delivered merely because this
> file exists: verify the pushed `origin/main` SHA in [`docs/HANDOFF.md`](../../HANDOFF.md) first.
> The NATS substrate remains behind `transport: 'nats'`, **SSE is the default and the relay is
> untouched**, so nothing has changed operationally yet. This runbook is for when the Board
> authorises cutover. Spec: [../../plans/2026-07-02-relay-to-nats-migration.md](../../plans/2026-07-02-relay-to-nats-migration.md) §4 Phase 5/6.

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
6. **Claim compatibility decision for P5**: if the fleet uses `claim_asset` / `list_claims` /
   `release_claim`, keep each host's valid `relay_url` + `token_path` and keep the relay claim API
   reachable. NATS startup is independent, but claim tools are omitted unless a bounded
   authenticated claims-list probe succeeds. Contract: [`docs/CLAIMS.md`](../../CLAIMS.md).

## P5 — cutover + soak (REVERSIBLE)

The cutover is a **config flip**, one host at a time, with the relay kept running the whole time.

1. On host H, set the peer-agent config `transport: 'nats'` + the `nats` block
   (`url`, `nkey_seed_path`, `roster_path`, optional `inbox_prefix`). Leave `relay_url` and
   `token_path` in place for rollback and, when used, relay-backed claims.
2. Stop any other same-handle Claude session, then restart H's peer-agent (or let its stdio parent
   respawn it). NATS currently permits one live local process per fleet handle. The lifecycle
   shutdown (`lifecycle.ts`) makes it exit with its stdio parent so no orphan flaps presence.
3. Verify on H: `list_peers` shows other online hosts (heartbeat presence), `dispatch_task` reaches
   the receiver and its completion returns through `send_to_peer` chat, and ambient plus
   subject-scoped `@team` chat broadcast correctly. Structured MCP `task_result` emission remains
   deferred. If claims are in use, verify `claim_asset` + `list_claims` against the still-running
   relay. Sustained `peer.nats.dedup_unavailable` means durable task consumption is held closed;
   also watch for `peer.claims.unavailable`.
4. Repeat per host. **Mixed mode is NOT cross-compatible** — SSE peers talk via the relay, NATS peers
   via NATS; they do not bridge. So cut over **all peers of a given fleet together**, or accept that
   SSE and NATS cohorts are isolated during the transition. (If seamless mixed-mode is required, that
   is a bridge component — out of scope, BACKLOG.)
5. **Soak window** (operator-defined, e.g. 24–72 h) with NATS primary. Watch: presence stability,
   task delivery/chat-completion completeness, claim visibility/renewal if retained, no JetStream loss
   (single-node R1 + `sync_interval: always`
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
2. **Resolve the claim authority first**: port schema-v6 claim semantics to a replacement authority
   (with equivalent owner/TTL/conflict/idempotent-release behavior and migration tests), or obtain an
   explicit Board decision to retire the three claim tools and their persisted state. P6 is blocked
   until one outcome is complete.
3. **State the blast radius** to the Board: the whole `packages/relay/` tree (~all `src/**`), the relay
   systemd unit, the relay 85 % coverage gate, `install-relay.sh`, HTTP/SSE messaging, and the current
   SQLite claim API/data.
4. **Explicit Board confirmation** for the irreversible step.

**Execute:**
5. Delete `packages/relay/` (the §3 file map is representative — remove the ENTIRE package incl. the
   files not individually listed: `acl.ts`, `presence/registry.ts`, `purge.ts`, `routes/*`, `cli/*`,
   `db/*`, `deps.ts`, `index.ts`, `logger.ts`, `middleware/*`, `auth/*`).
6. Remove the relay 85 % gate from the active test set (drop `packages/relay/vitest.config.ts` /
   the workspace test wiring). Keep shared 95 % / peer-agent 80 % enforced and green.
7. Retire the relay systemd unit; make `install-relay.sh` NATS-only.
8. **Doc reconciliation** (plan §3 pins final retirement wording to Phase 6): update `docs/architecture.md`,
   `SUBJECT_ROUTING_SPEC.md`, and `README.md` to the NATS topology (subjected reactive-kind rejection,
   the `fleet.<sender>.to.<recipient>.<kind>` subject scheme, the two-tier delivery + KV dedup +
   heartbeat presence model). Fold the retired SSE/relay protocol sections into a "historical (v1
   relay)" note.
9. Full-repo `pnpm -r build && pnpm -r typecheck && pnpm -r test:ci` green; then merge to `main`.

**Rollback after P6:** none by design — this is the point of no return. If any doubt remains at the
soak, stay in Phase 5 (relay-runnable) longer.

## Open inputs the Board must supply for P5

- Which fleet hosts + how to reach them (SSH / Tailscale), and the central NATS server location.
- Soak-window duration.
- Whether mixed SSE/NATS interop during transition is required (→ pulls the deferred bridge into scope)
  or whether a whole-fleet cutover is acceptable.
- Whether claims remain required after P6; if yes, approve a replacement authority and migration
  plan before any relay deletion.
