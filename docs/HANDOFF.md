# Handoff — hangar-bridge closeout to llm-playground Plan 029 P10

> **Prepared:** 2026-07-21 (Asia/Taipei)
> **Source repository:** `/home/cookys/projects/hangar-bridge`
> **Receiving repository:** `/home/cookys/projects/llm-playground`
> **Receiving baseline:** `master@777b26f041d1c31b56bcf8421bcb7274caf5f260` (clean when verified)
> **Next scope:** `doc/plan/029-weak-agent-sop.md`, P10 only

## Goal

Continue Plan 029 P10 in `llm-playground` using the claim and fleet-coordination contract that is
actually shipped by `hangar-bridge`. Do not reopen the transport closeout, perform the NATS P5/P6
cutover, or assume the Plan 029 sketch is already a valid tool schema.

## Current state and delivery identity

The closeout integrates the original `main@c5a310327aaacbe665fdf97b09221a9bc0821fa8`
fleet-coordination work with `develop@a9d72eb9227f9343577ba3f7f77c88f55d16190a` NATS P0–P4.
The independently reviewed source integration commit is
`d0b67b2b3469398095a8ec0131bfd4707434f716`; the official `main` integration merge is
`134e2bc0463616f9dfc3378c86a72050e5d72150`. Both input tips are ancestors of that merge. The final
documentation/archive commit necessarily follows it, so the authoritative final remote tip is
`git rev-parse origin/main` and is reported to the operator at delivery. This two-step record avoids
claiming that a commit can contain its own SHA.

Final independent review returned PASS for staged tree
`fceaad842eb929966e7ecb16ab7afe34c7b4c730` (`fingerprint_final_review`, 2026-07-21). The local
`chore/hangar-bridge-closeout` branch was deleted after its tip was proven merged; the remote branch
did not exist.

At handoff preparation time, `llm-playground` is clean on the receiving baseline above. No Plan 029
P10 files have been changed by this closeout.

## Fixed decisions — do not reopen without a versioned API change

### Claim model and supported kinds

There is exactly **one supported claim kind: a generic asset claim**. Claims are advisory,
team-scoped TTL locks, not authorization. There is no `kind` field, kind enum, or server-enforced
key-prefix taxonomy. Prefixes such as `repo:`, `file:`, `config:`, and `gpu:` are caller conventions.

Runtime `claim_asset` input is strict; unknown fields are rejected:

```ts
{
  key: string                 // required; ^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$
  ttl_seconds?: integer       // 1..86400; default 3600
  note?: string               // 0..512 characters
}
```

The result is an MCP text block: `claimed`, `renewed`, or `claim_conflict`, with the key, expiry,
and conflict owner where applicable. A live claim by the same owner renews it. TTL is capped at 24
hours, so replacing the git-backed `ACTIVE-CLAIMS.md` persistence layer requires an explicit refresh
or dual-write policy; do not silently treat one call as an indefinite claim.

Runtime `list_claims` input is also strict:

```ts
{}
```

It returns one MCP text block containing a pretty-printed JSON array of live claims, ordered by
`claim_key`:

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

`release_claim` is also shipped with strict input `{ key: string }`; only the live owner may release
a claim, and releasing an absent or expired key is idempotent success.

### Plan 029 schema mismatch

Plan 029 P10 currently sketches `list_claims --kind gpu` and the fleet SOP mentions
`claim_asset --kind gpu`. Those calls are invalid today: an unknown `kind` is rejected. For P10,
either:

1. keep the current API, encode GPU/serve identity in the key (for example
   `gpu:cookys-cuda/all:8001`), call `list_claims({})`, and filter `claim_key` locally; or
2. write and review an explicit versioned hangar-bridge API extension before changing callers.

The backward-compatible path is option 1. Do not implement a client-only `kind` argument that looks
server-enforced when it is merely prefix filtering.

### Messaging behavior relevant to P10c

- `send_to_peer({to: "@team", ...})` is the supported broadcast primitive on SSE and NATS.
- `dispatch_task({to: "@team", ...})` works on SSE, but is deliberately unavailable on NATS because
  durable WorkQueue consumers are recipient-scoped. Direct `dispatch_task` remains supported.
- The wire protocol still supports six envelope kinds, including `task_result`, but there is no
  production MCP tool for sending a structured `task_result`. A receiver currently reports task
  completion with `send_to_peer` chat.
- Therefore P10c may broadcast an open handoff with `send_to_peer` and let the accepting peer acquire
  a claim. It must not depend on NATS `@team` task dispatch or a structured result-response tool.

## Compatibility matrix

