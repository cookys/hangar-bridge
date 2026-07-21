# Cooperative asset claims — contract and compatibility

Last verified against `packages/shared/src/constants.ts`, `packages/peer-agent/src/{tools,outbound}.ts`,
and `packages/relay/src/{routes/claims,claims/store,db}.ts`: 2026-07-21.

Claims are **advisory team-scoped locks**, not authorization barriers. A live claim has one owner per
`(team_id, claim_key)`, expires by TTL, can be renewed by the same owner, and conflicts when another
owner holds the key. Expired claims are treated as free. Any authenticated relay peer may claim a
valid key; namespace ACL ownership does not grant or restrict claims.

## Supported claim kinds

There is exactly one claim kind: a generic **asset claim**. There is no `kind` field, enum, or
server-enforced prefix taxonomy. The `key` carries the asset identity.

All keys matching this contract are supported:

```text
regex:  ^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$
length: 1..256 characters
```

Prefixes such as `repo:hangar-bridge`, `file:hangar-bridge:packages/relay/src/app.ts`, and
`config:fleet-roster` are conventions only. Callers that need interoperable naming must agree on
the same key string; the service does not interpret these prefixes.

## MCP tools

### `claim_asset`

Strict input object (unknown fields are rejected):

```ts
{
  key: string                 // required; regex/length above
  ttl_seconds?: integer       // 1..86400; default 3600
  note?: string               // 0..512 characters
}
```

The MCP result is a text content block, not a structured JSON result:

```text
claimed "<key>" until <ISO-8601>
renewed "<key>" until <ISO-8601>
claim_conflict: "<key>" is held by <owner_handle> until <ISO-8601>
```

A same-owner live acquire renews the TTL, preserves `created_at`, and replaces `owner_label`/`note`
with the current request values. A free or expired key creates a new claim.

### `list_claims`

Strict input object:

```ts
{}
```

The MCP result is a text content block containing a pretty-printed JSON array. Only live claims for
the fixed `hangar` team are returned, ordered by `claim_key`:

```ts
Array<{
  team_id: string             // currently "hangar"
  claim_key: string
  owner_handle: string
  owner_label: string | null
  note: string | null
  created_at: string          // ISO-8601
  expires_at: string          // ISO-8601
}>
```

### `release_claim`

Strict input object:

```ts
{ key: string }
```

Text results:

```text
released "<key>"
no live claim on "<key>"
cannot release "<key>": held by <owner_handle>
```

Release is owner-only for a live claim. Releasing an absent/expired key is idempotent success.

## Relay HTTP API

All endpoints require the normal bearer token and are rate-limited to 120 requests/minute/token.

| Operation | Endpoint | Success | Conflict |
|---|---|---|---|
| Acquire/renew | `POST /v1/claim` with `claim_asset` input | `201 { claim: Claim, renewed: boolean }` | `409 { error: "claim_conflict", owner, expires_at }` |
| List live | `GET /v1/claims` | `200 Claim[]` | n/a |
| Release (canonical) | `POST /v1/claim/release` with `{ key }` | `200 { released: boolean }` | `409 { error: "claim_conflict", owner, expires_at }` |
| Release (compatibility) | `DELETE /v1/claim` with `{ key }` | same | same |

The peer-agent deliberately uses the POST release route because some clients/proxies discard DELETE
request bodies. Invalid or non-strict bodies return `400 { error: "invalid_body", issues: ... }`.

## Persistence schema

Claims were added by the SQLite v5→v6 migration:

```sql
CREATE TABLE claim (
  team_id     TEXT NOT NULL REFERENCES team(id),
  claim_key   TEXT NOT NULL,
  owner_handle TEXT NOT NULL,
  owner_label TEXT,
  note        TEXT,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  PRIMARY KEY (team_id, claim_key)
);

CREATE INDEX idx_claim_expires ON claim(team_id, expires_at);
```

The schema stores expired rows until a later acquire/release overwrites or deletes them; list and
conflict checks filter them by `expires_at`.

## Transport compatibility

| Peer messaging transport | Claim behavior |
|---|---|
| SSE/relay (default) | Full claim support through the same authenticated `RelayClient`. The three tools are advertised. |
| NATS during P5 with valid, reachable relay URL/token | Messaging uses NATS; claims continue through the relay compatibility client. A bounded authenticated `GET /v1/claims` probe succeeds before the three tools are advertised. |
| NATS without usable relay credentials or reachability | NATS messaging starts; the bounded probe fails closed with a warning and the three claim tools are omitted. |
| Post-P6 relay deletion | **Not supported yet.** Claims must be ported to a new authority or deliberately retired before P6. |

SSE and NATS message traffic are not bridged during mixed mode. This does not change the claim
authority: while the relay remains available, both cohorts can still observe the same SQLite-backed
claim set if they retain valid relay credentials.

## Deferred decisions

- Choose and implement a post-relay claim authority (for example, a carefully specified NATS KV/CAS
  contract), or formally retire claims before P6.
- Decide whether key prefixes become a versioned taxonomy. Today they remain conventions, which is
  the backward-compatible behavior.
- Add a real multi-host claim compatibility smoke during P5; current coverage is local
  unit/integration coverage of the relay API and peer-agent client/tool surface.
