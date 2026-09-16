# relay groups — deploy record (P3b, 2026-09-16)

Candidate `develop@0c875edc0f9a11b276aaeab7a4273e6d4a0f495c` (merge of `feat/relay-groups`). Hub = openclaw (this host).

| step | evidence |
|---|---|
| §2.1 backup | `/home/cookys/.local/state/hangar-bridge/backups/20260916T034653Z-0c875edc0f9a11b276aaeab7a4273e6d4a0f495c/` — sqlite (.backup, integrity ok, 711 messages, schema v9), peers.json (flat), relay.env, installer, unit, metadata (previous_live 5fa9e56) |
| §1 admission | fetch parity, install --frozen-lockfile, `pnpm -r build`, `audit --prod --audit-level high` ok; peer-agent dist `b775ac614b4273dd` |
| §2.2 install | `install-relay.sh --revision 0c875ed --enable` → active, `/health.build_revision` = candidate, cwd verified; journal: `migrate.v9_to_v10 {group:cookys}` **once** (two DB opens, run-once guard held), `peers.legacy_mode peers:10`; all 10 handles back online |
| §2.4 groups | `peers-groups-init --write` → v2 (10 peers, `cookys`/all), backup `peers.json.bak.1789530506`; `systemctl --user reload` → `relay.roster.reloaded seeded:10`; `/v1/peers` every entry `groups:[cookys]`; `fleet peers` prints `== group cookys`; `fleet whoami` lists default + caps; no `peer.removed` |
| live guest acceptance | throwaway `guest-acceptance` in `guest-lab` (caps chat, since_join) with openclaw as co-member, SIGHUP: whoami ✓ · peers = {guest, openclaw} only ✓ · cold-start stream from an old cursor → zero events ✓ · to:cuda 404 unknown_recipient **byte-equal** to to:nonexist ✓ · @group 403 cap_denied ✓ · task_dispatch 403 ✓ · claim 403 ✓ · chat to openclaw 201 with `group:"guest-lab"` and received by the hub session ✓ · /metrics 404 (no token configured) ✓ · removal + SIGHUP → whoami 401, human disabled, 0 live tokens, audit `peer.removed` ✓; secret destroyed |
| §3 peers | rebuilt to candidate, dist `b775ac614b4273dd` on: aimax395, cookys-gentoo, crosshair8-hero (kimi courier restarted, active), 7840hs, twgs-revival cookys / twgs-dev / codepower (node 18, build only); itx-chatgpt courier rebuilt + watchdog-respawned (readyz 200, online). `twgs@twgs-revival` has no clone and no roster handle — skipped. |
| not yet | running Claude sessions keep the old peer-agent dist until they restart (channel `group=` attribute appears after that); `HANGAR_METRICS_TOKEN` not set (no scraper) |

Rollback: restore `/home/cookys/.local/state/hangar-bridge/backups/20260916T034653Z-0c875edc0f9a11b276aaeab7a4273e6d4a0f495c/{hangar-bridge.sqlite,peers.json}` + `install-relay.sh --revision 5fa9e56bfdd216cdff0d3bb987ec00ef3ac52642`.
