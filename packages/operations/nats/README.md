# NATS control-plane (Phase 0)

This is the Phase 0 hardening artifact set for `packages/operations/nats`.

## Runtime versions

- `nats-server` v2.14.3, executable at `~/.local/bin/nats-server` (required)
- `nats` CLI v0.3.1, executable at `~/.local/bin/nats` (required)

All scripts and docs below assume those versions and paths first, then fallback to `PATH`.

## Key material handling

`nats-server.conf` contains only public NKeys (`U...`).
Private seeds are never committed.

Per-handle seed files are generated at install/re-seed time and stored at:

- `~/.config/hangar-bridge/nats/<handle>.nk`
- file mode `0600`

Typical rotation flow:

1. Generate a fresh seed for a handle (`packages/operations/nats/genkeys.sh`).
2. Replace `nats-server.conf` `nkey` for that handle with the new public key.
3. Reload the unit cleanly:
  `systemctl --user reload hangar-bridge-nats.service`

The service supports `ExecReload` (`SIGHUP`) for clean connection drain/reload.

## Provisioning

Provision app-layer JetStream/KV state from the config + roster:

```bash
cd packages/operations/nats
export NATS_ADMIN_SEED_PATH="$HOME/.config/hangar-bridge/nats/hangar-admin.nk" # seed file path
export ROSTER_FILE="${ROSTER_FILE:-./fleet-roster.json}" # optional
export NATS_URL="${NATS_URL:-nats://127.0.0.1:4222}"   # optional
export NATS_BIN="${NATS_BIN:-$HOME/.local/bin/nats}"    # optional
./provision-jetstream.sh
```

The script is idempotent; reruns reconcile the stream subjects, reuse durable
consumers, and keep `HANGAR_DEDUP` in place.

```text
stream created: HANGAR_TASKS
stream reconciled: HANGAR_TASKS
consumer exists: ...
kv exists: HANGAR_DEDUP
```

Use the output as smoke confirmation:
- `created` on first run when resources are missing
- `exists` or `reconciled` on rerun

`--nkey` expects a seed FILE PATH for `hangar-admin`, for example:
`$HOME/.config/hangar-bridge/nats/hangar-admin.nk`.

## `fleet-roster.json`

`fleet-roster.json` is the namespace ownership source-of-truth for the peer-agent
fleet handles.

- Keys are fleet handles.
- Values include `display_name`, `owned`, and `interest`.
- No handle is named `team`.

## Unit split rationale: `$SYS` vs `hangar-admin`

- `$SYS` account is server-operations-only (`$SYS.>`)
- `hangar-admin` is in `HANGAR` and owns provisioning subjects only.

`$SYS` never provisions app account streams/consumers/KV; JetStream APIs are account-
scoped, so provisioning belongs inside `HANGAR`.

## Seed hygiene checklist

- Never print seeds to shared logs or commit them.
- Keep seed files mode `0600`.
- Keep `nats-server.conf` at public keys only.
- When rotating, update `nats-server.conf` and `systemctl --user reload` the unit.
