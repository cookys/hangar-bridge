Task: relay groups — Phase P2 (peer-agent side) in this repository (hangar-bridge, pnpm, TypeScript, vitest).
Plan: `docs/plans/2026-09-16-relay-groups.md` §2.1.9, §4 P2 — read them and `packages/shared/src/{constants,envelope}.ts`
first. P0 + P1 are merged: the relay (strict mode) stamps `group` on every envelope, accepts `to: '@group'` and an
optional `group` on POST /v1/messages, exposes `GET /v1/whoami` → `{handle, default_group, groups:[{id, caps, history}]}`,
returns `groups: [{id, caps}]` on each `/v1/peers` entry, and closes a stream with `event: reauth` +
`data: {"reason":"membership_changed"|"removed"}` when membership shrinks. **In legacy mode (and against an older
relay) none of those fields exist** — every change below must degrade to today's behaviour when they are absent.

Write ONLY under `packages/peer-agent/src/` (source + colocated `*.test.ts`). Do not touch `packages/relay/`,
`packages/shared/`, docs, or `bin/`. Do not commit (the harness commits). Tests first (red on base), then green.
Done = `scripts/verify-groups-p2.sh` exits 0 (shared + relay + peer-agent suites and typechecks) with all 524
pre-existing peer-agent tests unchanged. Do not edit `scripts/`.

## Global constraints (plan §2.5, the ones that bind this side)
1. `from` / `group` are relay-stamped; the peer-agent never invents or overrides them on inbound envelopes.
4. legacy relay / legacy mode ⇒ byte-identical behaviour: no new fields on the wire, no new text in tool output.
7. no new trust machinery.
8. red → green.

## 1. Config (`config.ts`)
- `default_group?: string` (regex `GROUP_ID_REGEX` from shared). Optional.
- Startup validation (`index.ts`, after the token is read, before the stream opens): `GET {relay_url}/v1/whoami` with the
  bearer. `404` ⇒ old relay / legacy: record `groupsMode='legacy'`, ignore `default_group`. `200` ⇒ `groupsMode='strict'`;
  if `cfg.default_group` is set and not in `whoami.groups[].id` → throw
  `Error('default_group <x> is not one of this handle\'s memberships: <ids>')` (startup fails, reason printed). Keep the
  whoami result on the runtime context (`self.groups`, `self.default_group`) for list_peers / instructions.

## 2. Tools (`tools.ts`, `tool-exposure.ts` if the allow-list needs the new field)
- `send_to_peer` input schema: `to` also accepts the literal `'@group'`; new optional `group: string` (GROUP_ID_REGEX,
  description: "group to send in; defaults to the relay's default_group for this handle. Only groups you belong to
  (see list_peers / whoami)"). Pass `group` through to POST /v1/messages unchanged. `fleet_wide` semantics on
  `@group` = every member of that group; the existing `BROADCAST` content gate applies to `@group` exactly as to `@team`.
- `@team`: still accepted; log ONE `logJson('warn','peer.deprecated_team_alias',…)` per process the first time it is used
  and add nothing to the tool response.
- `reply_to_peer`: unchanged (the relay scopes replies).
- `list_peers` output: when any entry carries `groups`, render grouped:
  ```
  == cookys  (caps: chat broadcast dispatch permission claim)
  cuda        online  ...existing per-peer line...
  ...
  == lab  (caps: chat)
  ...
  ```
  A handle in two shared groups appears under both. Caps shown are the CALLER's caps in that group (from whoami).
  When no entry carries `groups` (legacy), output is byte-identical to today.
- `poll_inbox`: when an envelope has `group`, append ` group=<id>` to that line's header; legacy lines unchanged.
- Add `whoami` to the tool surface? NO — keep the tool set unchanged (tools.allow lists are deployed per courier).
  Expose the whoami result through `list_peers` (first line `you: <handle> default_group=<id>` only in strict mode).

## 3. Inbound (`inbound.ts` / `index.ts`)
- The claude-channel notification params gain `group: envelope.group` ONLY when the envelope carries it (strict relay);
  legacy notifications are byte-identical. The rendered tag therefore reads
  `<channel source="hangar-bridge" from="…" group="…" msg_id="…">`.
- `instructions.ts` (the MCP server instructions string): add one sentence explaining the `group` attribute and that
  `to: "@group"` / `group:` exist, phrased so a legacy deployment is not misled ("when the relay reports groups").

## 4. Stream (`stream.ts`)
- Handle `event: reauth`: parse `{reason}`; log `peer.stream.reauth {reason}`; close the current response and go through
  the EXISTING reconnect path with backoff reset (it is not a delivery failure — must not count toward the final-mile
  give-up counter). On `reason === 'removed'` still reconnect once; the relay's 401 then follows the existing
  auth-failure handling.
- Unknown events keep being ignored (already true — add a test that `reauth` before P2 would have been ignored and now
  triggers reconnect).

## 5. Permission relay (`approval-routing.ts`, `config.ts`)
- `permission_relay.routing` enum gains `'ask_group'` → picks `['@group']`; `'ask_team'` stays and picks `['@team']`
  (the relay aliases it). NATS restriction that applies to `ask_team` applies to `ask_group` too.

## 6. Tests (all colocated; extend existing files where the feature lives)
- `config.test.ts`: `default_group` accepted / rejected by regex; `ask_group` accepted; NATS + ask_group rejected.
- `index.test.ts` or a new `whoami.test.ts`: 404 ⇒ legacy; 200 with mismatch ⇒ startup throws with the ids listed;
  200 with match ⇒ ok.
- `tools.test.ts`: schema accepts `to:'@group'` and `group`; POST body carries `group`; `@team` warns once;
  `list_peers` grouped rendering (two groups, a handle in both) and legacy byte-identity (snapshot the current output
  first — write the assertion from the CURRENT code before changing it); `poll_inbox` group suffix.
- `inbound.test.ts` / `index.test.ts`: notification params include `group` iff present.
- `stream.test.ts`: `reauth` → reconnect without incrementing the give-up counter; legacy stream unchanged.
- `approval-routing.test.ts`: `ask_group` → `['@group']`.

## Acceptance
- peer-agent suite green: 524 pre-existing unchanged + new; typecheck clean (`corepack pnpm -F @hangar-bridge/peer-agent run typecheck`).
- `scripts/verify-groups-p2.sh` exits 0 (shared + relay untouched, peer-agent green).
- `git diff --stat` only under `packages/peer-agent/src/`.
