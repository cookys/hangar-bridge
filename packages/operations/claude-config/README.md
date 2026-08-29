# claude-config — MCP server registration

Hooks the `hangar-bridge-peer-agent` MCP server into a host's
`~/.claude.json` so Claude Code can discover its tools (`send_to_peer`,
`list_peers`, `set_summary`, `dispatch_task`, relay-backed claim tools when available, and
optionally `respond_to_permission`) on the next session start.

## When to run

After:

1. `pnpm install && pnpm -r build` has produced
   `packages/peer-agent/dist/index.js`.
2. A relay is reachable (locally on openclaw via systemd unit, or
   over LAN from gentoo). See `../systemd/` for systemd units.
3. Per-host peer secret is dropped at
   `~/.config/hangar-bridge/secret` (mode 0600) and the relay's
   `peers.json` has this peer's SHA-256.

Node visibility prerequisite: **none** — the install kit points
Claude Code at `packages/peer-agent/bin/peer-agent.sh`, which
auto-locates node via `$NODE_BIN` → `~/.nvm/alias/node22/bin/node`
→ PATH → `nvm.sh` sourcing. Hosts using nvm don't need a symlink,
PATH patch, or claude.json edit after a node patch bump.

## Install

```bash
packages/operations/claude-config/install-mcp.sh           # writes ~/.claude.json
packages/operations/claude-config/install-mcp.sh --dry-run # diff only, no write
```

The script is idempotent. It backs up `~/.claude.json` to
`~/.claude.json.bak.<timestamp>` before patching. To roll back,
restore the most recent backup. `--dry-run` is strictly read-only: it
does not create a missing config, backup, or temporary file.

The managed entry always sets
`HANGAR_MCP_KEY=hangar-bridge-peer-agent`. This must match the
`server:hangar-bridge-peer-agent` launch argument so the peer-agent's
startup deaf-check can distinguish a correctly loaded channel from a
session that cannot receive notifications. Other environment keys on
the managed entry are preserved. Installer diff output is
limited to this managed entry and redacts all field values while
retaining key names and structure for review.

## Verify

Start a **new** Claude Code session (the existing one won't pick up
the change):

```bash
claude --dangerously-load-development-channels server:hangar-bridge-peer-agent
```

Then inside CC:

```
/mcp
```

Expected output: `hangar-bridge-peer-agent` connected, tool list
includes `dispatch_task` next to `send_to_peer`. If `dispatch_task`
is missing, you're either on a pre-v0.4.0 build (rebuild) or the
peer-agent failed to start (check `~/.cache/claude/logs/` or run
`node packages/peer-agent/dist/index.js < /dev/null` to surface the
error).

On the default SSE transport, the tool list also includes `claim_asset`, `list_claims`, and
`release_claim`. On NATS those tools appear only when the legacy relay URL/token still configure a
working claim compatibility client; NATS messaging does not fail when they are unavailable. See
[`docs/CLAIMS.md`](../../../docs/CLAIMS.md).

## K1 mitigation

`package.json` pins `engines.claude-code: ">=2.1.81"` —
`notifications/claude/channel/permission` landed in 2.1.81. Below
that, permission requests still emit a generic `claude/channel`
notification but lose the typed permission-request shape.
