# systemd — relay user unit

Persistent runtime for the hangar-bridge relay on **openclaw only**.
Gentoo doesn't need a unit here.

## Pivot from the plan letter

An earlier rollout plan (v1.2 row 19, P9a) originally called for **two** systemd user
services on openclaw: `hangar-bridge-relay` AND
`hangar-bridge-peer-agent`. After the implementation pass the
peer-agent unit was deliberately dropped:

> peer-agent's entry point is `server.connect(new StdioServerTransport())`
> (`packages/peer-agent/src/index.ts:92`). It's a stdio MCP server — its
> parent is whichever Claude Code session spawns it via the
> `~/.claude.json` MCP entry, and its lifetime is tied to that session.
> Running it as a daemonized systemd service would leave it blocked on
> a stdin that never gets written. The correct "persistence" for
> peer-agent is the `~/.claude.json` registration in
> [`../claude-config/`](../claude-config/), which spawns a fresh peer-agent
> per CC session — exactly the lifecycle stdio MCP is designed for. NATS mode currently adds a
> host-global same-handle lock, so only one of those sessions may use a given NATS fleet handle;
> SSE remains the multi-session-compatible default.

Filed as a clarifying note in this directory rather than retconning
the plan: the bug was in the plan's mental model of "service",
not in the code.

## Install

```bash
revision="$(git rev-parse HEAD)"
packages/operations/systemd/install-relay.sh --revision "$revision"
packages/operations/systemd/install-relay.sh --enable --revision "$revision"
```

`--revision` is mandatory and must be a full 40-hex commit SHA. The
installer normalizes it to lowercase, requires the active `node` binary
to report Node.js 22 or newer, resolves that binary to its real directory,
and atomically writes both the revision and pinned runtime `PATH` to the
mode-0600 `~/.config/hangar-bridge/relay.env`. The unit loads these as
`HANGAR_BUILD_REVISION` and `PATH`. Do not pass a branch name or abbreviated
SHA. Re-run the installer after replacing or removing the selected Node
installation.

The relay unit deliberately runs `%h/projects/hangar-bridge`. The installer
fails before writing anything unless that path resolves to the same repository
as the installer source and its `HEAD` equals `--revision`. After activation it
also checks the running service's `MainPID` cwd through `/proc`; a healthy
process from another checkout is not accepted as revision proof.

If the relay is already active, either command restarts it after the
new revision file and unit are ready. If it is inactive, only
`--enable` enables and starts it. A successful start is not enough:
the installer waits for `/health` to report the requested
`build_revision` and exits nonzero if it cannot verify the exact build.

The script:
1. Creates `~/.config/hangar-bridge/peers.json` as `{}` if missing
   (so the relay can boot — add real entries with SHA-256-hashed
   secrets per [the relay's peers-file.ts schema](../../relay/src/auth/peers-file.ts)).
2. Copies `hangar-bridge-relay.service` into
   `~/.config/systemd/user/`.
3. Verifies the unit repository's `HEAD` is the requested revision.
4. Atomically installs the exact build revision and validated Node path EnvironmentFile.
5. `systemctl --user daemon-reload`.
6. Restarts an active relay, or optionally `enable --now` for an
   inactive relay.
7. Verifies `GET /health` reports that exact `build_revision` and the
   service `MainPID` runs from the verified repository.

## What's in the unit

- `Type=simple` — relay logs to journald and stays in the foreground.
- `Environment=HANGAR_DATA=%h/.local/share/hangar-bridge` — SQLite
  DB + idempotency cache live under `$HOME/.local/share/`.
- `EnvironmentFile=%h/.config/hangar-bridge/relay.env` — immutable
  build identity and installer-validated Node `PATH` for the running process.
- `Environment=HOST=192.168.101.6 PORT=8443` — binds LAN so gentoo
  can reach it. To rebind (subnet move, VPN), edit the unit + reload.
- `PATH=<validated-node-dir>:/usr/local/bin:/usr/bin:/bin` in `relay.env` —
  the installer resolves the current Node binary and pins its real directory.
  This avoids relying on shell initialization or an NVM alias file that systemd
  cannot execute as a directory.
- `Restart=on-failure RestartSec=5s StartLimitBurst=5` —
  five rapid failures inside 60s trip the burst limiter so a
  pathologically broken binary doesn't spin-loop the CPU.
- `WantedBy=default.target` — Linger-friendly so the service comes
  up at system boot even without an active user session.

## When it breaks

- `systemctl --user status hangar-bridge-relay` — quick health.
- `journalctl --user -u hangar-bridge-relay -n 100 --no-pager` —
  startup + per-request logs.
- `lsof -i:8443` — port collision (P7/P8 temp orchestrators bind the
  same port; stop them before enabling).
- "peers file not found" — the install script seeds `{}` but if
  someone deleted it, re-run install-relay.sh.

## Rollback and uninstall

Stopping or removing the unit is **not** a release rollback. A release rollback must restore the
pre-upgrade SQLite backup together with its exact prior source revision; follow
[`docs/DEPLOYMENT.md`](../../../docs/DEPLOYMENT.md#5-rollback). That procedure preserves the failed
candidate data for forensics and verifies the restored SHA through `/health`.

If the operator instead intends to uninstall the service while preserving its data, use a
recoverable unit move:

```bash
systemctl --user disable --now hangar-bridge-relay
mv ~/.config/systemd/user/hangar-bridge-relay.service \
  ~/.config/systemd/user/hangar-bridge-relay.service.disabled
systemctl --user daemon-reload
```

The `~/.local/share/hangar-bridge/` data directory and disabled unit survive for recovery. This
uninstall path does not claim to restore a prior release.