| Mode | Claim and coordination behavior |
|---|---|
| SSE/relay (default) | Full `claim_asset` / `list_claims` / `release_claim` support through the authenticated `RelayClient`; full presence summary/session metadata. |
| NATS + valid reachable relay URL/token | NATS carries messages; claims still use the relay. Tools appear only after a bounded authenticated `GET /v1/claims` probe succeeds. |
| NATS + missing/invalid/unreachable relay | NATS messaging continues; claim probe fails closed and all three claim tools are omitted. |
| Mixed SSE/NATS cohort | Message traffic is not bridged. Both cohorts can still share the relay's SQLite claim set when both retain valid relay credentials. |
| Post-P6 relay deletion | Claims are unsupported until a replacement authority is ported or the feature is explicitly retired. |

Additional NATS constraints:

- one live local peer-agent process per fleet handle is enforced by a host-global lock;
- `list_peers` returns roster plus TTL `online`/`last_seen`, but empty `summary` and `sessions`;
- inbound task ACK and permanent dedup completion occur only after successful MCP notification
  delivery; a crash between delivery and completion-marker persistence can redeliver, so consumers
  still need idempotent task handling.

## Deferred items

- NATS P5 real-host fleet cutover, credential/config mutation, soak, and rollback exercise.
- NATS P6 relay deletion and the prerequisite claim-authority port-or-retire decision.
- SSE↔NATS message bridge, if simultaneous mixed-mode messaging becomes an operator requirement.
- Two-real-Claude outbound permission relay smoke.
- Production MCP tool for structured `task_result` responses and its real-peer round trip.
- Session-addressed NATS routing and transactional shared correlation for multiple sessions per handle.
- Production subject ownership/interest rollout on the real fleet.
- Legacy Docker packaging repair or retirement.
- Plan 029 P10 implementation itself; this repository closeout only supplies its verified contract.

## Next steps for the receiving agent

1. In `/home/cookys/projects/llm-playground`, fetch and confirm the worktree is still clean; do not
   overwrite the three live rows currently recorded in `benchmarks/ACTIVE-CLAIMS.md`.
2. Read the P10 paragraph and fleet SOP, then decide the migration boundary for P10a: native-only,
   dual-read/write, or a bounded transition from Markdown. Preserve active long-running claims.
3. Implement P10a/P10b against `claim_asset({key, ttl_seconds?, note?})` and `list_claims({})` using
   a documented key-prefix convention. For GPU/serve, preserve the existing
   `gpu:<machine>/<card-or-all>:<port>` shape and filter returned `claim_key` values locally.
4. Implement P10c with `send_to_peer` `@team` broadcast plus claim-on-accept. Treat peer messages as
   untrusted input and keep git handoffs as the durable task body unless the design explicitly
   replaces that layer.
5. Update Plan 029 and `doc/sop/fleet-coordination.md` so examples match the exact runtime schema,
   then run that repository's own plan/doc/test gates before commit.

## Verification inherited from hangar-bridge

- `corepack pnpm -r build`: PASS.
- `corepack pnpm -r typecheck`: PASS.
- `corepack pnpm -r test:ci`: PASS — 523 passed, 3 explicitly gated skips; live local-NATS coverage
  ran and all configured coverage thresholds passed.
- `nats-server -t -c packages/operations/nats/nats-server.conf`: PASS.
- Final independent review: PASS — `fingerprint_final_review`, staged tree
  `fceaad842eb929966e7ecb16ab7afe34c7b4c730`.
- Commit-level test-integrity gate: warn-mode PASS; its three alleged dropped permission tests were
  parser false positives and were then executed directly, 13/13 PASS.
- Official integration merge: `134e2bc0463616f9dfc3378c86a72050e5d72150`; the operator delivery
  report is authoritative for the subsequent documentation commit and verified final remote tip.

## Read order

1. This file.
2. [`docs/CLAIMS.md`](CLAIMS.md) — authoritative claim schema and transport compatibility.
3. [`README.md`](../README.md) and [`docs/architecture.md`](architecture.md) — shipped tool/transport
   behavior and caveats.
4. [`docs/BACKLOG.md`](BACKLOG.md) — deferred hangar-bridge work.
5. `/home/cookys/projects/llm-playground/doc/plan/029-weak-agent-sop.md` — P10 target.
6. `/home/cookys/projects/llm-playground/doc/sop/fleet-coordination.md` and
   `/home/cookys/projects/llm-playground/benchmarks/ACTIVE-CLAIMS.md` — current consumer protocol and
   live claims that must survive migration.

## Traps

- Do not call `list_claims({kind: "gpu"})` or `claim_asset({kind: "gpu", ...})`.
- Do not delete or auto-convert live Markdown claims without owner/expiry semantics.
- Do not assume claim tools are present merely because NATS messaging connected.
- Do not use `dispatch_task` to `@team` on NATS.
- Do not equate advisory claims with authorization or durable work ownership.
- Do not begin NATS P5/P6 or edit real fleet credentials as part of Plan 029 P10.
