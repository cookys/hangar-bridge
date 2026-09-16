Task: relay groups — Phase P3a (migration tool + operator docs) in this repository (hangar-bridge, pnpm, TypeScript,
vitest). Plan: `docs/plans/2026-09-16-relay-groups.md` §2.1.10, §4 P3 steps 1–2. P0–P2 are merged on this branch.
Write ONLY: `packages/relay/src/cli/peers-groups-init.ts` (new) + `peers-groups-init.test.ts` (new),
`packages/relay/src/index.ts` (register the subcommand), `docs/DEPLOYMENT.md`, `docs/architecture.md`,
`docs/PROJECT_ISOLATION.md`, `README.md` (one short section). Do not commit. Done = `scripts/verify-groups.sh` exits 0.

## 1. `peers-groups-init` relay subcommand
`node packages/relay/dist/index.js peers-groups-init [--peers <path>] [--write] [--group <id>]`
- Reads the peers file with the P0 `loadPeersFile` (so a v2 file is detected as `strict`).
- If already strict: print `peers.json is already v2 (strict); nothing to do` and exit 0.
- If legacy: build the v2 document: `peers` = every entry with its existing `secret_sha256_hex`, `display_name`,
  `subjects` (only if present) and `default_group: <group>`; `groups` = `{ "<group>": { description: "migrated single
  group", history: "all", members: { <handle>: { caps: [all five] } … } } }`. `<group>` defaults to `DEFAULT_GROUP_ID`
  (`cookys`); `--group` overrides (must match `GROUP_ID_REGEX`).
- Dry-run by default: print the v2 JSON to stdout and `dry-run: pass --write to replace <path> (a .bak.<epoch> copy is
  kept)` to stderr; exit 0.
- `--write`: copy the original to `<path>.bak.<epoch>` (mode 0600), write the v2 JSON (mode 0600, 2-space indent,
  trailing newline), then re-run `loadPeersFile` on the written file and assert `mode === 'strict'` and that every
  original handle is present with the same secret hash (throw + leave the .bak if not). Print
  `wrote <path> (v2, N peers in group <group>); backup <path>.bak.<epoch>`.
- Never prints secrets; never touches the DB.
Tests: legacy → dry-run output shape; `--write` round trip (tmp dir), .bak exists, hashes preserved, strict on reload;
already-strict file → no-op; `--group bad!` → non-zero exit; file with a handle literally named `groups` still converts.

## 2. `docs/DEPLOYMENT.md` — new section "§2.4 Groups rollout (relay ≥ groups)" placed after §2.2, and touch §5 Rollback
Write it as the operator will run it, in order:
1. On the hub, BEFORE restarting the new relay: `node packages/relay/dist/index.js peers-groups-init` (dry-run, read it),
   then `… --write`. State plainly: the new relay starts in **legacy** mode on the old flat file (byte-identical behaviour)
   and in **strict** mode on the v2 file; `strict → legacy` is refused (§2.1.10): once a v2 file has been loaded and a
   non-`cookys` group exists, starting the relay on a flat file exits 1 — rollback of the roster means restoring the
   `.bak` AND the sqlite backup from §2.1.
2. Optional `HANGAR_METRICS_TOKEN=<random>` in `~/.config/hangar-bridge/relay.env` (peer bearers are 401 on `/metrics`
   either way; without the variable the route is 404). Today no scraper exists — say so.
3. Restart through `install-relay.sh` as in §2.2 (the §2.1 backup already covers the sqlite file + peers.json).
4. Verify: `curl -s $relay/health | jq .build_revision`; `curl -s -H "authorization: Bearer $(cat ~/.config/hangar-bridge/secret)"
   $relay/v1/whoami` → `{"handle":"openclaw","default_group":"cookys","groups":[{"id":"cookys",...}]}`;
   `fleet peers` prints `== group cookys`.
5. Peer hosts: rebuild as §3 (the peer-agent tolerates an old relay and vice versa; new peer-agent + new relay is
   what enables `group` on the channel tag). Couriers restart as before.
6. "Adding a guest group" recipe: edit v2 `peers.json` — add the handle under `peers` with `default_group: "<guest-group>"`
   and a `groups.<guest-group>` entry `{ history: "since_join", members: { "<handle>": { caps: ["chat"] } } }`; optionally
   add one of your own handles to that group so you can talk to them; `systemctl --user reload hangar-bridge-relay`
   (SIGHUP) — no restart; verify with the guest's bearer: `/v1/peers` shows only the guest group, `/v1/whoami` shows
   caps `["chat"]`. Removing the guest: delete both entries, SIGHUP → its stream gets `event: reauth`, the next request
   is 401 (`human.disabled_at` + token revoked), audit `peer.removed`.
7. Rollback (§5): restore `peers.json.bak.<epoch>` + the §2.1 sqlite backup, reinstall the previous revision.

## 3. `docs/architecture.md`
- §5.1: replace the "single-tenant / D10" framing: `team_id` stays constant (`'hangar'` = this relay installation);
  visibility is per **group** (`peer_group` / `group_member`, multi-membership); `peers.json` v2 shape; legacy flat file
  ⇒ one `cookys` group; every message/claim/reply route carries a relay-stamped `group_id`; read side filtered by the
  reader's memberships + `since_msg_id` in SQL; non-members get "does not exist" responses (404 same body); per-member
  caps; SIGHUP shrink ⇒ `reauth`; vanished handles revoked in strict mode. One paragraph + the v2 JSON example.
- §5.7 durable model: add `peer_group`, `group_member`, `message.group_id`, `reply_route.group_id`, `claim` PK, schema v10.
- §5.2: add `GET /v1/whoami`; note `/metrics` token gate.
Keep the doc's existing voice and "last verified" line (update the date to 2026-09-16).

## 4. `docs/PROJECT_ISOLATION.md`
Add a short section: project isolation (same host, per-project handle via `init-project`) and groups (who may see whom)
are orthogonal; a per-project handle gets its own `default_group`, which is how "group = domain, handle = project agent"
(plan §2.1.11) is expressed.

## 5. `README.md`
One "Groups" paragraph under the feature list pointing at DEPLOYMENT §2.4 and architecture §5.1.

## Acceptance
- `scripts/verify-groups.sh` exits 0 (new CLI tests included in the relay suite); typecheck clean.
- `git diff --stat` only the files listed at the top.
