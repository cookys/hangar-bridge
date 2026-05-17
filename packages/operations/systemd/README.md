# systemd — relay user unit

Persistent runtime for the hangar-bridge relay on **openclaw only**.
Gentoo doesn't need a unit here.

## Pivot from the plan letter

[`docs/projects/2026-05-17-hangar-bridge/README.md`](../../../docs/projects/2026-05-17-hangar-bridge/README.md)
(plan v1.2 row 19, P9a) originally called for **two** systemd user
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
> per CC session — exactly the lifecycle stdio MCP is designed for.

Filed as a clarifying note in this directory rather than retconning
the plan: the bug was in the plan's mental model of "service",
not in the code.

## Install

```bash
packages/operations/systemd/install-relay.sh            # install + daemon-reload, do not enable
packages/operations/systemd/install-relay.sh --enable   # install, enable, start, smoke /health
```

The script:
1. Creates `~/.config/hangar-bridge/peers.json` as `{}` if missing
   (so the relay can boot — add real entries with SHA-256-hashed
   secrets per [the relay's peers-file.ts schema](../../relay/src/auth/peers-file.ts)).
2. Copies `hangar-bridge-relay.service` into
   `~/.config/systemd/user/`.
3. `systemctl --user daemon-reload`.
4. Optionally `enable --now` + smoke-tests `GET /health` on
   `192.168.101.6:8443`.

## What's in the unit

- `Type=simple` — relay logs to journald and stays in the foreground.
- `Environment=HANGAR_DATA=%h/.local/share/hangar-bridge` — SQLite
  DB + idempotency cache live under `$HOME/.local/share/`.
- `Environment=HOST=192.168.101.6 PORT=8443` — binds LAN so gentoo
  can reach it. To rebind (subnet move, VPN), edit the unit + reload.
- `Environment=PATH=%h/.nvm/versions/node/v22.22.3/bin:/usr/local/bin:/usr/bin:/bin` —
  fallback chain covers both openclaw (system node 24) and gentoo
  (nvm node 22). Future node bumps mean editing the PATH version
  pin in one place.
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

## Rollback

```bash
systemctl --user disable --now hangar-bridge-relay
rm ~/.config/systemd/user/hangar-bridge-relay.service
systemctl --user daemon-reload
```

The `~/.local/share/hangar-bridge/` data dir survives so any in-flight
messages persist across re-enables.
